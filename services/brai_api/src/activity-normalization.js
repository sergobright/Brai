import crypto from 'node:crypto';
import {
  DEFAULT_INBOX_CODEX_MODEL,
  normalizeJsonWithAgent
} from './inbox.js';
import {
  ACTIVITY_NORMALIZER_AGENT_ID,
  ACTIVITY_WORKFLOW_DEFINITION_VERSION
} from './store-activity-workflows.js';

const DEFAULT_ACTIVITY_NORMALIZER_PROMPT_TEMPLATE = [
  'Разбери Activity-запись на русском языке.',
  'Activity может быть пользовательским действием action или целью goal.',
  'Новые Operations принадлежат Inbox; Activity operation считай legacy read-only типом.',
  'Сохраняй исходное намерение, имена, названия и все важные ограничения.',
  'Исправляй очевидные опечатки, но не меняй смысл.',
  'Верни только JSON без Markdown с полями:',
  '{"title":"короткий заголовок до 80 символов","description":"понятное описание действия или цели","reason":"почему эта activity существует, если причина понятна, иначе пустая строка","normalization":"технический разбор"}',
  '',
  'Тип Activity:',
  '{{activity_type}}',
  '',
  'Заголовок:',
  '{{title}}',
  '',
  'Описание:',
  '{{description}}',
  '',
  'Описание вложений/изображений, если есть:',
  '{{image_description}}',
  '',
  'Автор:',
  '{{author}}',
  '',
  'Причина:',
  '{{reason}}',
  '',
  'Статус:',
  '{{status}}'
].join('\n');

export async function processActivityItem({
  store,
  activityId,
  codexBin,
  codexModel,
  codexFallbackModel,
  codexTimeoutMs,
  externalAi = {},
  normalizer,
  nowDate = new Date()
}) {
  if (!tryActivityLock(store, activityId)) return { skipped: true, reason: 'locked' };
  try {
    const execution = store.ensureActivityWorkflowExecution({ activityId, nowIso: nowDate.toISOString() });
    const workflowId = execution.workflow_id;
    const runId = execution.run_id ?? `inline:${crypto.randomUUID()}`;
    const prepared = prepareActivityNormalization({ store, activityId, workflowId, runId, nowDate });
    if (prepared.skipped) return prepared;

    let imageDescription = '';
    if (prepared.imageRequired) {
      const imageResult = await describeActivityImagesForWorkflow({
        store,
        activityId,
        workflowId,
        runId,
        nowDate
      });
      if (!imageResult.ok) {
        store.failActivityWorkflow({
          activityId,
          workflowId,
          runId,
          reason: imageResult.error,
          step: 'image_describer',
          nowIso: nowDate.toISOString()
        });
        return { ok: false, reason: 'image_description_failed' };
      }
      imageDescription = imageResult.imageDescription;
    }

    let validationError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await normalizeActivityRawForWorkflow({
        store,
        activityId,
        workflowId,
        runId,
        attempt,
        validationError,
        imageDescription,
        codexBin,
        codexModel: attempt > 1 && codexFallbackModel ? codexFallbackModel : codexModel,
        codexTimeoutMs,
        externalAi,
        normalizer,
        nowDate
      });
      if (result.ok) {
        try {
          return applyNormalizedActivityForWorkflow({
            store,
            activityId,
            workflowId,
            runId,
            normalized: result.normalized,
            imageDescription,
            nowDate
          });
        } catch (error) {
          store.failActivityWorkflow({
            activityId,
            workflowId,
            runId,
            reason: errorText(error),
            step: 'apply_normalized_raw',
            attemptCount: attempt,
            nowIso: nowDate.toISOString()
          });
          return { ok: false, reason: 'apply_failed' };
        }
      }
      if (!result.validationFailed) {
        store.failActivityWorkflow({
          activityId,
          workflowId,
          runId,
          reason: result.error,
          attemptCount: attempt,
          nowIso: nowDate.toISOString()
        });
        return { ok: false, reason: 'normalizer_failed' };
      }
      validationError = result.error;
    }

    store.failActivityWorkflow({
      activityId,
      workflowId,
      runId,
      reason: validationError || 'normalizer_validation_failed',
      needsReview: true,
      attemptCount: 3,
      nowIso: nowDate.toISOString()
    });
    return { ok: false, reason: 'normalizer_validation_failed' };
  } finally {
    unlockActivity(store, activityId);
  }
}

