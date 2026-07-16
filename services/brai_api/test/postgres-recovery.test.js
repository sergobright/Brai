import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRecoveringPostgresPool,
  isReadOnlyPostgresQuery,
  isRecoverablePostgresConnectionError
} from '../src/postgres-recovery.js';

test('recovering pool replaces a failed connection pool and retries connect once', async () => {
  const pools = [
    fakePool({ connectError: new Error('Connection terminated due to connection timeout') }),
    fakePool({ client: { id: 'fresh-client' } })
  ];
  const pool = createRecoveringPostgresPool({ max: 2 }, {
    createPool: () => pools.shift()
  });

  assert.deepEqual(await pool.connect(), { id: 'fresh-client' });
});

test('recovering pool retries read queries but never replays a mutation', async () => {
  const readPools = [
    fakePool({ queryError: new Error('Connection terminated unexpectedly') }),
    fakePool({ queryResult: { rows: [{ ok: 1 }] } })
  ];
  const readPool = createRecoveringPostgresPool({}, { createPool: () => readPools.shift() });
  assert.deepEqual(await readPool.query('SELECT 1 AS ok'), { rows: [{ ok: 1 }] });

  const mutationError = new Error('Connection terminated unexpectedly');
  const mutationPools = [
    fakePool({ queryError: mutationError }),
    fakePool({ queryResult: { rowCount: 1 } })
  ];
  const mutationPool = createRecoveringPostgresPool({}, { createPool: () => mutationPools.shift() });
  await assert.rejects(() => mutationPool.query('UPDATE app_settings SET value = $1', ['x']), mutationError);
});

test('postgres recovery classification is narrow and read-only detection is explicit', () => {
  assert.equal(isRecoverablePostgresConnectionError(new Error('Connection terminated unexpectedly')), true);
  assert.equal(isRecoverablePostgresConnectionError(new Error('duplicate key value')), false);
  assert.equal(isReadOnlyPostgresQuery(' SELECT 1'), true);
  assert.equal(isReadOnlyPostgresQuery({ text: 'SHOW search_path' }), true);
  assert.equal(isReadOnlyPostgresQuery('WITH changed AS (UPDATE x SET y = 1) SELECT * FROM changed'), false);
});

function fakePool({ client = null, connectError = null, queryError = null, queryResult = null }) {
  return {
    Client: class FakeClient {},
    options: {},
    async connect() {
      if (connectError) throw connectError;
      return client;
    },
    async query() {
      if (queryError) throw queryError;
      return queryResult;
    },
    async end() {}
  };
}
