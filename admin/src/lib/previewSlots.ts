import { readFile } from "node:fs/promises";

const SLOT_IDS = ["A", "B", "C", "D", "E"] as const;

export type PreviewReviewNote = {
  branch: string;
  commit: string;
  short_changes: string;
  detailed_changes: string;
  reason: string;
  testing: string;
  updated_at: string;
};

export type PreviewSlot = {
  slot: string;
  status: string;
  branch: string | null;
  commit: string | null;
  url: string | null;
  assigned_at: string | null;
  updated_at: string | null;
  apk_file: string | null;
  apk_version: string | null;
  apk_version_code: number | null;
  apk_preview_iteration: number | null;
  apk_build_kind: string | null;
  apk_updated_at: string | null;
  supabase_branch_name: string | null;
  supabase_branch_id: string | null;
  supabase_branch_status: string | null;
  review_note: PreviewReviewNote | null;
};

export type PreviewSlotsSummary = {
  slots: PreviewSlot[];
  queue: Array<{ branch: string; commit: string | null; queued_at: string | null; updated_at: string | null }>;
  error: string | null;
};

export async function readPreviewSlots(): Promise<PreviewSlotsSummary> {
  const registryPath = process.env.BRAI_PREVIEW_REGISTRY ?? "/srv/projects/brai-envs/preview-slots.json";
  try {
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as Record<string, unknown>;
    return {
      slots: SLOT_IDS.map((slot) => normalizeSlot(slot, registry[slot])),
      queue: Array.isArray(registry.queue) ? registry.queue.flatMap(normalizeQueueEntry) : [],
      error: null,
    };
  } catch (error) {
    return {
      slots: SLOT_IDS.map((slot) => normalizeSlot(slot, null)),
      queue: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeSlot(slot: string, value: unknown): PreviewSlot {
  const row = object(value);
  const note = object(row.review_note);
  return {
    slot,
    status: text(row.status) ?? "free",
    branch: text(row.branch),
    commit: text(row.commit),
    url: text(row.url),
    assigned_at: text(row.assigned_at),
    updated_at: text(row.updated_at),
    apk_file: text(row.apk_file),
    apk_version: text(row.apk_version),
    apk_version_code: integer(row.apk_version_code),
    apk_preview_iteration: integer(row.apk_preview_iteration),
    apk_build_kind: text(row.apk_build_kind),
    apk_updated_at: text(row.apk_updated_at),
    supabase_branch_name: text(row.supabase_branch_name),
    supabase_branch_id: text(row.supabase_branch_id),
    supabase_branch_status: text(row.supabase_branch_status),
    review_note: text(note.branch) && text(note.commit) ? {
      branch: text(note.branch)!,
      commit: text(note.commit)!,
      short_changes: text(note.short_changes) ?? "",
      detailed_changes: text(note.detailed_changes) ?? "",
      reason: text(note.reason) ?? "",
      testing: text(note.testing) ?? "",
      updated_at: text(note.updated_at) ?? "",
    } : null,
  };
}

function normalizeQueueEntry(value: unknown) {
  const row = object(value);
  const branch = text(row.branch);
  return branch ? [{ branch, commit: text(row.commit), queued_at: text(row.queued_at), updated_at: text(row.updated_at) }] : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}