export function prepareActivityNormalization({ store, activityId, workflowId, runId, nowDate = new Date() }) {
  const item = store.getActivityItem(activityId);
  if (!item || item.item_roles_id) {
    return { skipped: true, reason: item?.item_roles_id ? 'already_normalized' : 'missing' };
  }
  const active = store.markActivityWorkflowStep({
    activityId,
    workflowId,
    runId,
    step: 'prepare_raw',
    nowIso: nowDate.toISOString()
  });
  if (!active) return { skipped: true, reason: 'workflow_not_active' };
  if (!rawActivityText(item)) {
    store.failActivityWorkflow({
      activityId,
      workflowId,
      runId,
      reason: 'raw_input_empty',
      step: 'prepare_raw',
      needsReview: true,
      nowIso: nowDate.toISOString()
    });
    return { skipped: true, reason: 'raw_input_empty' };
  }
  const imageRequired = activityImageRequired(item);
  store.recordActivityWorkflowStepFinished?.({
    activityId,
    workflowId,
    runId,
    stepKey: 'prepare_raw',
    status: 'completed',
    nowIso: nowDate.toISOString(),
    metadataJson: { image_required: imageRequired }
  });
  if (!imageRequired) {
    store.recordActivityWorkflowStepSkipped?.({
      activityId,
      workflowId,
      runId,
      stepKey: 'image_describer',
      reason: 'not_required',
      nowIso: nowDate.toISOString()
    });
  }
  return { ok: true, imageRequired };
}

export async function describeActivityImagesForWorkflow({
  store,
  activityId,
  workflowId,
  runId,
  nowDate = new Date()
}) {
  const item = store.getActivityItem(activityId);
  if (!item || !activityImageRequired(item)) return { ok: true, imageDescription: '' };
  const active = store.markActivityWorkflowStep({
    activityId,
    workflowId,
    runId,
    step: 'image_describer',
    attemptCount: 1,
    nowIso: nowDate.toISOString()
  });
  if (!active) return { ok: false, error: 'workflow_not_active' };
  const error = 'activity_image_describer_not_configured';
  store.recordActivityWorkflowStepFinished?.({
    activityId,
    workflowId,
    runId,
    stepKey: 'image_describer',
    status: 'failed',
    errorCode: error,
    errorSummary: error,
    nowIso: nowDate.toISOString()
  });
  return { ok: false, error };
}

