import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { acceptedWorkReconciliations } from "./accepted-preview-branches.mjs";

process.env.BRAI_RELEASE_NOTES_V2_CUTOFF = "2026-07-15T00:00:00.000Z";

const workKey = "work_12345678-1234-4123-a123-123456789abc";

function receipt(role, title, { native = false } = {}) {
  const notes = {
    receiptType: "brai-release-notes-v2",
    work: { key: workKey, role },
    build: {
      ...(role === "owner" ? {
        short_changes: "Завершена нормализация истории версий.",
        detailed_changes: "История группирует изменения по устойчивой работе.",
        reason: "Нужно исключить потерю связанных изменений.",
      } : {}),
      details: [{ title, description: `${title} теперь сохраняется отдельной атомарной записью.` }],
    },
    testing: "Проверить итоговую историю версии и связанные PR.",
    ...(native ? { platforms: { apk: {
      short_changes: "Обновлена Android-сборка.",
      detailed_changes: "APK содержит изменённые нативные входы.",
      reason: "Нужно выпустить изменившийся Android-пакет.",
      details: [{ title: "Android-пакет", description: "Нативные входы включены в стабильный APK." }],
    } } } : {}),
  };
  const marker = { receiptType: "brai-work-v1", workKey, workRole: role, nativeBoundary: native };
  return `<!-- brai-work-v1\n${JSON.stringify(marker)}\n-->\n<!-- brai-release-notes-v2\n${JSON.stringify(notes)}\n-->`;
}

function pull(number, role, state, title, options = {}) {
  const merged = state === "MERGED";
  return {
    number,
    html_url: `https://github.example/pr/${number}`,
    title,
    body: receipt(role, title, options),
    user: { login: "mark" },
    state: merged ? "closed" : state.toLowerCase(),
    draft: state === "DRAFT",
    head: { ref: `codex/${role}-${number}`, sha: `${number}`.repeat(40).slice(0, 40) },
    base: { ref: "main" },
    created_at: "2026-07-15T01:00:00Z",
    updated_at: "2026-07-15T02:00:00Z",
    closed_at: merged ? `2026-07-15T0${number}:00:00Z` : null,
    merged_at: merged ? `2026-07-15T0${number}:00:00Z` : null,
    merge_commit_sha: merged ? `${number}`.repeat(40).slice(0, 40) : null,
  };
}

test("owner reconciliation includes merged support PRs in stable order", () => {
  const owner = pull(2, "owner", "MERGED", "Владелец работы");
  const support = pull(1, "support", "MERGED", "Поддерживающая миграция");
  const [entry] = acceptedWorkReconciliations([owner], [owner, support]);

  assert.deepEqual(entry.work, { key: workKey, role: "owner" });
  assert.deepEqual(entry.pulls.map((item) => [item.pullNumber, item.workRole]), [[1, "support"], [2, "owner"]]);
  assert.equal(entry.pulls[0].releaseNotes.build.short_changes, undefined);
  assert.equal(entry.pulls[1].releaseNotes.build.short_changes, "Завершена нормализация истории версий.");
});

test("support merge registers snapshots without waiting for the open owner", () => {
  const owner = pull(2, "owner", "OPEN", "Владелец работы");
  const support = pull(1, "support", "MERGED", "Поддерживающая миграция");
  const [entry] = acceptedWorkReconciliations([support], [owner, support]);
  assert.equal(entry.work.role, "support");
  assert.equal(entry.pulls.find((item) => item.pullNumber === 2).state, "OPEN");
});

test("owner finalization fails while a registered support PR is unresolved", () => {
  const owner = pull(2, "owner", "MERGED", "Владелец работы");
  const support = pull(1, "support", "OPEN", "Поддерживающая миграция");
  assert.throws(() => acceptedWorkReconciliations([owner], [owner, support]), /#1 \(OPEN\)/);
});

test("native marker requires an APK platform block", () => {
  const owner = pull(2, "owner", "MERGED", "Владелец работы");
  owner.body = owner.body.replace('"nativeBoundary":false', '"nativeBoundary":true');
  assert.throws(() => acceptedWorkReconciliations([owner], [owner]), /no platforms\.apk block/);
});

test("pre-cutoff v1 PR is reconciled through one synthetic owner work", () => {
  const legacy = {
    number: 7,
    html_url: "https://github.example/pr/7",
    title: "Старый PR",
    body: `<!-- brai-release-notes-v1\n${JSON.stringify({
      short_changes: "Исправлена старая доставка.",
      detailed_changes: "Старый PR преобразуется в одну атомарную деталь.",
      reason: "Нужно ограниченно сохранить совместимость старого PR.",
    })}\n-->`,
    user: { login: "mark" },
    state: "closed",
    head: { ref: "codex/legacy", sha: "7".repeat(40) },
    base: { ref: "main" },
    created_at: "2026-07-14T23:00:00Z",
    updated_at: "2026-07-15T01:00:00Z",
    closed_at: "2026-07-15T01:00:00Z",
    merged_at: "2026-07-15T01:00:00Z",
    merge_commit_sha: "8".repeat(40),
    nativeBoundary: false,
  };
  const [entry] = acceptedWorkReconciliations([legacy], [legacy]);
  assert.match(entry.work.key, /^work_[0-9a-f-]{36}$/);
  assert.equal(entry.work.role, "owner");
  assert.equal(entry.pulls[0].releaseNotes.build.details.length, 1);
});

test("pre-cutoff native v1 PR fails closed", () => {
  const legacy = {
    number: 8,
    html_url: "https://github.example/pr/8",
    title: "Старый native PR",
    body: `<!-- brai-release-notes-v1\n${JSON.stringify({
      short_changes: "Изменена Android-сборка.",
      detailed_changes: "Нативные входы требуют нового APK.",
      reason: "Нужно доставить Android-изменения.",
    })}\n-->`,
    user: { login: "mark" },
    state: "closed",
    head: { ref: "codex/legacy-native", sha: "8".repeat(40) },
    base: { ref: "main" },
    created_at: "2026-07-14T23:00:00Z",
    updated_at: "2026-07-15T01:00:00Z",
    closed_at: "2026-07-15T01:00:00Z",
    merged_at: "2026-07-15T01:00:00Z",
    merge_commit_sha: "9".repeat(40),
    nativeBoundary: true,
  };
  assert.throws(() => acceptedWorkReconciliations([legacy], [legacy]), /no brai-work-v1 marker/);
});

test("accepted promotion cannot create an unscoped build", () => {
  const source = fs.readFileSync(new URL("./promote-deployment.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /recordAcceptedBuildVersion/);
  assert.match(source, /accepted promotion requires --work-json; unscoped build creation is disabled/);
  assert.match(source, /target\.finalizeVersionWork/);
});

test("delivery records every PR lifecycle event and queues main promotions", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/brai-delivery.yml", import.meta.url), "utf8");
  for (const action of ["opened", "edited", "synchronize", "reopened", "converted_to_draft", "ready_for_review", "closed"]) {
    assert.match(workflow, new RegExp(`- ${action}\\b`));
  }
  assert.match(workflow, /record-version-pr:[\s\S]*ci-ssh-record-version-pr\.sh/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/heads\/codex\/'\) \}\}/);
});
