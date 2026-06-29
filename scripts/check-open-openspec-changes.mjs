#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const checkedTask = /^\s*[-*]\s+\[[xX]\]\s+/;
const openTask = /^\s*[-*]\s+\[\s\]\s+/;
const archiveOnlyTask = /^\s*[-*]\s+\[\s\]\s+.*\barchive\b/i;

if (isMainModule()) {
  const completedActiveChanges = completedActiveOpenSpecChanges(join(process.cwd(), "openspec", "changes"));

  if (completedActiveChanges.length > 0) {
    console.error(
      [
        "Completed OpenSpec changes are still active:",
        ...completedActiveChanges.map((change) => `- ${change}`),
        "",
        "Archive them or leave an explicit unchecked non-archive implementation/spec task before running OpenSpec validation.",
      ].join("\n"),
    );
    process.exit(1);
  }
}

export function completedActiveOpenSpecChanges(changesDir) {
  if (!existsSync(changesDir)) return [];

  const completedActiveChanges = [];
  for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "archive") {
      continue;
    }

    const tasksPath = join(changesDir, entry.name, "tasks.md");
    if (!existsSync(tasksPath)) {
      continue;
    }

    const taskLines = readFileSync(tasksPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => checkedTask.test(line) || openTask.test(line));
    const openTasks = taskLines.filter((line) => openTask.test(line));

    if (taskLines.length > 0 && (openTasks.length === 0 || openTasks.every((line) => archiveOnlyTask.test(line)))) {
      completedActiveChanges.push(entry.name);
    }
  }
  return completedActiveChanges;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
