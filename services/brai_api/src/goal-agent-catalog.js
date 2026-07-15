import crypto from 'node:crypto';
import { goalAgentStableHash } from './goal-agent-context.js';
import { parseJsonArray, parseJsonObject } from './store-helpers.js';
import {
  effectiveAgentBuildId,
  workflowDefinitionVersion
} from '../../brai_goal_agents/src/versioning.mjs';

export function stableGoalAgentWorkflowId({
  environment, agentId, userId, subjectId, triggerKind, definitionVersion, revision
}) {
  const userKey = digest(userId, 16);
  const subjectKey = digest(String(subjectId), 16);
  const triggerKey = digest(String(triggerKind), 8);
  return `brai:${environment}:agent:${agentId}:v${definitionVersion}:${userKey}:${subjectKey}:${triggerKey}:${revision}`;
}

export function syncGoalAgentWorkflowDefinition(store, manifest, now) {
  const version = workflowDefinitionVersion(manifest);
  store.db.prepare(`
    INSERT INTO workflow_definitions (
      id, version, title, description, status, task_queue, steps_json, diagram_mermaid,
      input_schema_version, input_schema_json, output_schema_version, output_schema_json,
      process_json, created_at_utc, updated_at_utc
    ) SELECT id, ?, title, description, 'active', ?, steps_json, diagram_mermaid,
      ?, ?, ?, ?, process_json, ?, ? FROM workflow_definitions
    WHERE id = ? ORDER BY version DESC LIMIT 1 ON CONFLICT (id, version) DO NOTHING
  `).run(version, `${manifest.queue_base}-{environment}`, manifest.input_schema_version,
    JSON.stringify({ schema_version: '1', agent_id: manifest.id }), manifest.output_schema_version,
    JSON.stringify(manifest.output_schema), now, now, manifest.id);
  const row = store.db.prepare(`
    SELECT definition_contract_json, definition_contract_hash, frozen_at_utc,
      steps_json, diagram_mermaid, process_json
    FROM workflow_definitions WHERE id = ? AND version = ?
  `).get(manifest.id, version);
  if (!row) throw catalogError('goal_agent_definition_missing');
  const contract = definitionContract(manifest, version, row);
  const hash = goalAgentStableHash(contract);
  if (row.frozen_at_utc && !sameContract(row, hash)) {
    throw catalogError('goal_agent_definition_version_conflict');
  }
  if (!row.frozen_at_utc) store.db.prepare(`
    UPDATE workflow_definitions SET task_queue = ?, input_schema_version = ?, input_schema_json = ?,
      output_schema_version = ?, output_schema_json = ?, definition_contract_json = ?::jsonb,
      definition_contract_hash = ?, worker_deployment_name_base = ?, worker_build_id = ?,
      frozen_at_utc = ?, updated_at_utc = ? WHERE id = ? AND version = ? AND frozen_at_utc IS NULL
  `).run(`${manifest.queue_base}-{environment}`, manifest.input_schema_version,
    JSON.stringify({ schema_version: '1', agent_id: manifest.id }), manifest.output_schema_version,
    JSON.stringify(manifest.output_schema), JSON.stringify(contract), hash, manifest.queue_base,
    contract.worker_build_id, now, now, manifest.id, version);
  const frozen = store.db.prepare(`
    SELECT definition_contract_json, definition_contract_hash, frozen_at_utc
    FROM workflow_definitions WHERE id = ? AND version = ?
  `).get(manifest.id, version);
  if (!sameContract(frozen, hash)) throw catalogError('goal_agent_definition_version_conflict');
}

export function loadGoalAgentVersionedContract(store, agentId, version) {
  const row = store.db.prepare(`
    SELECT definition_contract_json, definition_contract_hash, frozen_at_utc
    FROM workflow_definitions WHERE id = ? AND version = ?
  `).get(agentId, version);
  if (!row?.frozen_at_utc) return null;
  const contract = parseJsonObject(row.definition_contract_json);
  return goalAgentStableHash(contract) === row.definition_contract_hash ? contract : null;
}

function definitionContract(manifest, version, workflow) {
  return {
    ...manifest,
    workflow_definition_version: version,
    worker_deployment_name_base: manifest.queue_base,
    worker_build_id: effectiveAgentBuildId(manifest),
    steps_json: parseJsonArray(workflow.steps_json),
    diagram_mermaid: workflow.diagram_mermaid,
    process_json: parseJsonObject(workflow.process_json)
  };
}

function sameContract(row, expectedHash) {
  if (!row?.frozen_at_utc || row.definition_contract_hash !== expectedHash) return false;
  return goalAgentStableHash(parseJsonObject(row.definition_contract_json)) === expectedHash;
}

function digest(value, length) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
}

function catalogError(code) {
  const error = new Error(code);
  error.code = code;
  error.status = 503;
  return error;
}
