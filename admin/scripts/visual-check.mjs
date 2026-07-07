import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const url = process.env.BRAI_ADMIN_VISUAL_URL ?? "http://127.0.0.1:3040/?table=activities&page=1";
const session = `brai-admin-visual-${process.pid}`;

function run(args) {
  return execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function evalJson(script) {
  return JSON.parse(
    execFileSync("agent-browser", ["--session", session, "--json", "eval", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ).data.result;
}

try {
  run(["open", url]);
  run(["wait", "--load", "networkidle"]);

  const metrics = evalJson(`(() => {
    const summaries = Array.from(document.querySelectorAll("details summary"));
    if (!summaries.length) throw new Error("No collapsed admin table cells found");
    const measure = (el) => {
      const style = getComputedStyle(el);
      return {
        clientHeight: el.clientHeight,
        display: style.display,
        lineHeight: Number.parseFloat(style.lineHeight),
        open: Boolean(el.closest("details")?.open),
        scrollHeight: el.scrollHeight,
        text: el.innerText.slice(0, 80),
        webkitLineClamp: style.webkitLineClamp,
      };
    };
    const closedSummaries = summaries.map(measure);
    const targetIndex = closedSummaries.reduce(
      (best, current, index) => current.scrollHeight > closedSummaries[best].scrollHeight ? index : best,
      0,
    );
    summaries[targetIndex].click();
    const opened = measure(summaries[targetIndex]);
    return { closedSummaries, opened, targetIndex };
  })()`);

  const tooTall = metrics.closedSummaries.find((summary) => summary.clientHeight > summary.lineHeight * 2 + 2);
  assert.equal(tooTall, undefined, `closed cell is taller than two lines: ${JSON.stringify(tooTall)}`);
  assert(metrics.closedSummaries.every((summary) => !summary.open), "cells start collapsed");
  assert(metrics.closedSummaries.every((summary) => summary.webkitLineClamp === "2"), "closed cells keep two-line clamp");

  const closed = metrics.closedSummaries[metrics.targetIndex];
  assert(metrics.opened.open, "click opens the cell");
  assert(
    metrics.opened.clientHeight > closed.clientHeight,
    "opened cell becomes taller than collapsed cell",
  );

  console.log("admin visual check passed", { checked: metrics.closedSummaries.length, closed, opened: metrics.opened });
} finally {
  try {
    run(["close"]);
  } catch {}
}