export async function normalizeActivityRawForWorkflow({
  store,
  activityId,
  workflowId,
  runId,
  attempt,
  validationError = '',
  imageDescription = '',
  codexBin,
  codexModel,
  codexTimeoutMs,
  externalAi = {},
  normalizer,
  nowDate = new Date()
}) {
  const item = store.getActivityItem(activityId);
  if (!item || item.item_roles_id) {
    return { ok: false, validationFailed: false, error: item?.item_roles_id ? 'already_normalized' : 'raw_record_missing' };
  }
  const active = store.markActivityWorkflowStep({
    activityId,
    workflowId,
    runId,
    step: 'raw_normalizer',
    attemptCount: attempt,
    nowIso: nowDate.toISOString()
  });
  if (!active) return { ok: false, validationFailed: false, error: 'workflow_not_active' };
  const execution = store.getActivityWorkflowExecution(activityId);
  const workflowVersion = execution?.workflow_definition_version;
  const outputSchema = store.getActivityWorkflowOutputSchema(workflowVersion);
  if (!outputSchema) {
    return { ok: false, validationFailed: false, error: 'workflow_output_schema_missing' };
  }
  const agent = store.getAgent(ACTIVITY_NORMALIZER_AGENT_ID);
  const promptTemplate = renderActivityPrompt(
    agent?.llm_prompt_template || DEFAULT_ACTIVITY_NORMALIZER_PROMPT_TEMPLATE,
    item,
    imageDescription,
    validationError
  );
  const result = await normalizeJsonWithAgent({
    store,
    agent,
    codexBin,
    codexModel,
    codexTimeoutMs,
    providerFetch: externalAi?.fetch,
    normalizer,
    normalizerInput: { item, imageDescription, validationError },
    promptTemplate,
    outputSchema,
    strictOutputSchema: workflowVersion === ACTIVITY_WORKFLOW_DEFINITION_VERSION,
    cleanOutput: cleanActivityNormalization,
    defaultCodexModel: DEFAULT_INBOX_CODEX_MODEL,
    schemaName: 'activity_normalization',
    timeoutPrefix: 'activity'
  });
  const aiLogId = recordActivityNormalizerAiLog(store, {
    agent,
    dt: nowDate.toISOString(),
    status: result.status === 'done' ? 'done' : 'failed',
    activityId,
    item,
    imageDescription,
    output: result.status === 'done' ? result : result.output,
    error: result.error,
    model: result.model,
    mode: result.mode,
    provider: result.provider,
    durationMs: result.durationMs,
    workflowId,
    runId,
    attemptNumber: attempt
  });
  store.recordActivityWorkflowStepFinished?.({
    activityId,
    workflowId,
    runId,
    stepKey: 'raw_normalizer',
    attempt,
    status: result.status === 'done' ? 'completed' : 'failed',
    aiLogId,
    errorCode: result.error || null,
    errorSummary: result.error || null,
    nowIso: nowDate.toISOString(),
    metadataJson: {
      model: result.model,
      mode: result.mode,
      provider: result.provider,
      duration_ms: result.durationMs,
      validation_failed: result.validationFailed === true
    }
  });
  return result.status === 'done'
    ? { ok: true, normalized: result }
    : { ok: false, validationFailed: result.validationFailed === true, error: result.error };
}

export function applyNormalizedActivityForWorkflow({
  store,
  activityId,
  workflowId,
  runId,
  normalized,
  imageDescription = '',
  deferTerminal = false,
  nowDate = new Date()
}) {
  store.markActivityWorkflowStep({
    activityId,
    workflowId,
    runId,
    step: 'apply_normalized_raw',
    nowIso: nowDate.toISOString()
  });
  const result = store.applyNormalizedActivity({
    activityId,
    workflowId,
    runId,
    normalized,
    normalizationText: normalizeActivityBlocks({ imageDescription, analysis: normalized.normalization }),
    deferTerminal,
    nowIso: nowDate.toISOString()
  });
  store.recordActivityWorkflowStepFinished?.({
    activityId,
    workflowId,
    runId,
    stepKey: 'apply_normalized_raw',
    status: 'completed',
    nowIso: nowDate.toISOString(),
    metadataJson: {
      items_id: result.items_id,
      item_roles_id: result.item_roles_id,
      idempotent: result.idempotent === true
    }
  });
  if (!deferTerminal) {
    store.recordActivityWorkflowStepStarted?.({
      activityId,
      workflowId,
      runId,
      stepKey: 'terminal_reconcile',
      nowIso: nowDate.toISOString(),
      metadataJson: { inline: true }
    });
    store.recordActivityWorkflowStepFinished?.({
      activityId,
      workflowId,
      runId,
      stepKey: 'terminal_reconcile',
      status: 'skipped',
      errorCode: 'inline_execution',
      errorSummary: 'inline_execution',
      nowIso: nowDate.toISOString(),
      metadataJson: { inline: true }
    });
  }
  return result;
}

export function failActivityNormalization({ store, activityId, workflowId, runId, reason, step, needsReview, attemptCount, nowDate = new Date() }) {
  return store.failActivityWorkflow({
    activityId,
    workflowId,
    runId,
    reason,
    step,
    needsReview,
    attemptCount,
    nowIso: nowDate.toISOString()
  });
}

