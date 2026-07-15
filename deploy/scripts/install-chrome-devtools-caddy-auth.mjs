#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!['--check', '--install'].includes(mode)) {
  console.error('usage: install-chrome-devtools-caddy-auth.mjs --check|--install');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const packageRoot = process.env.CHROME_DEVTOOLS_MCP_ROOT || '/srv/opt/chrome-devtools-mcp/node_modules/chrome-devtools-mcp';
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageJson.version !== '1.5.0') throw new Error(`Unsupported chrome-devtools-mcp version: ${packageJson.version}`);

const toolsDir = path.join(packageRoot, 'build/src/tools');
const toolsFile = path.join(toolsDir, 'tools.js');
const sourceDir = path.join(repoRoot, 'deploy/chrome-devtools-mcp');
const moduleNames = ['caddy-auth.js', 'caddy-auth-policy.js'];
const importLine = "import * as caddyAuthTools from './caddy-auth.js';";
const listLine = '            ...Object.values(caddyAuthTools),';
let tools = fs.readFileSync(toolsFile, 'utf8');
const expectedTools = tools.includes(importLine) ? tools : tools.replace(
  "import * as consoleTools from './console.js';",
  `${importLine}\nimport * as consoleTools from './console.js';`,
);
const patchedTools = expectedTools.includes(listLine) ? expectedTools : expectedTools.replace(
  '            ...Object.values(consoleTools),',
  `${listLine}\n            ...Object.values(consoleTools),`,
);
if (!patchedTools.includes(importLine) || !patchedTools.includes(listLine)) {
  throw new Error('chrome-devtools-mcp tools.js patch point is missing.');
}

const modulesMatch = moduleNames.every((name) => {
  const target = path.join(toolsDir, name);
  return fs.existsSync(target) && fs.readFileSync(target, 'utf8') === fs.readFileSync(path.join(sourceDir, name), 'utf8');
});
const installed = modulesMatch && tools === patchedTools && tools.includes(importLine) && tools.includes(listLine);
if (mode === '--check') {
  if (!installed) throw new Error('Caddy auth bridge is not installed or is out of sync.');
  console.log('chrome-devtools-caddy-auth=ok');
  process.exit(0);
}
fs.mkdirSync(toolsDir, { recursive: true });
for (const name of moduleNames) fs.copyFileSync(path.join(sourceDir, name), path.join(toolsDir, name));
if (tools !== patchedTools) fs.writeFileSync(toolsFile, patchedTools);
console.log('chrome-devtools-caddy-auth=installed');
