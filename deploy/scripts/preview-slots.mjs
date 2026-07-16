import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
const envsRoot = process.env.BRAI_ENVS_ROOT ?? "/srv/projects/brai-envs";
const registryPath = process.env.BRAI_PREVIEW_REGISTRY ?? path.join(envsRoot, "preview-slots.json");
const environments = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8")).environments;
const slots = ["A", "B", "C", "D", "E"];
const readCommands = new Set(["status", "assert-owned"]);
const [command, ...args] = process.argv.slice(2);

try {
  const registry = readRegistry();
  const now = new Date().toISOString();
  let result;

  switch (command) {
    case "init":
      result = { ok: true, registry };
      break;
    case "allocate":
      result = allocate(registry, args[0], args[1], args[2], now);
      break;
    case "assert-owned":
      result = assertOwned(registry, args[0], args[1]);
      break;
    case "ready":
      result = updateOwnedSlot(registry, args[0], args[1], now, "ready");
      break;
    case "failed":
      result = updateOwnedSlot(registry, args[0], args[1], now, "failed");
      break;
    case "apk":
      result = updateOwnedApk(registry, args[0], args[1], args[2], args[3], args[4], args[5], args[6], now);
      break;
    case "clear-apk":
      result = clearOwnedApk(registry, args[0], args[1], now);
      break;
    case "supabase":
      result = updateOwnedSupabaseBranch(registry, args[0], args[1], {
        name: args[2] || null,
        id: args[3] || null,
        status: args[4] || null
      }, now);
      break;
    case "note":
      result = updateOwnedReviewNote(registry, args[0], args[1], args[2], now);
      break;
    case "next-apk-preview":
      result = nextApkPreview(registry, args[0], args[1], args[2], now);
      break;
    case "release":
      result = release(registry, args[0], now);
      break;
    case "dequeue":
      result = dequeue(registry, args[0]);
      break;
    case "status":
      result = { ok: true, registry };
      break;
    default:
      throw new Error("usage: preview-slots.sh init|status|allocate <branch> <commit> [generation]|assert-owned <branch> <commit>|ready <branch> <commit>|failed <branch> <commit>|note <branch> <commit> <base64-json>|apk <branch> <commit> <versionCode> <file> <version> [previewIteration] [buildKind]|clear-apk <branch> <commit>|supabase <branch> <commit> <name> [id] [status]|next-apk-preview <branch> <commit> <stableVersion>|release <branch-or-slot>|dequeue <branch>");
  }

  if (!readCommands.has(command)) {
    writeRegistry(registry);
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function allocate(registry, branch, commit, rawGeneration, now) {
  requireBranch(branch);
  const generation = optionalLeaseGeneration(rawGeneration);
  const existing = findByBranch(registry, branch);
  if (existing) {
    const recoveringFailed = existing.entry.status === "failed";
    assertLeaseAdvance(existing.entry, commit, generation);
    removeQueuedBranch(registry, branch);
    const previousStatus = existing.entry.status;
    const previousApkBuildKind = existing.entry.apk_build_kind ?? null;
    const commitChanged = Boolean(existing.entry.commit && commit && existing.entry.commit !== commit);
    Object.assign(existing.entry, {
      status: "deploying",
      commit: commit ?? null,
      lease_generation: generation ?? existing.entry.lease_generation,
      updated_at: now,
      ...(commitChanged ? { review_note: null } : {}),
    });
    return {
      ok: true,
      queued: false,
      allocatedNew: false,
      recoveringFailed,
      slot: existing.slot,
      previousStatus,
      previousApkBuildKind,
      entry: existing.entry,
    };
  }

  const slot = slots.find((candidate) => registry[candidate].status === "free");
  const queued = upsertQueuedBranch(registry, branch, commit, generation, now);
  if (!slot || registry.queue[0]?.branch !== branch) {
    return { ok: true, queued: true, position: queued.position, entry: queued.entry };
  }

  registry.queue.shift();
  const entry = registry[slot];
  Object.assign(entry, {
    status: "deploying",
    branch,
    commit: queued.entry.commit,
    lease_generation: queued.entry.lease_generation,
    assigned_at: now,
    updated_at: now,
  });
  return { ok: true, queued: false, allocatedNew: true, recoveringFailed: false, slot, entry };
}

function assertOwned(registry, branch, commit) {
  const existing = ownedCommit(registry, branch, commit);
  if (!["deploying", "ready"].includes(existing.entry.status)) {
    throw new Error(`preview slot lease for ${branch}@${commit} is ${existing.entry.status}, not deploying or ready`);
  }
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function updateOwnedReviewNote(registry, branch, commit, encoded, now) {
  requireBranch(branch);
  const existing = findByBranch(registry, branch);
  if (!existing) throw new Error(`branch has no preview slot: ${branch}`);
  if (!commit || existing.entry.commit !== commit || existing.entry.status !== "ready") {
    throw new Error(`preview note revision mismatch: ${branch}@${commit || "(missing)"}`);
  }
  let note;
  try {
    note = JSON.parse(Buffer.from(String(encoded ?? ""), "base64").toString("utf8"));
  } catch {
    throw new Error("preview note must be valid base64 JSON");
  }
  for (const field of ["short_changes", "detailed_changes", "reason", "testing"]) {
    if (!String(note?.[field] ?? "").trim()) throw new Error(`preview note ${field} is required`);
  }
  existing.entry.review_note = {
    branch,
    commit,
    short_changes: String(note.short_changes).trim(),
    detailed_changes: String(note.detailed_changes).trim(),
    reason: String(note.reason).trim(),
    testing: String(note.testing).trim(),
    updated_at: now,
  };
  existing.entry.updated_at = now;
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function updateOwnedSlot(registry, branch, commit, now, status) {
  const existing = ownedCommit(registry, branch, commit);
  if (status === "ready" && existing.entry.apk_build_kind === "preview" && existing.entry.apk_preview_iteration) {
    commitPreviewCounter(registry, branch, existing.entry.apk_version, existing.entry.apk_preview_iteration);
  }
  Object.assign(existing.entry, {
    status,
    updated_at: now,
  });
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function nextApkPreview(registry, branch, commit, stableVersion, now) {
  const existing = ownedCommit(registry, branch, commit);
  const version = positiveInteger(stableVersion, "stable APK version");
  const iteration = positiveInteger(committedPreviewCounter(registry, version, branch) + 1, "APK preview iteration");
  const versionCode = version * 10000 + iteration;
  Object.assign(existing.entry, {
    apk_version: String(version),
    apk_preview_iteration: iteration,
    apk_version_code: versionCode,
    apk_build_kind: "preview",
    apk_updated_at: now,
    updated_at: now,
  });
  return { ok: true, slot: existing.slot, version, previewIteration: iteration, versionCode, entry: existing.entry };
}

function updateOwnedApk(registry, branch, commit, versionCode, file, version, previewIteration, buildKind, now) {
  const existing = ownedCommit(registry, branch, commit);
  const numericVersionCode = positiveInteger(versionCode, "APK versionCode");
  const iteration = previewIteration ? positiveInteger(previewIteration, "APK preview iteration") : null;
  Object.assign(existing.entry, {
    apk_version_code: numericVersionCode,
    apk_file: file ?? null,
    apk_version: version ?? null,
    apk_preview_iteration: iteration,
    apk_build_kind: buildKind || (iteration ? "preview" : "stable"),
    apk_updated_at: now,
    updated_at: now,
  });
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function clearOwnedApk(registry, branch, commit, now) {
  const existing = ownedCommit(registry, branch, commit);
  Object.assign(existing.entry, {
    apk_version_code: null,
    apk_file: null,
    apk_version: null,
    apk_preview_iteration: null,
    apk_build_kind: "stable",
    apk_updated_at: null,
    updated_at: now,
  });
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function updateOwnedSupabaseBranch(registry, branch, commit, metadata, now) {
  const existing = ownedCommit(registry, branch, commit);
  Object.assign(existing.entry, {
    supabase_branch_name: metadata.name,
    supabase_branch_id: metadata.id,
    supabase_branch_status: metadata.status,
    updated_at: now,
  });
  return { ok: true, slot: existing.slot, entry: existing.entry };
}

function release(registry, branchOrSlot, now) {
  if (!branchOrSlot) throw new Error("release requires a branch or slot");
  const normalizedSlot = branchOrSlot.toUpperCase();
  const existing = slots.includes(normalizedSlot)
    ? { slot: normalizedSlot, entry: registry[normalizedSlot] }
    : findByBranch(registry, branchOrSlot);
  if (!existing) {
    const dequeued = !slots.includes(normalizedSlot) && removeQueuedBranch(registry, branchOrSlot);
    return { ok: true, released: false, dequeued };
  }
  const base = defaultSlot(existing.slot);
  Object.assign(existing.entry, base, {
    released_at: now,
    updated_at: now,
  });
  return { ok: true, released: true, slot: existing.slot, entry: existing.entry };
}

function dequeue(registry, branch) {
  requireBranch(branch);
  return { ok: true, dequeued: removeQueuedBranch(registry, branch) };
}

function findByBranch(registry, branch) {
  for (const slot of slots) {
    if (registry[slot].branch === branch) return { slot, entry: registry[slot] };
  }
  return null;
}

function ownedCommit(registry, branch, commit) {
  requireBranch(branch);
  if (!commit) throw new Error("commit is required");
  const existing = findByBranch(registry, branch);
  if (!existing) throw new Error(`branch has no preview slot: ${branch}`);
  if (existing.entry.commit !== commit) {
    throw new Error(`preview slot lease for ${branch} belongs to ${existing.entry.commit ?? "<none>"}, not ${commit}`);
  }
  return existing;
}

function readRegistry() {
  const initial = {
    ...Object.fromEntries(slots.map((slot) => [slot, defaultSlot(slot)])),
    queue: [],
    apk_preview_counter: 0,
    apk_preview_counters: {},
    apk_preview_branch_counters: {},
  };
  if (!fs.existsSync(registryPath)) return initial;
  const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  for (const slot of slots) {
    parsed[slot] = { ...defaultSlot(slot), ...(parsed[slot] ?? {}) };
    parsed[slot].lease_generation = normalizedLeaseGeneration(parsed[slot].lease_generation);
  }
  const registry = {
    ...Object.fromEntries(slots.map((slot) => [slot, parsed[slot]])),
    queue: normalizeQueue(parsed.queue),
    apk_preview_counter: Number.isInteger(Number(parsed.apk_preview_counter)) ? Number(parsed.apk_preview_counter) : 0,
    apk_preview_counters: normalizePreviewCounters(parsed.apk_preview_counters),
    apk_preview_branch_counters: normalizeBranchPreviewCounters(parsed.apk_preview_branch_counters),
  };
  for (const slot of slots) {
    const entry = registry[slot];
    if (entry?.status === "ready" && entry.branch && entry.apk_build_kind === "preview" && entry.apk_preview_iteration) {
      commitPreviewCounter(registry, entry.branch, entry.apk_version, entry.apk_preview_iteration);
    }
  }
  registry.apk_preview_counter = committedPreviewCounter(registry);
  return registry;
}

function committedPreviewCounter(registry, stableVersion = null, branch = null) {
  const versionKey = stableVersion == null ? null : String(stableVersion);
  let counter = branch && versionKey
    ? positivePreviewCounter(registry.apk_preview_branch_counters?.[versionKey]?.[branch])
    : versionKey
    ? positivePreviewCounter(registry.apk_preview_counters?.[versionKey])
    : positivePreviewCounter(registry.apk_preview_counter);
  for (const slot of slots) {
    const entry = registry[slot];
    if (
      entry?.status === "ready" &&
      entry.apk_build_kind === "preview" &&
      entry.apk_preview_iteration &&
      (!versionKey || String(entry.apk_version) === versionKey) &&
      (!branch || entry.branch === branch)
    ) {
      counter = Math.max(counter, positiveInteger(entry.apk_preview_iteration, "APK preview iteration"));
    }
  }
  return counter;
}

function commitPreviewCounter(registry, branch, stableVersion, previewIteration) {
  requireBranch(branch);
  const version = positiveInteger(stableVersion, "stable APK version");
  const iteration = positiveInteger(previewIteration, "APK preview iteration");
  registry.apk_preview_branch_counters ??= {};
  registry.apk_preview_branch_counters[String(version)] ??= {};
  registry.apk_preview_branch_counters[String(version)][branch] = Math.max(
    positivePreviewCounter(registry.apk_preview_branch_counters[String(version)][branch]),
    iteration,
  );
  registry.apk_preview_counters ??= {};
  registry.apk_preview_counters[String(version)] = Math.max(
    positivePreviewCounter(registry.apk_preview_counters[String(version)]),
    iteration,
  );
  registry.apk_preview_counter = Math.max(positivePreviewCounter(registry.apk_preview_counter), iteration);
}

function normalizePreviewCounters(value) {
  const counters = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return counters;
  for (const [key, raw] of Object.entries(value)) {
    const version = Number(key);
    const counter = Number(raw);
    if (Number.isInteger(version) && version > 0 && Number.isInteger(counter) && counter > 0) {
      counters[String(version)] = counter;
    }
  }
  return counters;
}

function normalizeBranchPreviewCounters(value) {
  const counters = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return counters;
  for (const [versionKey, rawBranches] of Object.entries(value)) {
    const version = Number(versionKey);
    if (!Number.isInteger(version) || version <= 0 || !rawBranches || typeof rawBranches !== "object" || Array.isArray(rawBranches)) {
      continue;
    }
    for (const [branch, rawCounter] of Object.entries(rawBranches)) {
      const counter = Number(rawCounter);
      if (branch && Number.isInteger(counter) && counter > 0) {
        counters[String(version)] ??= {};
        counters[String(version)][branch] = counter;
      }
    }
  }
  return counters;
}

function positivePreviewCounter(value) {
  const counter = Number(value);
  return Number.isInteger(counter) && counter > 0 ? counter : 0;
}

function writeRegistry(registry) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  chmodIfPossible(path.dirname(registryPath), 0o2775);
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`);
  chmodIfPossible(tmp, 0o664);
  fs.renameSync(tmp, registryPath);
  chmodIfPossible(registryPath, 0o664);
}

function defaultSlot(slot) {
  const env = environments[`preview-${slot.toLowerCase()}`];
  return {
    status: "free",
    branch: null,
    commit: null,
    lease_generation: null,
    url: `https://${env.domain}`,
    android_app: env.androidApp,
    display_label: slot,
    apk_version_code: null,
    apk_file: null,
    apk_version: null,
    apk_preview_iteration: null,
    apk_build_kind: "stable",
    apk_updated_at: null,
    supabase_branch_name: null,
    supabase_branch_id: null,
    supabase_branch_status: null,
    assigned_at: null,
    updated_at: null,
    review_note: null,
  };
}

function chmodIfPossible(target, mode) {
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Ownership is enforced by Ansible/main-sync/access-contract; local runs may not own these paths.
  }
}

function requireBranch(branch) {
  if (!branch) throw new Error("branch is required");
  if (!branch.startsWith("codex/")) throw new Error(`preview branches must start with codex/: ${branch}`);
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return number;
}

function upsertQueuedBranch(registry, branch, commit, generation, now) {
  const existing = registry.queue.find((entry) => entry.branch === branch);
  if (existing) {
    assertLeaseAdvance(existing, commit, generation);
    Object.assign(existing, {
      commit: commit ?? null,
      lease_generation: generation ?? existing.lease_generation,
      updated_at: now
    });
    return { entry: existing, position: registry.queue.indexOf(existing) + 1 };
  }
  const entry = { branch, commit: commit ?? null, lease_generation: generation, queued_at: now, updated_at: now };
  registry.queue.push(entry);
  return { entry, position: registry.queue.length };
}

function removeQueuedBranch(registry, branch) {
  const before = registry.queue.length;
  registry.queue = registry.queue.filter((entry) => entry.branch !== branch);
  return registry.queue.length !== before;
}

function normalizeQueue(queue) {
  if (!Array.isArray(queue)) return [];
  const seen = new Set();
  return queue
    .filter((entry) => entry && typeof entry.branch === "string" && entry.branch.startsWith("codex/"))
    .filter((entry) => {
      if (seen.has(entry.branch)) return false;
      seen.add(entry.branch);
      return true;
    })
    .map((entry) => ({
      branch: entry.branch,
      commit: entry.commit ?? null,
      lease_generation: normalizedLeaseGeneration(entry.lease_generation),
      queued_at: entry.queued_at ?? null,
      updated_at: entry.updated_at ?? entry.queued_at ?? null,
    }));
}

function assertLeaseAdvance(entry, commit, generation) {
  const current = normalizedLeaseGeneration(entry.lease_generation);
  if (current == null) return;
  if (generation == null) {
    if (entry.commit !== commit) throw new Error("a versioned preview lease can only be superseded by the official workflow generation");
    return;
  }
  if (generation < current) throw new Error(`stale preview lease generation ${generation}; current generation is ${current}`);
  if (generation === current && entry.commit !== commit) {
    throw new Error(`preview lease generation ${generation} already belongs to ${entry.commit ?? "<none>"}`);
  }
}

function optionalLeaseGeneration(value) {
  if (value == null || value === "") return null;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error(`invalid preview lease generation: ${value}`);
  return generation;
}

function normalizedLeaseGeneration(value) {
  return optionalLeaseGeneration(value);
}
