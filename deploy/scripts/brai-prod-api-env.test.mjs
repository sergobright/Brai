import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const helper = path.join(repoRoot, "deploy/ansible/files/brai-prod-api-env.sh");
const skipRuntime = typeof process.getuid === "function" && process.getuid() === 0;
const currentDsn = "postgres://postgres.brai-prod:old-secret@127.0.0.1:6543/postgres?sslmode=disable&options=-c%20search_path%3Dbrai_prod%2Cpublic";
const candidateOne = "postgres://brai_api.brai-prod:new-secret@127.0.0.1:6543/postgres?sslmode=disable&options=-c%20search_path%3Dbrai_prod%2Cpublic";
const candidateTwo = "postgres://brai_api.brai-prod:next-secret@127.0.0.1:6543/postgres?sslmode=disable&options=-c%20search_path%3Dbrai_prod%2Cpublic";
const candidateReorderedQuery = "postgres://brai_api.brai-prod:ordered-secret@127.0.0.1:6543/postgres?options=-c+search_path%3Dbrai_prod%2Cpublic&ssl%6Dode=disable";

test("production API env helper stages and rolls back byte-exactly without disclosing DSNs", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  const before = fixture.readTarget();

  const staged = fixture.run(candidateOne, "stage", "attempt-1");
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(JSON.parse(staged.stdout), { ok: true, action: "stage", attempt: "attempt-1" });
  assert.doesNotMatch(`${staged.stdout}${staged.stderr}`, /old-secret|new-secret/);
  assert.equal(fixture.mode(fixture.target), "640");
  assert.equal(fixture.readTarget(), before.replace(
    `BRAI_DATABASE_URL='${currentDsn}'`,
    `BRAI_DATABASE_URL='${candidateOne}'`,
  ));
  assert.equal(fixture.mode(path.join(fixture.state, "active")), "700");
  for (const name of ["attempt", "backup", "candidate"]) {
    assert.equal(fixture.mode(path.join(fixture.state, "active", name)), "600");
  }

  const repeated = fixture.run(candidateOne, "stage", "attempt-1");
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.doesNotMatch(`${repeated.stdout}${repeated.stderr}`, /old-secret|new-secret/);
  assert.notEqual(fixture.run(candidateTwo, "stage", "attempt-1").status, 0);
  assert.notEqual(fixture.run("", "commit", "other-attempt").status, 0);
  assert.equal(fixture.readTarget(), before.replace(
    `BRAI_DATABASE_URL='${currentDsn}'`,
    `BRAI_DATABASE_URL='${candidateOne}'`,
  ));

  const rolledBack = fixture.run("", "rollback", "attempt-1");
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.equal(fixture.readTarget(), before);
  assert.equal(fs.existsSync(path.join(fixture.state, "active")), false);
  assert.equal(fixture.run("", "rollback", "attempt-1").status, 0);
  assert.notEqual(fixture.run("", "commit", "attempt-1").status, 0);
});

test("production API env helper commits terminal state idempotently and rejects attempt reuse", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  assert.equal(fixture.run(candidateTwo, "stage", "attempt-2").status, 0);
  assert.equal(fixture.run("", "commit", "attempt-2").status, 0);
  assert.equal(fs.existsSync(path.join(fixture.state, "active")), false);
  assert.equal(fixture.run("", "commit", "attempt-2").status, 0);
  assert.notEqual(fixture.run("", "rollback", "attempt-2").status, 0);
  assert.notEqual(fixture.run(candidateTwo, "stage", "attempt-2").status, 0);
  assert.match(fixture.readTarget(), /brai_api\.brai-prod:next-secret/);
});

