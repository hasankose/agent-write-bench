// Cross-check harness: runs the same tasks through TrueFact and
// records ITS verdict alongside our own independent ground truth.
//
// This does not replace capture.mjs. capture.mjs is the camera that produced
// results.md. This asks a different question: when TrueFact says "landed",
// is the item actually in the cart?

import { chromium } from "playwright-core";
import { launch } from "truefact";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const MODEL = process.env.BENCH_MODEL ?? "google/gemini-flash-lite-latest";
const HEADLESS = process.env.BENCH_HEADED !== "1";
const MAX_STEPS_DEFAULT = Number(process.env.BENCH_MAX_STEPS ?? 4);
const THROTTLE_MS = Number(process.env.BENCH_THROTTLE_MS ?? 6000);
const RUNS_DIR = "runs-tr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.env.BENCH_NOISY !== "1") {
  const drop = /CDP response failed|Frame with the given (frameId|id)|Session with given id not found/;
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (c, ...rest) => {
      const t = typeof c === "string" ? c : Buffer.from(c).toString("utf8");
      if (drop.test(t)) { const cb = rest.find((r) => typeof r === "function"); if (cb) cb(); return true; }
      return orig(c, ...rest);
    };
  }
}

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const taskId = arg("task");
const rep = Number(arg("rep", "1"));
if (!taskId) { console.error("usage: node capture-tr.mjs --task <id> [--rep <n>]"); process.exit(1); }

const tasks = JSON.parse(await readFile("tasks.json", "utf8"));
const task = tasks.find((t) => t.id === taskId);
if (!task) { console.error(`no task "${taskId}"`); process.exit(1); }
const MAX_STEPS = Number(task.max_steps ?? MAX_STEPS_DEFAULT);

const keys = (process.env.BENCH_API_KEYS || process.env.GOOGLE_API_KEY || "").split(",").map((k) => k.trim()).filter(Boolean);
if (!keys.length) { console.error("set BENCH_API_KEYS"); process.exit(1); }
const apiKey = keys[Number(arg("keyindex", "0")) % keys.length];

await mkdir(RUNS_DIR, { recursive: true });
const modelSlug = MODEL.replace(/[^a-z0-9.]+/gi, "-").replace(/^-|-$/g, "");
const runId = `${task.id}--${modelSlug}--rep${rep}`;

const record = {
  run_id: runId, task: task.id, instruction: task.instruction, site: task.site,
  verify_url: task.verify_url ?? null, framework: "stagehand+truefact", model: MODEL,
  started_at: new Date().toISOString(),
  truefact: null,          // what TrueFact concluded
  ground_truth: null,      // what the cart page says — checked independently
  agreement: null,         // do they match?
  errors: [],
};

let tf, verifier;
try {
  // TrueFact owns the browser, so the network channel works without configuring a port.
  tf = await launch({ headless: HEADLESS, model: { modelName: MODEL, apiKey } });

  await tf.page.goto(task.site);

  let lastSelector = null;
  for (let i = 1; i <= MAX_STEPS; i++) {
    let r;
    try { r = await tf.act(task.instruction); }
    catch (e) { record.errors.push({ stage: `act:${i}`, error: String(e) }); break; }

    const sel = (String(r?.data?.message ?? "").match(/xpath=\S+/) || [null])[0];
    if (sel && sel === lastSelector) break;          // same stop rule as capture.mjs
    lastSelector = sel;
    if (r?.data?.success === false) break;
    if (i < MAX_STEPS) await sleep(THROTTLE_MS);
  }

  // TrueFact's own conclusion, before we look at anything ourselves.
  record.truefact = {
    run_verdict: tf.replay.verdict,
    steps: tf.replay.steps.map((s) => ({
      kind: s.kind, action: s.action, verdict: s.verdict,
      settled: s.evidence?.settled ?? null,
      session: s.evidence?.session ?? null,
      agent_claim: s.agent_claim ?? null,
    })),
  };

  // Ground truth, read the way capture.mjs reads it: go to the page where the
  // result actually lives and look. A separate browser, so TrueFact never sees it
  // and cannot be credited with a verdict it did not reach on its own.
  if (task.verify_url) {
    try {
      verifier = await chromium.launch({ headless: HEADLESS });
      const rawPage = await verifier.newPage();
      const cookies = await tf.page.context().cookies();
      await rawPage.context().addCookies(cookies);
      await rawPage.goto(task.verify_url);
      await rawPage.waitForLoadState("load").catch(() => {});
      const tree = await rawPage.evaluate(() => document.body.innerText);
      const lines = String(tree).split("\n");
      const emptyNode = lines.some((l) => /(heading|StaticText|paragraph):.*\b(cart|bag)\b.*\bis empty\b/i.test(l));
      const lineItem = lines.some((l) => /(subtotal|order total)/i.test(l));
      record.ground_truth = {
        url: task.verify_url,
        landed: emptyNode && !lineItem ? false : lineItem && !emptyNode ? true : null,
        empty_node: emptyNode, line_item: lineItem, text_bytes: String(tree).length,
      };
    } catch (e) { record.errors.push({ stage: "verify", error: String(e) }); }
  }

  const tr = record.truefact.run_verdict;
  const gt = record.ground_truth?.landed;
  record.agreement =
    gt === null || gt === undefined ? "unknown"
    : tr === "landed" && gt === true ? "agree — both landed"
    : tr === "did-not-land" && gt === false ? "agree — both did not land"
    : tr === "landed" && gt === false ? "DISAGREE — TrueFact said landed, cart is empty"
    : tr === "did-not-land" && gt === true ? "DISAGREE — TrueFact said did-not-land, item is in cart"
    : `inconclusive (TrueFact: ${tr})`;
} catch (e) {
  record.errors.push({ stage: "setup", error: String(e) });
} finally {
  record.finished_at = new Date().toISOString();
  try { await tf?.close(); } catch {}
  try { await verifier?.close(); } catch {}
}

await writeFile(join(RUNS_DIR, `${runId}.json`), JSON.stringify(record, null, 2));
console.log(`${runId}  truefact=${record.truefact?.run_verdict ?? "—"}  cart=${record.ground_truth?.landed ?? "—"}  ${record.agreement}`);
