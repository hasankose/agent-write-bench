// Runs every task N times, sequentially. Keeps going when one blows up,
// kills anything that hangs, and leaves a gap between runs so the free-tier
// rate limit resets.
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const reps = Number(process.env.BENCH_REPS ?? 2);
const gapMs = Number(process.env.BENCH_RUN_GAP_MS ?? 15000);
const runTimeoutMs = Number(process.env.BENCH_RUN_TIMEOUT_MS ?? 420000);
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const tasks = JSON.parse(await readFile("tasks.json", "utf8"))
  .filter((t) => (only.length ? only.includes(t.id) : !t.skip));

const keyCount = (process.env.BENCH_API_KEYS || process.env.GOOGLE_API_KEYS || process.env.GOOGLE_API_KEY || "")
  .split(",").filter((k) => k.trim()).length;
if (!keyCount) {
  console.error("set BENCH_API_KEYS (or GOOGLE_API_KEY) — nothing would run. Aborting.");
  process.exit(1);
}
console.log(`${keyCount} API key(s) in rotation`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (task, rep, keyIndex) =>
  new Promise((resolve) => {
    const p = spawn("node", ["capture.mjs", "--task", task, "--rep", String(rep), "--keyindex", String(keyIndex)], {
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      console.log(`  (${task} rep${rep} exceeded ${runTimeoutMs}ms — killing)`);
      p.kill("SIGKILL");
    }, runTimeoutMs);
    p.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });

const total = tasks.length * reps;
let n = 0;
const startedAt = Date.now();

for (const t of tasks) {
  for (let r = 1; r <= reps; r++) {
    n++;
    console.log(`\n[${n}/${total}] ${t.id} rep${r}`);
    const code = await run(t.id, r, (n - 1) % keyCount);
    if (code !== 0) console.log(`  (exited ${code} — continuing)`);
    if (n < total) await sleep(gapMs);
  }
}

const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
console.log(`\n${n} runs attempted across ${tasks.length} tasks x ${reps} reps in ${mins} min`);