test("production API env helper allows credential rotation and query parameter reordering only", { skip: skipRuntime }, (context) => {
  const credentials = createFixture(context);
  assert.equal(credentials.run(candidateOne, "stage", "credential-rotation").status, 0);
  assert.match(credentials.readTarget(), /brai_api\.brai-prod:new-secret/);
  assert.equal(credentials.run("", "rollback", "credential-rotation").status, 0);

  const preservedFragment = createFixture(context, {
    target: `BRAI_DATABASE_URL='${currentDsn}#fixed-fragment'\n`,
  });
  assert.equal(preservedFragment.run(`${candidateOne}#fixed%2Dfragment`, "stage", "fragment-preserved").status, 0);
  assert.equal(preservedFragment.run("", "rollback", "fragment-preserved").status, 0);

  const preservedLowercaseFragmentEncoding = createFixture(context, {
    target: `BRAI_DATABASE_URL='${currentDsn}#fixed%2dfragment'\n`,
  });
  assert.equal(preservedLowercaseFragmentEncoding.run(`${candidateOne}#fixed-fragment`, "stage", "fragment-lowercase-encoding").status, 0);
  assert.equal(preservedLowercaseFragmentEncoding.run("", "rollback", "fragment-lowercase-encoding").status, 0);

  const changedFragment = createFixture(context, {
    target: `BRAI_DATABASE_URL='${currentDsn}#fixed-fragment'\n`,
  });
  assert.notEqual(changedFragment.run(`${candidateOne}#changed-fragment`, "stage", "fragment-changed").status, 0);

  const reordered = createFixture(context);
  assert.equal(reordered.run(candidateReorderedQuery, "stage", "query-reordered").status, 0);
  assert.ok(reordered.readTarget().includes(candidateReorderedQuery));
  assert.equal(reordered.run("", "rollback", "query-reordered").status, 0);
});

test("production API env helper fails closed on incomplete stage and resumes terminal cleanup", { skip: skipRuntime }, (context) => {
  const incomplete = createFixture(context);
  assert.equal(incomplete.run(candidateOne, "stage", "attempt-incomplete").status, 0);
  const incompleteActive = path.join(incomplete.state, "active");
  fs.copyFileSync(incomplete.target, path.join(incompleteActive, "target.new"));
  fs.chmodSync(path.join(incompleteActive, "target.new"), 0o640);
  fs.copyFileSync(path.join(incompleteActive, "backup"), incomplete.target);
  fs.chmodSync(incomplete.target, 0o640);
  assert.notEqual(incomplete.run("", "commit", "attempt-incomplete").status, 0);
  assert.equal(incomplete.run("", "rollback", "attempt-incomplete").status, 0);

  const committed = createFixture(context);
  assert.equal(committed.run(candidateOne, "stage", "attempt-commit-crash").status, 0);
  fs.writeFileSync(path.join(committed.state, "last"), "attempt-commit-crash\tcommitted\n", { mode: 0o600 });
  assert.equal(committed.run("", "commit", "attempt-commit-crash").status, 0);
  assert.equal(fs.existsSync(path.join(committed.state, "active")), false);
  assert.notEqual(committed.run("", "rollback", "attempt-commit-crash").status, 0);

  const rolledBack = createFixture(context);
  const before = rolledBack.readTarget();
  assert.equal(rolledBack.run(candidateOne, "stage", "attempt-rollback-crash").status, 0);
  const rollbackActive = path.join(rolledBack.state, "active");
  fs.copyFileSync(path.join(rollbackActive, "backup"), rolledBack.target);
  fs.chmodSync(rolledBack.target, 0o640);
  fs.writeFileSync(path.join(rolledBack.state, "last"), "attempt-rollback-crash\trolled-back\n", { mode: 0o600 });
  assert.equal(rolledBack.run("", "rollback", "attempt-rollback-crash").status, 0);
  assert.equal(rolledBack.readTarget(), before);
  assert.equal(fs.existsSync(rollbackActive), false);
  assert.notEqual(rolledBack.run("", "commit", "attempt-rollback-crash").status, 0);
});

