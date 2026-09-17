// Jev-driven agent, in the shape browser-use/jev-ultrafast uses.
//
// Stagehand only observes and executes. The decision is Jev's: one request
// returns an operation AND a target index, and the target is an element we
// already observed — the model never emits a selector.
//
// Same capture contract as capture.mjs: claims and page state recorded on
// separate channels, ground truth read from the page where the result lives.

import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const JEV_MODEL = process.env.JEV_MODEL ?? "jev-latest";
const OBSERVE_MODEL = process.env.BENCH_MODEL ?? "google/gemini-flash-lite-latest";
const HEADLESS = process.env.BENCH_HEADED !== "1";
const MAX_CANDIDATES = Number(process.env.JEV_MAX_CANDIDATES ?? 40);
const RUNS_DIR = "runs-jev";
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

const OPERATIONS = {
  CLICK: "click one of the listed elements to move toward the goal",
  SCROLL_DOWN: "the relevant element is probably further down the page",
  DONE: "the goal is already achieved on this page",
  BLOCKED: "the goal cannot be achieved from here",
};

async function askJev(state, candidates, key) {
  const criteria = Object.fromEntries(
    candidates.map((c, i) => [String(i + 1), `${c.method ?? "element"} — ${c.description}`.slice(0, 160)])
  );
  const body = JSON.stringify({
    state,
    model: JEV_MODEL,
    questions: {
      operation: { type: "choice", instructions: "Which operation moves toward the goal next?", criteria: OPERATIONS },
      click_target: { type: "choice", instructions: "If clicking, which element best serves the goal?", criteria },
    },
  });
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const taskId = arg("task");
const rep = Number(arg("rep", "1"));
if (!taskId) { console.error("usage: node capture-jev.mjs --task <id> [--rep <n>]"); process.exit(1); }

const tasks = JSON.parse(await readFile("tasks.json", "utf8"));
const task = tasks.find((t) => t.id === taskId);
if (!task) { console.error(`no task "${taskId}"`); process.exit(1); }
const MAX_STEPS = Number(task.max_steps ?? process.env.BENCH_MAX_STEPS ?? 4);

const jevKey = process.env.TYPESAFE_API_KEY;
const shKeys = (process.env.BENCH_API_KEYS || process.env.GOOGLE_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
if (!jevKey) { console.error("set TYPESAFE_API_KEY"); process.exit(1); }
if (!shKeys.length) { console.error("set BENCH_API_KEYS (observe() still needs a model)"); process.exit(1); }

await mkdir(RUNS_DIR, { recursive: true });
const runId = `${task.id}--jev--rep${rep}`;

const record = {
  run_id: runId, task: task.id, instruction: task.instruction, site: task.site,
  verify_url: task.verify_url ?? null,
  framework: "stagehand-observe + jev-decide", model: JEV_MODEL, observe_model: OBSERVE_MODEL,
  started_at: new Date().toISOString(),
  steps: [], ground_truth: null, jev_usage: { input: 0, output: 0, calls: 0 },
  errors: [], bucket: null,
};

let browser, stagehand;
try {
  browser = await localBrowser.launch({ headless: HEADLESS });
  stagehand = await Stagehand.create({ browser, model: { modelName: OBSERVE_MODEL, apiKey: shKeys[0] } });
  const [page] = await browser.context.pages();

  await page.goto(task.site);
  await page.waitForLoadState("load").catch(() => {});

  for (let i = 1; i <= MAX_STEPS; i++) {
    const step = { n: i };
    let candidates = [];
    try {
      const obs = await stagehand.observe("interactive elements relevant to the goal");
      candidates = (obs?.data ?? []).slice(0, MAX_CANDIDATES);
    } catch (e) { record.errors.push({ stage: `observe:${i}`, error: String(e) }); break; }
    if (!candidates.length) { step.stopped_because = "no candidates"; record.steps.push(step); break; }

    const before = await page.snapshot().catch(() => null);
    step.before_fingerprint = fp(before?.formattedTree ?? null);

    const table = candidates.map((c, n) => `[${n + 1}] ${c.method ?? "element"}  ${c.description}`).join("\n");
    const state = `Goal: ${task.instruction}\n\nCurrent URL: ${await page.url()}\n\nElement table:\n${table}`;

    let decision;
    try {
      decision = await askJev(state, candidates, jevKey);
      record.jev_usage.calls++;
      record.jev_usage.input += decision.usage?.input_tokens ?? 0;
      record.jev_usage.output += decision.usage?.output_tokens ?? 0;
    } catch (e) { record.errors.push({ stage: `jev:${i}`, error: String(e) }); break; }

    const op = decision.answers.operation;
    const tgt = decision.answers.click_target;
    step.decision = {
      operation: op.choice, operation_confidence: op.confidence,
      target_index: tgt.choice, target_confidence: tgt.confidence,
      target_description: candidates[Number(tgt.choice) - 1]?.description ?? null,
    };

    if (op.choice === "DONE" || op.choice === "BLOCKED") {
      step.stopped_because = op.choice;
      record.steps.push(step);
      break;
    }
    if (op.choice === "SCROLL_DOWN") {
      await page.scroll?.({ deltaY: 800 }).catch(() => {});
      record.steps.push(step);
      continue;
    }

    const chosen = candidates[Number(tgt.choice) - 1];
    if (!chosen) { step.stopped_because = "bad target index"; record.steps.push(step); break; }
    try {
      const r = await stagehand.act(chosen);
      step.executed = { success: r?.data?.success ?? null, message: r?.data?.message ?? null };
    } catch (e) { step.executed = { success: null, threw: String(e) }; }

    const after = await page.snapshot().catch(() => null);
    step.after_fingerprint = fp(after?.formattedTree ?? null);
    step.dom_changed = step.before_fingerprint && step.after_fingerprint
      ? step.before_fingerprint !== step.after_fingerprint : null;
    record.steps.push(step);
    await sleep(500);
  }

  if (task.verify_url) {
    // Ground truth is the only irreplaceable step in the run, and the driving
    // page's CDP session is frequently gone by now. Try a fresh page, then the
    // existing pages, and retry — cookies hold the cart, so a brand-new browser
    // would read an empty cart no matter what happened.
    let got = false;
    for (let attempt = 1; attempt <= 3 && !got; attempt++) {
      try {
        let p2 = null;
        try { p2 = await browser.context.newPage(); } catch {}
        if (!p2) { const ps = await browser.context.pages().catch(() => []); p2 = ps[ps.length - 1] ?? null; }
        if (!p2) throw new Error("no usable page");
        await p2.goto(task.verify_url);
        await p2.waitForLoadState("load").catch(() => {});
        const snap = await p2.snapshot();
        const tree = String(snap?.formattedTree ?? "");
        if (!tree) throw new Error("empty tree");
        const L = tree.split("\n");
        const empty = L.some((l) => /(heading|StaticText|paragraph):.*\b(cart|bag)\b.*\bis empty\b/i.test(l));
        const item = L.some((l) => /(subtotal|order total)/i.test(l));
        record.ground_truth = {
          url: task.verify_url,
          landed: empty && !item ? false : item && !empty ? true : null,
          tree_bytes: tree.length, attempts: attempt,
        };
        got = true;
      } catch (e) {
        if (attempt === 3) record.errors.push({ stage: "verify", error: String(e) });
        else await sleep(1500);
      }
    }
  }
} catch (e) {
  record.errors.push({ stage: "setup", error: String(e) });
} finally {
  record.finished_at = new Date().toISOString();
  try { await stagehand?.close(); } catch {}
  try { await browser?.close(); } catch {}
}

const cost = (record.jev_usage.input / 1e6) * 0.042;
await writeFile(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record, null, 2));
console.log(
  `${runId}  steps=${record.steps.length}  jev_calls=${record.jev_usage.calls}  ` +
  `landed=${record.ground_truth?.landed ?? "—"}  jev_cost=$${cost.toFixed(6)}`
);
