import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentName } from "./manifest.mjs";

export const CONTEXT_WORKER_BUILD_ID = "relations-goals-context.v1";

const AGENT_SOURCE = new URL("./", import.meta.url);
const AGENT_MANIFESTS = new URL("../manifests/", import.meta.url);
const AGENT_PACKAGE = new URL("../package.json", import.meta.url);
const AGENT_LOCKFILE = new URL("../package-lock.json", import.meta.url);
const AGENT_RUNTIME_POLICY = new URL("../runtime-policy.json", import.meta.url);
const API_SOURCE = new URL("../../brai_api/src/", import.meta.url);
const API_PACKAGE = new URL("../../brai_api/package.json", import.meta.url);
const API_LOCKFILE = new URL("../../brai_api/package-lock.json", import.meta.url);
let agentRuntimeDigest;
let contextRuntimeDigest;

export function workflowDefinitionVersion(manifest) {
  const version = Number(manifest?.workflow_definition_version);
  if (!Number.isInteger(version) || version < 1 || String(version) !== manifest?.version) {
    throw new Error("invalid_workflow_definition_version");
  }
  return version;
}

export function agentDeploymentVersion(manifest, environment) {
  const resolvedEnvironment = environmentName(environment);
  return {
    deploymentName: `${manifest.queue_base}-${resolvedEnvironment}`,
    buildId: effectiveAgentBuildId(manifest)
  };
}

export function effectiveAgentBuildId(manifest) {
  workflowDefinitionVersion(manifest);
  return contentBoundBuildId(manifest?.worker_build_id, [
    ["agent-runtime", agentContentDigest()],
    ["manifest.json", canonicalJson(manifest)]
  ]);
}

export function contextDeploymentVersion(environment) {
  const resolvedEnvironment = environmentName(environment);
  return {
    deploymentName: `brai-api-context-${resolvedEnvironment}`,
    buildId: contentBoundBuildId(CONTEXT_WORKER_BUILD_ID, [[
      "context-runtime", contextRuntimeDigest ??= runtimeDigest([
        ["agent-runtime", agentContentDigest()],
        ...directoryContent(AGENT_MANIFESTS, "manifests"),
        ...directoryContent(API_SOURCE, "brai-api-src"),
        ["brai-api-package.json", readFileSync(API_PACKAGE)],
        ["brai-api-package-lock.json", readFileSync(API_LOCKFILE)]
      ])
    ]])
  };
}

export function pinnedVersioningOverride(manifest, environment, executionContract) {
  const version = agentDeploymentVersion(manifest, environment);
  if (executionContract?.workflow_definition_version !== workflowDefinitionVersion(manifest)
    || executionContract?.worker_build_id !== version.buildId
    || executionContract?.worker_deployment_name_base !== manifest.queue_base) {
    throw new Error("goal_agent_deployment_contract_mismatch");
  }
  return { pinnedTo: version };
}

function requiredBuildId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw new Error("invalid_worker_build_id");
  }
  return value;
}

function contentBoundBuildId(base, entries) {
  return requiredBuildId(`${requiredBuildId(base)}.${runtimeDigest(entries).slice(0, 12)}`);
}

function agentContentDigest() {
  return agentRuntimeDigest ??= runtimeDigest([
    ...directoryContent(AGENT_SOURCE, "src"),
    ["package.json", readFileSync(AGENT_PACKAGE)],
    ["package-lock.json", readFileSync(AGENT_LOCKFILE)],
    ["runtime-policy.json", readFileSync(AGENT_RUNTIME_POLICY)]
  ]);
}

function runtimeDigest(entries) {
  const hash = createHash("sha256");
  for (const [label, value] of entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    hash.update(`${Buffer.byteLength(label)}:${label}:${content.length}:`);
    hash.update(content);
  }
  return hash.digest("hex");
}

function directoryContent(url, prefix) {
  const root = fileURLToPath(url);
  const result = [];
  const visit = (directory, relative = "") => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = join(directory, entry.name);
      if (entry.isDirectory()) visit(child, childRelative);
      else if (entry.isFile()) result.push([`${prefix}/${childRelative}`, readFileSync(child)]);
    }
  };
  visit(root);
  return result;
}

function canonicalJson(value) {
  const sort = (current) => Array.isArray(current)
    ? current.map(sort)
    : current && typeof current === "object"
      ? Object.fromEntries(Object.keys(current).sort().map((key) => [key, sort(current[key])]))
      : current;
  return JSON.stringify(sort(value));
}
