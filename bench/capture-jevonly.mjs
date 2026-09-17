// Jev-only agent. No other model touches any decision.
//
// The element table is built deterministically from the accessibility tree —
// no observe() call, no LLM. snapshot() gives formattedTree (roles + names) and
// xpathMap (node id -> xpath), so candidates and their selectors come straight
// from the page. Jev picks the operation and the target index. Execution is
// locator(xpath).click(). Stagehand is present only to attach the browser; its
// model is never invoked.

import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const HEADLESS = process.env.BENCH_HEADED !== "1";
const MAX_CANDIDATES = Number(process.env.JEV_MAX_CANDIDATES ?? 40);
const RUNS_DIR = "runs-jevonly";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.BENCH_NOISY !== "1") {
  const drop = /CDP response failed|Frame with the given (frameId|id)|Session with given id not found/;
  for (const s of [process.stdout, process.stderr]) {
    const o = s.write.bind(s);
    s.write = (c, ...r) => {
      const t = typeof c === "string" ? c : Buffer.from(c).toString("utf8");
      if (drop.test(t)) { const cb = r.find((x) => typeof x === "function"); if (cb) cb(); return true; }
      return o(c, ...r);
    };
  }
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const fp = (x) => createHash("sha1").update(JSON.stringify(x ?? null)).digest("hex").slice(0, 16);

const INTERACTIVE = /\[(\d+-\d+)\]\s+(button|link|combobox|textbox|checkbox|radio|menuitem|option|tab|spinbutton):\s*(.+)/g;
const NOISE = /^(skip to|previous announcement|next announcement)/i;

// Deterministic. No model involved.
function elementTable(tree, xpathMap) {
  const out = [];
  const seen = new Set();
  for (const m of String(tree).matchAll(INTERACTIVE)) {
    const [, id, role, rawName] = m;
    const name = rawName.trim().slice(0, 90);
    const xpath = xpathMap?.[id];
    if (!xpath || !name || NOISE.test(name)) continue;
    const key = `${role}|${name}`;
    if (seen.has(key)) continue;          // collapse duplicates (mobile + desktop nav)
    seen.add(key);
    out.push({ id, role, name, xpath });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

const OPERATIONS = {
  CLICK: "click one of the listed elements to move toward the goal",
  SCROLL_DOWN: "the relevant element is probably further down the page",
  DONE: "the goal is already achieved on this page",
  BLOCKED: "the goal cannot be achieved from here",
};

async function askJev(state, candidates, key) {
  const criteria = Object.fromEntries(
    candidates.map((c, i) => [String(i + 1), `${c.role} — ${c.name}`.slice(0, 160)])
  );
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state, model: JEV_MODEL,
      questions: {
        operation: { type: "choice", instructions: "Which operation moves toward the goal next?", criteria: OPERATIONS },
        click_target: { type: "choice", instructions: "If clicking, which element best serves the goal?", criteria },
      },
    }),
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const taskId = arg("task");
const rep = Number(arg("rep", "1"));
if (!taskId) { console.error("usage: node capture-jevonly.mjs --task <id> [--rep <n>]"); process.exit(1); }

const tasks = JSON.parse(await readFile("tasks.json", "utf8"));
const task = tasks.find((t) => t.id === taskId);
if (!task) { console.error(`no task "${taskId}"`); process.exit(1); }
const MAX_STEPS = Number(task.max_steps ?? process.env.BENCH_MAX_STEPS ?? 4);

const jevKey = process.env.TYPESAFE_API_KEY;
if (!jevKey) { console.error("set TYPESAFE_API_KEY"); process.exit(1); }

await mkdir(RUNS_DIR, { recursive: true });
const runId = `${task.id}--jevonly--rep${rep}`;

const record = {
  run_id: runId, task: task.id, instruction: task.instruction, site: task.site,
  verify_url: task.verify_url ?? null,
  framework: "jev-only (deterministic element table, no other model)",
  model: JEV_MODEL, observe_model: null,
  started_at: new Date().toISOString(),
  steps: [], ground_truth: null, jev_usage: { input: 0, output: 0, calls: 0 },
  errors: [], bucket: null,
};

let browser, stagehand;
try {
  browser = await localBrowser.launch({ headless: HEADLESS });
  // Stagehand attaches the browser. Its model is configured but never called —
  // no act(), no extract(), no observe() anywhere in this file.
  stagehand = await Stagehand.create({ browser, model: { modelName: "google/gemini-flash-lite-latest", apiKey: "unused" } });
  const [page] = await browser.context.pages();

  await page.goto(task.site);
  await page.waitForLoadState("load").catch(() => {});

  for (let i = 1; i <= MAX_STEPS; i++) {
    const step = { n: i };
    const snap = await page.snapshot().catch(() => null);
    if (!snap) { step.stopped_because = "snapshot failed"; record.steps.push(step); break; }

    const candidates = elementTable(snap.formattedTree, snap.xpathMap);
    step.candidates = candidates.length;
    step.before_fingerprint = fp(snap.formattedTree ?? null);
    if (!candidates.length) { step.stopped_because = "no candidates"; record.steps.push(step); break; }

    const table = candidates.map((c, n) => `[${n + 1}] ${c.role.padEnd(9)} ${c.name}`).join("\n");
    const state = `Goal: ${task.instruction}\n\nCurrent URL: ${await page.url()}\n\nElement table:\n${table}`;

    let d;
    try {
      d = await askJev(state, candidates, jevKey);
      record.jev_usage.calls++;
      record.jev_usage.input += d.usage?.input_tokens ?? 0;
      record.jev_usage.output += d.usage?.output_tokens ?? 0;
    } catch (e) { record.errors.push({ stage: `jev:${i}`, error: String(e) }); break; }

    const op = d.answers.operation, tgt = d.answers.click_target;
    const chosen = candidates[Number(tgt.choice) - 1];
    step.decision = {
      operation: op.choice, operation_confidence: op.confidence,
      target_index: tgt.choice, target_confidence: tgt.confidence,
      target: chosen ? `${chosen.role}: ${chosen.name}` : null,
    };

    if (op.choice === "DONE" || op.choice === "BLOCKED") { step.stopped_because = op.choice; record.steps.push(step); break; }
    if (op.choice === "SCROLL_DOWN") { await page.scroll(400, 400, 0, 800).catch(() => {}); record.steps.push(step); await sleep(400); continue; }
    if (!chosen) { step.stopped_because = "bad target index"; record.steps.push(step); break; }

    try {
      await page.locator(chosen.xpath).click();
      step.executed = { clicked: true, xpath: chosen.xpath.slice(0, 120) };
    } catch (e) { step.executed = { clicked: false, error: String(e).slice(0, 160) }; }

    await sleep(800);
    const after = await page.snapshot().catch(() => null);
    step.after_fingerprint = fp(after?.formattedTree ?? null);
    step.dom_changed = step.before_fingerprint && step.after_fingerprint
      ? step.before_fingerprint !== step.after_fingerprint : null;
    record.steps.push(step);
  }

  if (task.verify_url) {
    for (let a = 1; a <= 3 && !record.ground_truth; a++) {
      try {
        let p2 = null;
        try { p2 = await browser.context.newPage(); } catch {}
        if (!p2) { const ps = await browser.context.pages().catch(() => []); p2 = ps[ps.length - 1] ?? page; }
        await p2.goto(task.verify_url);
        await p2.waitForLoadState("load").catch(() => {});
        const s2 = await p2.snapshot();
        const tree = String(s2?.formattedTree ?? "");
        if (!tree) throw new Error("empty tree");
        const L = tree.split("\n");
        const empty = L.some((l) => /(heading|StaticText|paragraph):.*\b(cart|bag)\b.*\bis empty\b/i.test(l));
        const item = L.some((l) => /(subtotal|order total)/i.test(l));
        record.ground_truth = { url: task.verify_url, landed: empty && !item ? false : item && !empty ? true : null, tree_bytes: tree.length, attempts: a };
      } catch (e) { if (a === 3) record.errors.push({ stage: "verify", error: String(e) }); else await sleep(1500); }
    }
  }
} catch (e) {
  record.errors.push({ stage: "setup", error: String(e) });
} finally {
  record.finished_at = new Date().toISOString();
  try { await stagehand?.close(); } catch {}
  try { await browser?.close(); } catch {}
}

await writeFile(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record, null, 2));
console.log(
  `${runId}  steps=${record.steps.length} jev_calls=${record.jev_usage.calls} ` +
  `landed=${record.ground_truth?.landed ?? "—"} cost=$${((record.jev_usage.input / 1e6) * 0.042).toFixed(6)}`
);
