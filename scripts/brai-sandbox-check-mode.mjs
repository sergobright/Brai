#!/usr/bin/env node
import { pathToFileURL } from "node:url";

if (isMainModule()) {
  const command = commandAfterSeparator(process.argv.slice(2));
  if (command.length === 0) {
    console.error("usage: brai-sandbox-check-mode.mjs -- <command...>");
    process.exit(2);
  }

  const result = sandboxCheckMode(command, process.env);
  console.log(`mode=${result.mode}`);
  console.log(`reason=${result.reason}`);
}

export function sandboxCheckMode(command, env = process.env) {
  const text = command.join(" ").replace(/\s+/g, " ").trim();

  if (/\bagent-browser\b/.test(text)) {
    return {
      mode: "agent_browser",
      reason: "agent-browser owns a browser runtime; use its dedicated runtime/escalation path.",
    };
  }

  if (/\bplaywright\b.*\btest\b/.test(text) || /\bnpm run app:e2e\b/.test(text)) {
    return {
      mode: "require_escalated",
      reason: "Playwright starts a dev server and browser processes that need sandbox escape.",
    };
  }

  if (
    /\bgradlew?\b/.test(text) ||
    /\bandroid:(build:release|release|debug)\b/.test(text) ||
    /\bapp:cap:sync\b/.test(text) ||
    /\bbuild-android-env-apk\.sh\b/.test(text)
  ) {
    return {
      mode: "require_escalated",
      reason: "Android/Gradle/Capacitor writes build caches and may need the shared Android toolchain.",
    };
  }

  if (
    /\bnpm run app:(build|dev)\b/.test(text) ||
    /\bnpm --prefix apps\/brai_app run (build|dev)\b/.test(text) ||
    /\bnext (build|dev)\b/.test(text) ||
    /\bpublish-(client-web-layer|web|mobile-bundle|capacitor-apk)\.sh\b/.test(text) ||
    /\bnpm run publish:(client-web-layer|web|mobile-bundle|apk)\b/.test(text)
  ) {
    return {
      mode: "require_escalated",
      reason: "Next/Turbopack build/dev opens local workers or servers that fail in the Codex sandbox.",
    };
  }

  if (/\bnpm --prefix services\/brai_api (run )?test\b/.test(text)) {
    return {
      mode: "require_escalated",
      reason: "Brai API tests bind local 127.0.0.1 listeners during the suite.",
    };
  }

  if (/\bdeploy\/scripts\/classify-delivery\.mjs\b/.test(text)) {
    const explicitFiles = command.includes("--file") || Boolean(env.BRAI_CHANGED_FILES?.trim());
    return explicitFiles
      ? {
          mode: "sandbox",
          reason: "classify-delivery has explicit changed files and does not need Git metadata.",
        }
      : {
          mode: "require_escalated",
          reason: "classify-delivery without explicit files reads Git metadata that can hit sandbox EPERM.",
        };
  }

  return {
    mode: "sandbox",
    reason: "no known Brai sandbox escalation rule matches this command.",
  };
}

function commandAfterSeparator(args) {
  const separator = args.indexOf("--");
  return separator === -1 ? args : args.slice(separator + 1);
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
