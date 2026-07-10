import { proxyActivities, workflowInfo } from '@temporalio/workflow';

const activities = proxyActivities({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 1 }
});

export async function InboxNormalizationWorkflow(input) {
  const info = workflowInfo();
  const context = {
    ...input,
    workflowId: info.workflowId,
    runId: info.runId
  };
  try {
    return await runInboxNormalization(context);
  } catch (error) {
    await activities.failInboxNormalization({
      ...context,
      reason: activityError(error)
    });
    return { ok: false, reason: 'workflow_activity_failed' };
  }
}

async function runInboxNormalization(context) {
  const prepared = await activities.prepareInboxNormalization(context);
  if (prepared.skipped) {
    if (prepared.reason !== 'already_normalized') {
      await activities.failInboxNormalization({ ...context, reason: prepared.reason });
    }
    return prepared;
  }

  let imageDescription = '';
  if (prepared.imageRequired) {
    const image = await activities.describeInboxImages(context);
    if (!image.ok) {
      await activities.failInboxNormalization({ ...context, reason: image.error, step: 'image_describer' });
      return { ok: false, reason: 'image_description_failed' };
    }
    imageDescription = image.imageDescription;
  }

  let validationError = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await activities.normalizeInboxRaw({
      ...context,
      attempt,
      validationError,
      imageDescription
    });
    if (result.ok) {
      try {
        return await activities.applyNormalizedInbox({
          ...context,
          normalized: result.normalized,
          imageDescription
        });
      } catch (error) {
        await activities.failInboxNormalization({
          ...context,
          reason: activityError(error),
          step: 'apply_normalized_raw',
          attemptCount: attempt
        });
        return { ok: false, reason: 'apply_failed' };
      }
    }
    if (!result.validationFailed) {
      await activities.failInboxNormalization({
        ...context,
        reason: result.error,
        attemptCount: attempt
      });
      return { ok: false, reason: 'normalizer_failed' };
    }
    validationError = result.error;
  }

  await activities.failInboxNormalization({
    ...context,
    reason: validationError || 'normalizer_validation_failed',
    attemptCount: 3,
    needsReview: true
  });
  return { ok: false, reason: 'normalizer_validation_failed' };
}

function activityError(error) {
  return String(error?.cause?.message ?? error?.message ?? error ?? 'activity_failed').slice(0, 1000);
}
