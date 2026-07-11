import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresPoolMax, postgresTimeoutMs } from '../src/postgres-sync-db.js';

test('Postgres sync timeout refuses disabled or invalid values', () => {
  assert.equal(postgresTimeoutMs(undefined), 5000);
  assert.equal(postgresTimeoutMs('0'), 5000);
  assert.equal(postgresTimeoutMs('-1'), 5000);
  assert.equal(postgresTimeoutMs('nope'), 5000);
  assert.equal(postgresTimeoutMs('1200'), 1200);
});

test('Postgres pool max accepts only positive integers', () => {
  assert.equal(postgresPoolMax(undefined), 10);
  assert.equal(postgresPoolMax('0'), 10);
  assert.equal(postgresPoolMax('1.5'), 10);
  assert.equal(postgresPoolMax('2'), 2);
});