function renderActivityPrompt(template, item, imageDescription = '', validationError = '') {
  const prompt = template
    .replaceAll('{{activity_type}}', item.activity_type_id || 'action')
    .replaceAll('{{title}}', item.title || '')
    .replaceAll('{{description}}', item.description_md || '')
    .replaceAll('{{image_description}}', imageDescription || '')
    .replaceAll('{{author}}', item.author || '')
    .replaceAll('{{reason}}', item.reason || '')
    .replaceAll('{{status}}', item.status || '')
    .replaceAll('{{validation_error}}', validationError || '');
  return validationError
    ? `${prompt}\n\nОшибка валидации предыдущего ответа:\n${validationError}\nИсправь JSON и верни только валидный объект.`
    : prompt;
}

function cleanActivityNormalization(value) {
  const normalized = {
    title: cleanNormalizedTitle(value?.title),
    description: cleanText(value?.description),
    reason: cleanText(value?.reason),
    normalization: cleanText(value?.normalization)
  };
  if (!normalized.title || !normalized.description || !normalized.normalization) {
    throw new Error('invalid_normalizer_output');
  }
  return normalized;
}

function rawActivityText(item) {
  return [item?.title, item?.description_md, item?.reason].some((value) => cleanText(value));
}

function recordActivityNormalizerAiLog(store, {
  agent, dt, status, activityId, item, imageDescription, output, error, model, durationMs,
  mode, provider, workflowId, runId, attemptNumber
}) {
  return store.recordAiLog({
    agentId: ACTIVITY_NORMALIZER_AGENT_ID,
    agentVersion: agent?.version ?? '',
    dt,
    status,
    aiTitle: status === 'done' ? 'Разобрал Activity-запись' : 'Не разобрал Activity-запись',
    flowId: activityId,
    flowCommand: 'normalize',
    workflowId,
    runId,
    attemptNumber,
    jsonData: {
      schema: 'brai.ai_log.v1',
      inputs: [
        { ref: 'activities.id', value: activityId },
        { ref: 'activities.activity_type_id', value: item.activity_type_id || 'action' },
        { ref: 'activities.title', value: item.title || '' },
        { ref: 'activities.description_md', value: item.description_md || '' },
        { ref: 'activity.normalization_text.image_description', value: imageDescription || '' },
        { ref: 'activities.author', value: item.author || '' },
        { ref: 'activities.reason', value: item.reason || '' },
        { ref: 'activities.status', value: item.status || '' }
      ],
      outputs: [
        { ref: 'activities.title', value: output?.title || '' },
        { ref: 'activities.description_md', value: output?.description || '' },
        { ref: 'activities.reason', value: output?.reason || '' },
        { ref: 'activity.normalization_text', value: output?.normalization || '' }
      ],
      usage: usageBlock(model),
      timings_ms: timingsBlock(durationMs),
      metadata: {
        mode,
        provider,
        error: error || null
      }
    }
  });
}

function activityImageRequired(item) {
  return Array.isArray(item?.attachment_links) && item.attachment_links.length > 0;
}

function normalizeActivityBlocks({ imageDescription, analysis }) {
  return [
    imageDescription ? `## Описание картинки\n\n${imageDescription}` : '',
    analysis
  ].filter(Boolean).join('\n\n').trim();
}

function cleanNormalizedTitle(value) {
  const title = cleanTitle(value);
  const guillemets = title.match(/[«»]/g)?.length ?? 0;
  return guillemets % 2 === 0 ? title : title.replace(/[«»]/g, '');
}

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'«“”]+|["'»“”]+$/g, '')
    .slice(0, 80)
    .trim() ?? '';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 8000) : '';
}

function usageBlock(model) {
  const clean = cleanText(model);
  return clean ? { model: clean } : {};
}

function timingsBlock(durationMs) {
  return Number.isFinite(durationMs) ? { total: Math.max(0, Math.round(durationMs)) } : {};
}

function errorText(error) {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function tryActivityLock(store, activityId) {
  try {
    const value = store.db
      .prepare('SELECT pg_try_advisory_lock(hashtext(?)) AS locked')
      .get(`activity:${activityId}`)?.locked;
    return value === true || value === 1;
  } catch {
    return true;
  }
}

function unlockActivity(store, activityId) {
  try {
    store.db
      .prepare('SELECT pg_advisory_unlock(hashtext(?))')
      .get(`activity:${activityId}`);
  } catch {
    // Some local adapters do not expose PostgreSQL advisory lock functions.
  }
}
