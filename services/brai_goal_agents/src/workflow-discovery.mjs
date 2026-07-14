import { MAX_AGENT_INPUT_BYTES } from "./contracts.mjs";

const MERGE_BATCH_BYTES = 20_000;
const COMPARISON_CELL_TOO_LARGE = "discovery_comparison_cell_too_large";

export async function compareDiscoveryAgainstGoals({
  decisions, goals, buildInput, call, results
}) {
  let current = decisions;
  let remainingGoals = goals;
  let compareEmptyPage = goals.length === 0;
  while (current.length > 0 && (remainingGoals.length > 0 || compareEmptyPage)) {
    const candidates = current.map((original) => ({ original, summary: discoverySummary(original) }));
    const goalBatch = remainingGoals.length > 0
      ? fittingGoalPrefix(candidates.map((candidate) => candidate.summary), remainingGoals, buildInput)
      : [];
    compareEmptyPage = false;
    const candidateBatches = packComparisonCandidates(candidates, goalBatch, buildInput);
    const merged = [];
    for (let index = 0; index < candidateBatches.length; index += 1) {
      const batch = candidateBatches[index];
      const input = buildInput(batch.map((candidate) => candidate.summary), goalBatch, index, candidateBatches.length);
      assertComparisonInput(input);
      const result = await call(input);
      results.push(result);
      if (result.status !== "completed") return { failed: true, decisions: [] };
      merged.push(...selectOriginalSubset(batch, result.decisions));
    }
    current = merged;
    remainingGoals = remainingGoals.slice(goalBatch.length);
  }
  return { failed: false, decisions: current };
}

function fittingGoalPrefix(candidates, goals, buildInput) {
  let count = 0;
  for (let index = 0; index < goals.length; index += 1) {
    const candidateGoals = goals.slice(0, index + 1);
    if (!candidates.every((candidate) => fitsComparison(
      buildInput([candidate], candidateGoals, candidates.length - 1, candidates.length)
    ))) break;
    count += 1;
  }
  if (count === 0) throw comparisonError();
  return goals.slice(0, count);
}

function packComparisonCandidates(candidates, goals, buildInput) {
  const batches = [];
  let batch = [];
  for (const candidate of candidates) {
    const next = [...batch, candidate];
    if (!fitsComparison(buildInput(
      next.map((entry) => entry.summary), goals, candidates.length - 1, candidates.length
    ))) {
      if (batch.length === 0) throw comparisonError();
      batches.push(batch);
      batch = [candidate];
      if (!fitsComparison(buildInput(
        batch.map((entry) => entry.summary), goals, candidates.length - 1, candidates.length
      ))) {
        throw comparisonError();
      }
    } else {
      batch = next;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function selectOriginalSubset(candidates, outputs) {
  if (!Array.isArray(outputs)) throw comparisonError("discovery_comparison_mutated_candidate");
  const available = new Map();
  for (const candidate of candidates) {
    const key = coreKey(candidate.summary);
    const bucket = available.get(key) ?? [];
    bucket.push(candidate.original);
    available.set(key, bucket);
  }
  const selected = [];
  for (const output of outputs) {
    const bucket = available.get(coreKey(output));
    if (!bucket?.length) throw comparisonError("discovery_comparison_mutated_candidate");
    selected.push(bucket.shift());
  }
  return selected;
}

function coreKey(value) {
  return canonicalJson(discoverySummary(value));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertComparisonInput(input) {
  if (!fitsComparison(input)) throw comparisonError();
}

function fitsComparison(input) {
  return jsonBytes(input) <= MAX_AGENT_INPUT_BYTES;
}

function comparisonError(code = COMPARISON_CELL_TOO_LARGE) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function discoverySummary(decision) {
  return {
    decision_kind: decision.decision_kind,
    subject_items_id: decision.subject_items_id,
    confidence: decision.confidence,
    rationale: decision.rationale,
    proposal: decision.proposal
  };
}

export function discoverySourceSummary(item) {
  return {
    candidate_kind: "source_item",
    items_id: item.items_id,
    title: String(item.title ?? "").slice(0, 160),
    description_md: String(item.description_md ?? item.normalization ?? "").slice(0, 240)
  };
}

export function interleave(groups) {
  const result = [];
  const length = Math.max(0, ...groups.map((group) => group.length));
  for (let index = 0; index < length; index += 1) {
    for (const group of groups) if (group[index]) result.push(group[index]);
  }
  return result;
}

export function packMergeBatches(summaries) {
  if (summaries.length === 0) return [[]];
  const batches = [];
  let batch = [];
  for (const summary of summaries) {
    const candidate = [...batch, summary];
    if (jsonBytes(candidate) > MERGE_BATCH_BYTES) {
      if (batch.length === 0) throw new Error("discovery_summary_too_large");
      batches.push(batch);
      batch = [summary];
      if (jsonBytes(batch) > MERGE_BATCH_BYTES) throw new Error("discovery_summary_too_large");
    } else {
      batch = candidate;
    }
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function jsonBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
