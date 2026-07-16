import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const backup = path.join(root, "deploy/scripts/backup-postgres-to-telegram.sh");

for (const schemaExists of [false, true]) {
  test(`Production backup ${schemaExists ? "includes" : "omits"} brai_auth when the schema ${schemaExists ? "exists" : "is absent"}`, (context) => {
    const fixture = createFixture(context, { schemaExists });
    const result = fixture.run();
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = fixture.log();
    const preflight = commands.indexOf("docker psql");
    const dump = commands.indexOf("docker pg_dump");
    const restoreList = commands.indexOf("docker pg_restore --list");
    const encrypt = commands.indexOf("openssl encrypt");
    const upload = commands.indexOf("curl upload");
    assert.ok(preflight >= 0 && preflight < dump && dump < restoreList && restoreList < encrypt && encrypt < upload, commands);
    if (schemaExists) assert.match(commands, /docker pg_dump[^\n]*--schema=brai_auth/);
    else assert.doesNotMatch(commands, /docker pg_dump[^\n]*--schema=brai_auth/);
  });
}

test("Production backup stops before encryption and upload when archive verification fails", (context) => {
  const fixture = createFixture(context, { schemaExists: true, restoreListFails: true });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /backup archive verification failed/);
  const commands = fixture.log();
  assert.match(commands, /docker pg_restore --list/);
  assert.doesNotMatch(commands, /openssl encrypt|curl upload/);
});

function createFixture(context, { schemaExists, restoreListFails = false }) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "brai-backup-test-"));
  context.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const bin = path.join(fixture, "bin");
  const log = path.join(fixture, "commands.log");
  const key = path.join(fixture, "backup.key");
  fs.mkdirSync(bin);
  fs.writeFileSync(log, "");
  fs.writeFileSync(key, "fixture-key\n", { mode: 0o600 });

  writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == exec && "$3" == psql ]]; then
  printf 'docker psql\\n' >>"$BRAI_TEST_BACKUP_LOG"
  printf '%s\\n' "$BRAI_TEST_AUTH_SCHEMA_EXISTS"
elif [[ "$1" == exec && "$3" == pg_dump ]]; then
  printf 'docker pg_dump %s\\n' "$*" >>"$BRAI_TEST_BACKUP_LOG"
  printf 'fixture-custom-dump\\n'
elif [[ "$1" == exec && "$2" == -i && "$4" == pg_restore && "$5" == --list ]]; then
  printf 'docker pg_restore --list\\n' >>"$BRAI_TEST_BACKUP_LOG"
  input="$(/bin/cat)"
  [[ "$input" == fixture-custom-dump ]]
  [[ "$BRAI_TEST_RESTORE_LIST_FAILS" != true ]]
else
  printf 'unexpected docker command: %s\\n' "$*" >&2
  exit 2
fi
`);
  writeExecutable(path.join(bin, "openssl"), `#!/usr/bin/env bash
set -euo pipefail
input=''
output=''
while (( $# )); do
  case "$1" in
    -in) input="$2"; shift 2 ;;
    -out) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
printf 'openssl encrypt\\n' >>"$BRAI_TEST_BACKUP_LOG"
/bin/cp -- "$input" "$output"
`);
  writeExecutable(path.join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
/bin/cat >/dev/null
printf 'curl upload\\n' >>"$BRAI_TEST_BACKUP_LOG"
`);

  return {
    run: () => spawnSync("bash", [backup], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TELEGRAM_BOT_TOKEN: "fixture-token",
        TELEGRAM_CHAT_ID: "fixture-chat",
        BRAI_BACKUP_TMPDIR: fixture,
        BRAI_BACKUP_LOCK_FILE: path.join(fixture, "backup.lock"),
        BRAI_BACKUP_ENCRYPTION_KEY_FILE: key,
        BRAI_TEST_BACKUP_LOG: log,
        BRAI_TEST_AUTH_SCHEMA_EXISTS: schemaExists ? "1" : "0",
        BRAI_TEST_RESTORE_LIST_FAILS: restoreListFails ? "true" : "false",
      },
    }),
    log: () => fs.readFileSync(log, "utf8"),
  };
}

function writeExecutable(file, source) {
  fs.writeFileSync(file, source, { mode: 0o755 });
}
