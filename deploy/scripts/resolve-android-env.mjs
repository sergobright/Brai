import path from "node:path";
import process from "node:process";
import { apkReleaseTargetByFlavor } from "./apk-release-targets.mjs";

const flavor = process.argv[2];
const root = process.env.BRAI_ROOT ?? path.resolve(import.meta.dirname, "../..");
const entry = apkReleaseTargetByFlavor(flavor, root);
if (!entry) throw new Error(`unknown Android flavor: ${flavor}`);

console.log(entry.environment);
console.log(entry.environment.startsWith("preview-") ? entry.displayLabel : "");
console.log(entry.domain);
console.log(`assemble${flavor[0].toUpperCase()}${flavor.slice(1)}Release`);
console.log(entry.releaseKey);
console.log(entry.path);
