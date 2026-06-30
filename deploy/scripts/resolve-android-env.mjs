import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const flavor = process.argv[2];
const root = process.env.BRIGHT_OS_ROOT ?? path.resolve(import.meta.dirname, "../..");
const { environments } = JSON.parse(fs.readFileSync(path.join(root, "deploy/environments.json"), "utf8"));
const entry = Object.entries(environments).find(([, env]) => env.androidFlavor === flavor);
if (!entry) throw new Error(`unknown Android flavor: ${flavor}`);

const [environment, env] = entry;
console.log(environment);
console.log(environment.startsWith("preview-") ? env.displayLabel : "");
console.log(env.domain);
console.log(`assemble${flavor[0].toUpperCase()}${flavor.slice(1)}Release`);
console.log(env.releaseKey);
console.log(env.path);
