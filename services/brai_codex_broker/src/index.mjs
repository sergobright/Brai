import process from "node:process";
import { BrokerServer, RuntimeManager } from "./broker.mjs";

const manager = new RuntimeManager({
  dockerBin: process.env.BRAI_CODEX_DOCKER_BIN,
  image: process.env.BRAI_CODEX_IMAGE,
  expectedVersion: process.env.BRAI_CODEX_VERSION,
  environment: process.env.BRAI_ENVIRONMENT,
  stateRoot: process.env.BRAI_CODEX_STATE_ROOT,
  attachmentRoot: process.env.BRAI_CODEX_ATTACHMENT_ROOT,
  workspacePath: process.env.BRAI_CODEX_WORKSPACE,
  authPath: process.env.BRAI_CODEX_AUTH_FILE,
  configPath: process.env.BRAI_CODEX_CONFIG_FILE,
  requirementsPath: process.env.BRAI_CODEX_REQUIREMENTS_FILE,
  seccompPath: process.env.BRAI_CODEX_SECCOMP_FILE,
  apparmorProfile: process.env.BRAI_CODEX_APPARMOR_PROFILE,
  network: process.env.BRAI_CODEX_NETWORK,
  idleMs: process.env.BRAI_CODEX_IDLE_MS ? Number(process.env.BRAI_CODEX_IDLE_MS) : undefined,
});
const socketPath = process.env.BRAI_CODEX_BROKER_SOCKET;
if (!socketPath) throw new Error("BRAI_CODEX_BROKER_SOCKET is required");

await manager.preflight();
const server = new BrokerServer(manager, { socketPath });
await server.listen();

const timer = setInterval(() => void manager.sweepIdle(), Math.min(manager.idleMs, 60_000));
timer.unref();

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await server.close();
}

process.once("SIGTERM", () => void close().then(() => process.exit(0)));
process.once("SIGINT", () => void close().then(() => process.exit(0)));
