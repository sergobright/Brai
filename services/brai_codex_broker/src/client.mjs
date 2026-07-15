import { EventEmitter } from "node:events";
import net from "node:net";

export class BraiCodexBrokerClient extends EventEmitter {
  constructor(socketPath, { timeoutMs = 30_000 } = {}) {
    super();
    this.socketPath = socketPath;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.socket = null;
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    this.socket = net.createConnection(this.socketPath);
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.#read(chunk));
    this.socket.on("close", () => this.#failPending(new Error("Brai Codex broker disconnected")));
    this.socket.on("error", (error) => this.#failPending(error));
    await new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", reject);
    });
  }

  async call(method, params = {}) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Brai Codex broker request timed out"));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  close() {
    this.socket?.destroy();
  }

  #read(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method === "notification") {
        this.emit("notification", message.params);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #failPending(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
  }
}
