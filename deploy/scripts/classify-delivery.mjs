#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { classifyDelivery as classifyBrightDelivery } from "../../scripts/bright-task.mjs";

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const files = options.files.length > 0 ? options.files : changedFiles(options);
  const context = deliveryContext(options);
  const result = classifyDeployDelivery(files, context);
  writeOutputs(result, options.githubOutput);
}

export function classifyDeployDelivery(files, context = {}) {
  const result = classifyBrightDelivery(files, context);
  const isCodexPush = context.eventName === "push" && context.ref?.startsWith("refs/heads/codex/");
  return {
    delivery_class: result.deliveryClass,
    requires_preview: result.deliveryClass === "runtime-preview" && isCodexPush,
    requires_dev_deploy: false,
    auto_merge: result.deliveryClass === "infra-docs" && isCodexPush,
  };
}

function parseArgs(args) {
  const options = {
    baseRef: "",
    headRef: "HEAD",
    eventName: process.env.GITHUB_EVENT_NAME || "",
    ref: process.env.GITHUB_REF || "",
    sha: process.env.GITHUB_SHA || "",
    before: "",
    githubOutput: process.env.GITHUB_OUTPUT || "",
    files: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      index += 1;
      if (index >= args.length) throw new Error(`${arg} requires a value`);
      return args[index];
    };

    if (arg === "--base-ref") options.baseRef = value();
    else if (arg === "--head-ref") options.headRef = value();
    else if (arg === "--event-name") options.eventName = value();
    else if (arg === "--ref") options.ref = value();
    else if (arg === "--sha") options.sha = value();
    else if (arg === "--before") options.before = value();
    else if (arg === "--github-output") options.githubOutput = value();
    else if (arg === "--file") options.files.push(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (process.env.BRIGHT_OS_CHANGED_FILES) {
    options.files.push(...process.env.BRIGHT_OS_CHANGED_FILES.split(/\r?\n/).filter(Boolean));
  }

  return options;
}

function deliveryContext(options) {
  const event = readGitHubEvent();
  return {
    eventName: options.eventName || event?.eventName || "",
    ref: options.ref || process.env.GITHUB_REF || "",
    sha: options.sha || process.env.GITHUB_SHA || "",
    before: options.before || event?.before || "",
  };
}

function readGitHubEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) return null;
  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
}

function changedFiles(options) {
  if (options.baseRef) return gitDiffNames(`${options.baseRef}...${options.headRef}`);

  const context = deliveryContext(options);
  if (context.eventName === "push" && context.ref.startsWith("refs/heads/codex/") && refExists(acceptedBaseRef())) {
    return gitDiffNames(`${acceptedBaseRef()}...${options.headRef}`);
  }

  if (context.eventName === "push" && context.before && !/^0+$/.test(context.before)) {
    return gitDiffNames(`${context.before}..${context.sha || options.headRef}`);
  }

  return git(["diff-tree", "--no-commit-id", "--name-only", "-r", context.sha || options.headRef]);
}

function acceptedBaseRef() {
  return `origin/${process.env.BRIGHT_OS_ACCEPT_BASE || "main"}`;
}

function gitDiffNames(range) {
  return git(["diff", "--name-only", range]);
}

function refExists(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", ref], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeOutputs(result, githubOutput) {
  const lines = Object.entries(result).map(([key, value]) => `${key}=${String(value)}`);
  console.log(lines.join("\n"));
  if (githubOutput) fs.appendFileSync(githubOutput, `${lines.join("\n")}\n`);
}
