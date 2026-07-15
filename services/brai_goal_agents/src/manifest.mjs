import { readFile } from "node:fs/promises";

export const AGENT_IDS = Object.freeze([
  "activity.classifier",
  "goal.item-matcher",
  "goal.member-finder",
  "goal.discovery",
  "goal.planner"
]);

const MANIFEST_URLS = new Map(AGENT_IDS.map((id) => [id, new URL(`../manifests/${id}.json`, import.meta.url)]));
const ENVIRONMENTS = new Set(["prod", "dev", "preview-a", "preview-b", "preview-c", "preview-d", "preview-e"]);

export async function loadManifest(id) {
  const url = MANIFEST_URLS.get(id);
  if (!url) throw new Error(`unknown_agent:${id}`);
  const manifest = JSON.parse(await readFile(url, "utf8"));
  validateManifest(manifest, id);
  return Object.freeze(manifest);
}

export function validateManifest(manifest, expectedId = manifest?.id) {
  if (!manifest || manifest.id !== expectedId || !AGENT_IDS.includes(manifest.id)) throw new Error("invalid_manifest_id");
  requiredText(manifest.version, "version", 32);
  if (!Number.isInteger(manifest.workflow_definition_version)
    || String(manifest.workflow_definition_version) !== manifest.version) {
    throw new Error("invalid_workflow_definition_version");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(manifest.worker_build_id ?? "")) {
    throw new Error("invalid_worker_build_id");
  }
  requiredText(manifest.workflow_type, "workflow_type", 80);
  requiredText(manifest.queue_base, "queue_base", 80);
  requiredText(manifest.entrypoint, "entrypoint", 100);
  requiredText(manifest.input_schema_version, "input_schema_version", 80);
  requiredText(manifest.prompt_version, "prompt_version", 64);
  requiredText(manifest.output_schema_version, "output_schema_version", 80);
  requiredText(manifest.model_env, "model_env", 80);
  requiredText(manifest.default_model, "default_model", 80);
  requiredText(manifest.prompt, "prompt", 12_000);
  if (!/^BRAI_[A-Z0-9_]+_MODEL$/.test(manifest.model_env)) throw new Error("invalid_model_env");
  if (manifest.queue_base !== `brai-agent-${manifest.id.replaceAll(".", "-")}`) throw new Error("invalid_queue_base");
  if (manifest.retry?.schema_attempts !== 3) throw new Error("invalid_schema_attempts");
  if (!Number.isInteger(manifest.timeout_ms) || manifest.timeout_ms < 1_000 || manifest.timeout_ms > 120_000) {
    throw new Error("invalid_timeout_ms");
  }
  if (!manifest.output_schema || manifest.output_schema.type !== "object") throw new Error("invalid_output_schema");
  if (Buffer.byteLength(JSON.stringify(manifest.output_schema)) > 32_768) throw new Error("output_schema_too_large");
  if (!Array.isArray(manifest.decision_kinds) || manifest.decision_kinds.length === 0) throw new Error("decision_kinds_required");
  return manifest;
}

export function environmentName(value = process.env.BRAI_ENVIRONMENT) {
  const environment = String(value ?? "").trim().toLowerCase();
  if (!ENVIRONMENTS.has(environment)) throw new Error(`invalid_environment:${environment || "missing"}`);
  return environment;
}

export function taskQueueFor(
  manifest,
  environment = environmentName(),
  configuredQueue = process.env.BRAI_GOAL_AGENT_TASK_QUEUE
) {
  const queue = `${manifest.queue_base}-${environmentName(environment)}`;
  const configured = String(configuredQueue ?? "").trim();
  if (configured && configured !== queue) throw new Error(`task_queue_mismatch:${configured}:${queue}`);
  return queue;
}

export function modelFor(manifest, env = process.env) {
  const model = String(manifest.default_model ?? "").trim();
  if (!model || model.length > 80) throw new Error("invalid_model");
  for (const value of [env[manifest.model_env], env.BRAI_GOAL_AGENT_DEFAULT_MODEL]) {
    if (value === undefined || value === null) continue;
    const configured = String(value).trim();
    if (!configured || configured.length > 80) throw new Error("invalid_model");
    if (configured !== model) throw new Error("goal_agent_model_contract_mismatch");
  }
  return model;
}

export function serviceSlug(id) {
  if (!AGENT_IDS.includes(id)) throw new Error(`unknown_agent:${id}`);
  return id.replaceAll(".", "-");
}

function requiredText(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`invalid_${label}`);
}
