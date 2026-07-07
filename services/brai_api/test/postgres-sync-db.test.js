import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresTimeoutMs } from '../src/postgres-sync-db.js';

test('Postgres sync timeout refuses disabled or invalid values', () => {
  assert.equal(postgresTimeoutMs(undefined), 5000);
  assert.equal(postgresTimeoutMs('0'), 5000);
  assert.equal(postgresTimeoutMs('-1'), 5000);
  assert.equal(postgresTimeoutMs('nope'), 5000);
  assert.equal(postgresTimeoutMs('1200'), 1200);
});
