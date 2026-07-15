import process from "node:process";
import { BraiCodexBrokerClient } from "./client.mjs";

const socketPath = process.argv[2] ?? process.env.BRAI_CODEX_BROKER_SOCKET;
if (!socketPath) throw new Error("broker socket path is required");
const client = new BraiCodexBrokerClient(socketPath, { timeoutMs: 10_000 });
try {
  const status = await client.call("readiness");
  if (status?.ready !== true) process.exitCode = 1;
} finally {
  client.close();
}
