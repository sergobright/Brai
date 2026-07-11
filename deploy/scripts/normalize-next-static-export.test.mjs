import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeNextStaticExport } from "./normalize-next-static-export.mjs";

test("normalizes static route html files into slash-safe index files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "brai-static-export-"));
  try {
    fs.writeFileSync(path.join(tmp, "index.html"), "home");
    fs.writeFileSync(path.join(tmp, "404.html"), "not found");
    fs.writeFileSync(path.join(tmp, "_not-found.html"), "next not found");
    fs.writeFileSync(path.join(tmp, "focus.html"), "focus");
    fs.writeFileSync(path.join(tmp, "factory.html"), "factory");
    fs.writeFileSync(path.join(tmp, "draws.html"), "draws");
    fs.mkdirSync(path.join(tmp, "focus"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "focus", "__next.focus.txt"), "rsc");
    fs.mkdirSync(path.join(tmp, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "docs", "page.html"), "docs page");

    assert.deepEqual(normalizeNextStaticExport(tmp), [
      "docs/page/index.html",
      "draws/index.html",
      "factory/index.html",
      "focus/index.html",
    ]);
    assert.equal(fs.readFileSync(path.join(tmp, "draws", "index.html"), "utf8"), "draws");
    assert.equal(fs.readFileSync(path.join(tmp, "factory", "index.html"), "utf8"), "factory");
    assert.equal(fs.readFileSync(path.join(tmp, "focus", "index.html"), "utf8"), "focus");
    assert.equal(fs.readFileSync(path.join(tmp, "docs", "page", "index.html"), "utf8"), "docs page");
    assert.equal(fs.existsSync(path.join(tmp, "index", "index.html")), false);
    assert.equal(fs.existsSync(path.join(tmp, "404", "index.html")), false);
    assert.equal(fs.existsSync(path.join(tmp, "_not-found", "index.html")), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
