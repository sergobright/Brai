import { spawnSync } from "node:child_process";

const pathRules = [
  {
    reason: "runtime data directory",
    test: (filePath) => /(^|\/)data(\/|$)/i.test(filePath),
  },
  {
    reason: "generated deployment artifact",
    test: (filePath) => /(^|\/)deploy\/(site|web|mobile-update|releases)(\/|$)/i.test(filePath),
  },
  {
    reason: "local deployment inventory",
    test: (filePath) => /(^|\/)deploy\/ansible\/inventory\.local\./i.test(filePath),
  },
  {
    reason: "environment file",
    test: (filePath) => {
      const name = basename(filePath);
      return name !== ".env.example" && (name === ".env" || name.startsWith(".env."));
    },
  },
  {
    reason: "database, deploy artifact, signing, or private key file",
    test: (filePath) =>
      /\.(sqlite|sqlite3|db|db-wal|db-shm|apk|aab|zip|jks|keystore|pem|key|p12|pfx)$/i.test(filePath),
  },
  {
    reason: "credential-like configuration file",
    test: (filePath) =>
      /(^|\/)(google-services\.json|.*service-account.*\.json|.*credentials.*\.json|.*secrets.*\.json)$/i.test(filePath),
  },
];

const contentPattern = [
  "BEGIN (RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY",
  "AKIA[0-9A-Z]{16}",
  "ghp_[A-Za-z0-9_]{20,}",
  "github_pat_[A-Za-z0-9_]{20,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "sk-[A-Za-z0-9]{20,}",
  "AIza[0-9A-Za-z_-]{35}",
  "ya29\\.[0-9A-Za-z_-]+",
  "debug" + "\\.keystore",
  "android" + "debugkey",
  "BRAI_ANDROID_" + "STORE_PASSWORD.*" + "android",
  "Ser" + "gey",
  "Сер" + "гей",
  "/home/" + "mark",
  "157\\.254\\.223\\.221",
].join("|");

const failures = [];

for (const filePath of lines(git(["ls-tree", "-r", "--name-only", "HEAD"]))) {
  checkPath("current tree", filePath);
}

for (const filePath of lines(git(["ls-files", "-co", "--exclude-standard"]))) {
  checkPath("working tree", filePath);
}

for (const line of lines(git(["rev-list", "--objects", "HEAD"]))) {
  const firstSpace = line.indexOf(" ");
  if (firstSpace !== -1) checkPath("reachable history", line.slice(firstSpace + 1));
}

for (const commit of lines(git(["rev-list", "HEAD"]))) {
  const grep = spawnSync(
    "git",
    [
      "grep",
      "-I",
      "-l",
      "-E",
      contentPattern,
      commit,
      "--",
      ".",
      ":(exclude)scripts/check-public-branch.mjs",
    ],
    { encoding: "utf8" },
  );

  if (grep.status === 0) {
    failures.push(`forbidden content in ${commit.slice(0, 12)}: ${lines(grep.stdout).join(", ")}`);
  } else if (grep.status !== 1) {
    failCommand("git grep", grep);
  }
}

for (const args of [
  ["grep", "--cached", "-I", "-l", "-E", contentPattern, "--", ".", ":(exclude)scripts/check-public-branch.mjs"],
  ["grep", "--untracked", "-I", "-l", "-E", contentPattern, "--", ".", ":(exclude)scripts/check-public-branch.mjs"],
]) {
  const grep = spawnSync("git", args, { encoding: "utf8" });
  if (grep.status === 0) {
    failures.push(`forbidden content in working tree: ${lines(grep.stdout).join(", ")}`);
  } else if (grep.status !== 1) {
    failCommand("git grep", grep);
  }
}

if (failures.length > 0) {
  console.error("Public branch guard failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Public branch guard passed.");

function checkPath(source, filePath) {
  for (const rule of pathRules) {
    if (rule.test(filePath)) failures.push(`${source}: ${filePath} (${rule.reason})`);
  }
}

function basename(filePath) {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function lines(value) {
  return value.trim().split("\n").filter(Boolean);
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) failCommand(`git ${args.join(" ")}`, result);
  return result.stdout;
}

function failCommand(command, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  console.error(`${command} failed${output ? `:\n${output}` : ""}`);
  process.exit(result.status || 1);
}
