import { Pool } from 'pg';

const RECOVERABLE_CONNECTION_ERROR =
  /connection terminated|connection timeout|econnreset|epipe|socket closed|pool after calling end/i;

export function createRecoveringPostgresPool(options, {
  createPool = (poolOptions) => new Pool(poolOptions)
} = {}) {
  return new RecoveringPostgresPool(options, createPool);
}

export function isRecoverablePostgresConnectionError(error) {
  const message = [
    error instanceof Error ? error.message : String(error ?? ''),
    error?.cause instanceof Error ? error.cause.message : String(error?.cause ?? '')
  ].join(' ');
  return RECOVERABLE_CONNECTION_ERROR.test(message);
}

export function isReadOnlyPostgresQuery(query) {
  const text = typeof query === 'string' ? query : query?.text;
  return /^\s*(?:SELECT|SHOW|EXPLAIN)\b/i.test(String(text ?? ''));
}

class RecoveringPostgresPool {
  #closed = false;
  #createPool;
  #options;
  #pool;

  constructor(options, createPool) {
    this.#options = options;
    this.#createPool = createPool;
    this.#pool = createPool(options);
  }

  get Client() {
    return this.#pool.Client;
  }

  get options() {
    return this.#pool.options ?? this.#options;
  }

  async connect() {
    const activePool = this.#pool;
    try {
      return await activePool.connect();
    } catch (error) {
      if (!isRecoverablePostgresConnectionError(error)) throw error;
      this.#replace(activePool);
      return this.#pool.connect();
    }
  }

  async query(...args) {
    const activePool = this.#pool;
    try {
      return await activePool.query(...args);
    } catch (error) {
      if (!isRecoverablePostgresConnectionError(error)) throw error;
      this.#replace(activePool);
      if (!isReadOnlyPostgresQuery(args[0])) throw error;
      return this.#pool.query(...args);
    }
  }

  async end() {
    this.#closed = true;
    await this.#pool.end();
  }

  #replace(failedPool) {
    if (this.#closed || this.#pool !== failedPool) return;
    this.#pool = this.#createPool(this.#options);
    void Promise.resolve(failedPool.end()).catch(() => {});
  }
}
