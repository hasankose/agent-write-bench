import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const tasks = JSON.parse(await readFile("tasks.json", "utf8"))
  .filter((t) => (only.length ? only.includes(t.id) : !t.skip));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (id) => new Promise((res) => {
  const p = spawn("node", ["capture-jevonly.mjs", "--task", id, "--rep", "1"], { stdio: "inherit" });
  const t = setTimeout(() => { console.log(`  (${id} timed out)`); p.kill("SIGKILL"); }, 420000);
  p.on("close", (c) => { clearTimeout(t); res(c); });
});
let n = 0;
for (const t of tasks) {
  n++; console.log(`\n[${n}/${tasks.length}] ${t.id}`);
  await run(t.id);
  if (n < tasks.length) await sleep(6000);
}
console.log(`\n${n} runs attempted`);
