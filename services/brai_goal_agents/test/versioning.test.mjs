import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { loadManifest } from "../src/manifest.mjs";

test("effective build IDs bind manifest, runtime source, and dependency locks", async (t) => {
  const fixture = copiedRuntime();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const manifest = await loadManifest("goal.planner");
  const initialModule = await loadVersioning(fixture, "initial");
  const initial = initialModule.agentDeploymentVersion(manifest, "preview-a").buildId;
  assert.match(initial, /^goal-planner\.v1\.[0-9a-f]{12}$/);
  assert.ok(initial.length <= 64);
  assert.equal(
    initialModule.agentDeploymentVersion(manifest, "prod").buildId,
    initial
  );
  assert.equal(
    initialModule.effectiveAgentBuildId(Object.fromEntries(Object.entries(manifest).reverse())),
    initial
  );
  assert.notEqual(
    initialModule.effectiveAgentBuildId({ ...manifest, prompt: `${manifest.prompt} changed` }),
    initial
  );

  appendFileSync(join(fixture.goalSource, "runtime.mjs"), "\n// source change\n");
  const sourceModule = await loadVersioning(fixture, "source");
  const sourceChanged = sourceModule.effectiveAgentBuildId(manifest);
  assert.notEqual(sourceChanged, initial);

  appendFileSync(join(fixture.goalRoot, "package-lock.json"), "\n");
  const dependencyModule = await loadVersioning(fixture, "dependency");
  const dependencyChanged = dependencyModule.effectiveAgentBuildId(manifest);
  assert.notEqual(dependencyChanged, sourceChanged);

  appendFileSync(join(fixture.goalRoot, "package.json"), "\n");
  const packageModule = await loadVersioning(fixture, "package");
  const packageChanged = packageModule.effectiveAgentBuildId(manifest);
  assert.notEqual(packageChanged, dependencyChanged);

  const contextBeforePolicy = packageModule.contextDeploymentVersion("dev").buildId;
  appendFileSync(join(fixture.goalRoot, "runtime-policy.json"), "\n");
  const policyModule = await loadVersioning(fixture, "runtime-policy");
  assert.notEqual(policyModule.effectiveAgentBuildId(manifest), packageChanged);
  const context = policyModule.contextDeploymentVersion("dev").buildId;
  assert.notEqual(context, contextBeforePolicy);
  assert.match(context, /^relations-goals-context\.v1\.[0-9a-f]{12}$/);
  assert.ok(context.length <= 64);
  appendFileSync(join(fixture.apiSource, "context.js"), "\n// source change\n");
  const contextSourceModule = await loadVersioning(fixture, "context-source");
  const contextSourceChanged = contextSourceModule.contextDeploymentVersion("dev").buildId;
  assert.notEqual(contextSourceChanged, context);

  appendFileSync(join(fixture.apiRoot, "package-lock.json"), "\n");
  const contextDependencyModule = await loadVersioning(fixture, "context-dependency");
  const contextDependencyChanged = contextDependencyModule.contextDeploymentVersion("dev").buildId;
  assert.notEqual(contextDependencyChanged, contextSourceChanged);

  appendFileSync(join(fixture.apiRoot, "package.json"), "\n");
  const contextPackageModule = await loadVersioning(fixture, "context-package");
  assert.notEqual(contextPackageModule.contextDeploymentVersion("dev").buildId, contextDependencyChanged);
});

function copiedRuntime() {
  const root = mkdtempSync(join(tmpdir(), "brai-build-id-"));
  const goalRoot = join(root, "services/brai_goal_agents");
  const goalSource = join(goalRoot, "src");
  const apiRoot = join(root, "services/brai_api");
  const apiSource = join(apiRoot, "src");
  mkdirSync(goalSource, { recursive: true });
  mkdirSync(apiSource, { recursive: true });
  copyFileSync(new URL("../src/versioning.mjs", import.meta.url), join(goalSource, "versioning.mjs"));
  copyFileSync(new URL("../src/manifest.mjs", import.meta.url), join(goalSource, "manifest.mjs"));
  cpSync(new URL("../manifests/", import.meta.url), join(goalRoot, "manifests"), { recursive: true });
  writeFileSync(join(goalSource, "runtime.mjs"), "export const runtime = true;\n");
  writeFileSync(join(goalRoot, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(goalRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  writeFileSync(join(goalRoot, "runtime-policy.json"), "{\"forbidden_environment_keys\":[]}\n");
  writeFileSync(join(apiSource, "context.js"), "export const context = true;\n");
  writeFileSync(join(apiRoot, "package.json"), "{\"type\":\"module\"}\n");
  writeFileSync(join(apiRoot, "package-lock.json"), "{\"lockfileVersion\":3}\n");
  return { root, goalRoot, goalSource, apiRoot, apiSource };
}

function loadVersioning(fixture, revision) {
  return import(`${pathToFileURL(join(fixture.goalSource, "versioning.mjs")).href}?${revision}`);
}
