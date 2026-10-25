import { spawn } from "node:child_process";

// 两个进程一起跑：后端 5180，前端 5181（/api 已代理到后端）
const procs = [
  spawn(process.execPath, ["--watch", "server/index.ts"], { stdio: "inherit", env: { ...process.env, PORT: "5180" } }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", "5181"], { stdio: "inherit" }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
