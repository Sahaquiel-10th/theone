import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commands = [
  [path.join(root, "node_modules/tsx/dist/cli.mjs"), "watch", "server/index.ts"],
  [path.join(root, "node_modules/vite/bin/vite.js"), "--host", "0.0.0.0"]
];
const children = commands.map((args) =>
  spawn(process.execPath, args, {
    stdio: "inherit",
    env: process.env,
    cwd: root
  })
);

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code !== 0) {
      stop();
      process.exitCode = code || 1;
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