test("production API env helper rejects unsafe candidates and cleans bounded stdin state", { skip: skipRuntime }, (context) => {
  const fixture = createFixture(context);
  const invalid = [
    ["wrong protocol", candidateOne.replace("postgres://", "mysql://")],
    ["protocol swap", candidateOne.replace("postgres://", "postgresql://")],
    ["empty password", candidateOne.replace(":new-secret@", ":@")],
    ["wrong role", candidateOne.replace("brai_api.brai-prod", "postgres.brai-prod")],
    ["legacy tenant", candidateOne.replace("127.0.0.1", "brightos.invalid")],
    ["wrong host", candidateOne.replace("127.0.0.1", "127.0.0.2")],
    ["wrong port", candidateOne.replace(":6543/", ":6544/")],
    ["wrong database", candidateOne.replace("/postgres?", "/other?")],
    ["added fragment", `${candidateOne}#added-fragment`],
    ["malformed fragment encoding", `${candidateOne}#broken%ZZ`],
    ["wrong search_path", candidateOne.replace("brai_prod%2Cpublic", "other%2Cpublic")],
    ["missing search_path", candidateOne.replace("&options=-c%20search_path%3Dbrai_prod%2Cpublic", "")],
    ["multiple search_path", `${candidateOne}&search_path=brai_prod,public`],
    ["added query parameter", `${candidateOne}&application_name=brai-api`],
    ["removed sslmode", candidateOne.replace("sslmode=disable&", "")],
    ["changed sslmode", candidateOne.replace("sslmode=disable", "sslmode=require")],
    ["repeated sslmode", `${candidateOne}&sslmode=disable`],
    ["removed options", candidateOne.replace("&options=-c%20search_path%3Dbrai_prod%2Cpublic", "")],
    ["changed options", candidateOne.replace(
      "options=-c%20search_path%3Dbrai_prod%2Cpublic",
      "options=-c%20search_path%3Dbrai_prod%2Cpublic%20-c%20statement_timeout%3D5s",
    )],
    ["repeated options", `${candidateOne}&options=-c%20search_path%3Dbrai_prod%2Cpublic`],
    ["multiline", `${candidateOne}\n${candidateOne}`],
  ];
  for (const [label, candidate] of invalid) {
    const result = fixture.run(candidate, "stage", `invalid-${label.replaceAll(" ", "-")}`);
    assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /new-secret|old-secret/);
    assert.equal(fs.existsSync(path.join(fixture.state, ".incoming")), false);
    assert.equal(fs.existsSync(path.join(fixture.state, "pending")), false);
  }

  const oversized = fixture.run("x".repeat(16385), "stage", "oversized");
  assert.notEqual(oversized.status, 0);
  assert.equal(fs.existsSync(path.join(fixture.state, ".incoming")), false);
  assert.equal(fs.existsSync(path.join(fixture.state, "pending")), false);

  const extraArg = fixture.runArgs(candidateOne, "stage", "attempt-argv", candidateOne);
  assert.equal(extraArg.status, 2);
  assert.doesNotMatch(`${extraArg.stdout}${extraArg.stderr}`, /new-secret/);
});

test("production API env helper refuses duplicate database keys and unsafe fixed metadata", { skip: skipRuntime }, (context) => {
  const duplicate = createFixture(context, {
    target: `A=1\nBRAI_DATABASE_URL='${currentDsn}'\nBRAI_DATABASE_URL='${currentDsn}'\nB=2\n`,
  });
  assert.notEqual(duplicate.run(candidateOne, "stage", "duplicate-key").status, 0);

  const unsafe = createFixture(context);
  fs.chmodSync(unsafe.target, 0o600);
  const rejected = unsafe.run(candidateOne, "stage", "unsafe-mode");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unsafe metadata/);
});

function createFixture(context, {
  target = `# preserved before\nBRAI_DATABASE_URL='${currentDsn}'\nOTHER_VALUE='unchanged'\n# preserved after\n`,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "brai-prod-api-env-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const etcBrai = path.join(root, "etc/brai");
  const state = path.join(etcBrai, ".brai-prod-api-env");
  const targetPath = path.join(etcBrai, "brai-api.env");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.chmodSync(state, 0o700);
  fs.writeFileSync(path.join(state, "lock"), "", { mode: 0o600 });
  fs.writeFileSync(targetPath, target, { mode: 0o640 });
  fs.chmodSync(targetPath, 0o640);
  const env = {
    ...process.env,
    BRAI_PROD_API_ENV_TEST_MODE: "1",
    BRAI_PROD_API_ENV_TEST_ROOT: root,
    BRAI_PROD_API_ENV_TEST_NODE_BIN: process.execPath,
  };
  return {
    root,
    state,
    target: targetPath,
    run: (input, ...args) => spawnSync("bash", [helper, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      input,
    }),
    runArgs: (input, ...args) => spawnSync("bash", [helper, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      input,
    }),
    readTarget: () => fs.readFileSync(targetPath, "utf8"),
    mode: (file) => (fs.statSync(file).mode & 0o777).toString(8),
  };
}
