import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: workerData.databaseUrl,
  ssl: workerData.ssl
});
const transactions = new Map();

parentPort.on('message', async (message) => {
  const signal = new Int32Array(message.signal);
  try {
    const result = await handle(message);
    fs.writeFileSync(message.resultPath, JSON.stringify({ ok: true, result }));
  } catch (error) {
    fs.writeFileSync(
      message.resultPath,
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : ''
      })
    );
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
  }
});

async function handle(message) {
  if (message.action === 'begin') {
    const client = await pool.connect();
    await client.query('BEGIN');
    const txId = `${process.pid}:${Date.now()}:${Math.random()}`;
    transactions.set(txId, client);
    return { txId };
  }

  if (message.action === 'commit' || message.action === 'rollback') {
    const client = requiredTransaction(message.txId);
    try {
      await client.query(message.action === 'commit' ? 'COMMIT' : 'ROLLBACK');
    } finally {
      transactions.delete(message.txId);
      client.release();
    }
    return {};
  }

  if (message.action === 'close') {
    for (const [txId, client] of transactions) {
      try {
        await client.query('ROLLBACK');
      } finally {
        transactions.delete(txId);
        client.release();
      }
    }
    await pool.end();
    return {};
  }

  const executor = message.txId ? requiredTransaction(message.txId) : pool;
  const result = await executor.query(message.sql, message.params ?? []);
  return {
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? 0
  };
}

function requiredTransaction(txId) {
  const client = transactions.get(txId);
  if (!client) throw new Error(`unknown Postgres transaction: ${txId}`);
  return client;
}
