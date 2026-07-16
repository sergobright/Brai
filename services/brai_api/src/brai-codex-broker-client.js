import { EventEmitter } from 'node:events';
import net from 'node:net';
import crypto from 'node:crypto';

const DEFAULT_SOCKET_PATH = '/run/brai-codex-broker/broker.sock';
const MAX_LINE_BYTES = 1024 * 1024;

export class BraiCodexBrokerError extends Error {
  constructor(code, message) {
    super(message || 'Codex broker request failed');
    this.name = 'BraiCodexBrokerError';
    this.code = code || 'BRAI_BROKER_ERROR';
  }
}

export class BraiCodexBrokerClient extends EventEmitter {
  constructor({ socketPath = DEFAULT_SOCKET_PATH, requestTimeoutMs = 15_000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
    this.pending = new Map();
    this.closed = false;
  }

  async request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(method)) {
      throw new BraiCodexBrokerError('BRAI_RPC_METHOD_INVALID', 'Invalid broker method');
    }
    const socket = await this.#connect();
    const id = crypto.randomUUID();
    const payload = `${JSON.stringify({ id, method, params })}\n`;

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BraiCodexBrokerError('BRAI_BROKER_TIMEOUT', 'Codex broker request timed out'));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      socket.write(payload, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(new BraiCodexBrokerError('BRAI_BROKER_UNAVAILABLE', error.message));
      });
    });
  }

  subscribe({ userId, threadId = null, turnId = null }, listener) {
    const handler = (notification) => {
      if (notification.userId && notification.userId !== userId) return;
      const params = notification.params || {};
      if (threadId && params.threadId && params.threadId !== threadId) return;
      if (turnId && params.turnId && params.turnId !== turnId && params.turn?.id !== turnId) return;
      listener(notification.method, params, {
        notificationSequence: Number.isSafeInteger(notification.notificationSequence)
          ? notification.notificationSequence : null,
        notificationEpoch: typeof notification.notificationEpoch === 'string'
          ? notification.notificationEpoch : null
      });
    };
    this.on('notification', handler);
    return () => this.off('notification', handler);
  }

  close() {
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.connecting = null;
    this.#rejectPending('BRAI_BROKER_CLOSED', 'Codex broker connection closed');
  }

  async #connect() {
    this.closed = false;
    if (this.socket && !this.socket.destroyed) return this.socket;
    if (this.connecting) return await this.connecting;

    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const fail = (error) => {
        socket.destroy();
        this.socket = null;
        reject(new BraiCodexBrokerError('BRAI_BROKER_UNAVAILABLE', error.message));
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        socket.on('error', (error) => this.#disconnect(error));
        socket.on('close', () => this.#disconnect());
        socket.on('data', (chunk) => this.#receive(chunk));
        this.socket = socket;
        resolve(socket);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return await this.connecting;
  }

  #receive(chunk) {
    this.buffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES && !this.buffer.includes('\n')) {
      this.#disconnect(new Error('Codex broker sent an oversized message'));
      return;
    }

    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.#disconnect(new Error('Codex broker sent an oversized message'));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.#disconnect(new Error('Codex broker sent malformed JSON'));
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (typeof message?.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new BraiCodexBrokerError(message.error.code, message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message?.method !== 'notification' || !message.params || typeof message.params.method !== 'string') return;
    this.emit('notification', message.params);
  }

  #disconnect(error) {
    const disconnected = Boolean(this.socket);
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
    this.buffer = '';
    this.#rejectPending('BRAI_BROKER_UNAVAILABLE', error?.message || 'Codex broker disconnected');
    if (disconnected && !this.closed) this.emit('disconnect', error);
  }

  #rejectPending(code, message) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new BraiCodexBrokerError(code, message));
    }
    this.pending.clear();
  }
}
