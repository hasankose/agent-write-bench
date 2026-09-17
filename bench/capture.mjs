// Receipt benchmark — capture harness.
// A camera, not a judge. Records what the agent claimed at every action and at
// the task level, and what the page showed before, after, and after a reload.
// It emits no verdicts. Grading happens by hand against ../mvp.md.

import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

// Stagehand probes browser targets that no longer exist and logs the rejections at
// ERROR level, writing straight to the stream rather than through console.
// They are internal retries, not failures — runs that emit them still produce clean
// snapshots. Silenced by default; BENCH_NOISY=1 to see them.
if (process.env.BENCH_NOISY !== "1") {
  const drop =
    /CDP response failed|Frame with the given (frameId|id)|Session with given id not found/;
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      if (drop.test(text)) {
        const cb = rest.find((r) => typeof r === "function");
        if (cb) cb();
        return true;
      }
      return orig(chunk, ...rest);
    };
  }
}

const MODEL = process.env.BENCH_MODEL ?? "google/gemini-flash-lite-latest";
// Free tier is 5 requests/minute. Every act() and extract() is one request.
const THROTTLE_MS = Number(process.env.BENCH_THROTTLE_MS ?? 6000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS = process.env.BENCH_HEADED !== "1";
// Per-task budget. A global 4 truncates genuinely multi-step tasks (configure →
// continue → add to bag) and scores harness truncation as agent failure.
const MAX_STEPS_DEFAULT = Number(process.env.BENCH_MAX_STEPS ?? 4);
const RUNS_DIR = "runs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const fingerprint = (s) =>
  createHash("sha1").update(JSON.stringify(s ?? null)).digest("hex").slice(0, 16);

// Everything observable without deciding anything.
async function snapshot(page, label, { full = true } = {}) {
  const out = { label, at: new Date().toISOString() };
  try { out.url = await page.url(); } catch (e) { out.url_error = String(e); }
  try { out.title = await page.title(); } catch (e) { out.title_error = String(e); }
  try {
    const snap = await page.snapshot();
    // formattedTree is the semantic accessibility view (~35KB).
    // xpathMap can run to tens of MB and says nothing we grade on — keep its size only.
    const tree = snap?.formattedTree ?? null;
    out.fingerprint = fingerprint(tree);
    out.tree_bytes = JSON.stringify(tree ?? null).length;
    out.xpath_map_bytes = JSON.stringify(snap?.xpathMap ?? null).length;
    if (full) out.tree = tree;
  } catch (e) { out.snapshot_error = String(e); }
  return out;
}

async function shot(page, runId, label) {
  try {
    const bytes = await page.screenshot();
    const file = join(RUNS_DIR, `${runId}--${label}.png`);
    await writeFile(file, Buffer.from(bytes));
    return file;
  } catch (e) { return { screenshot_error: String(e) }; }
}

const taskId = arg("task");
const rep = Number(arg("rep", "1"));
if (!taskId) { console.error("usage: node capture.mjs --task <id> [--rep <n>]"); process.exit(1); }

const tasks = JSON.parse(await readFile("tasks.json", "utf8"));
const task = tasks.find((t) => t.id === taskId);
if (!task) { console.error(`no task with id "${taskId}"`); process.exit(1); }
const MAX_STEPS = Number(task.max_steps ?? MAX_STEPS_DEFAULT);

// Free-tier quota is per Google Cloud project, so several keys from different
// projects multiply the budget. runall.mjs cycles --keyindex across runs so a
// key that just got rate-limited gets a rest while the others work.
// Provider-agnostic. BENCH_API_KEYS wins; GOOGLE_* kept as a fallback so existing
// shells keep working. Stagehand's ModelConfig is a strict object (modelName,
// apiKey, headers) with no baseURL, so the provider is chosen purely by the
// BENCH_MODEL prefix — google/…, groq/…, cerebras/…, openai/…, anthropic/….
const keys = (process.env.BENCH_API_KEYS || process.env.GOOGLE_API_KEYS || process.env.GOOGLE_API_KEY || "")
  .split(",").map((k) => k.trim()).filter(Boolean);
if (!keys.length) { console.error("set BENCH_API_KEYS (or GOOGLE_API_KEY) for the provider in BENCH_MODEL"); process.exit(1); }
const keyIndex = Number(arg("keyindex", "0")) % keys.length;
const apiKey = keys[keyIndex];

await mkdir(RUNS_DIR, { recursive: true });
// Model belongs in the filename. Without it a Gemini re-run silently destroys the
// Groq run of the same task — which already happened once.
const modelSlug = MODEL.replace(/[^a-z0-9.]+/gi, "-").replace(/^-|-$/g, "");
const runId = `${task.id}--${modelSlug}--rep${rep}`;

const record = {
  run_id: runId,
  task: task.id,
  instruction: task.instruction,
  site: task.site,
  verify_hint: task.verify_hint,
  verify_url: task.verify_url ?? null,
  framework: "stagehand",
  model: MODEL,
  key_index: keyIndex,
  max_steps: MAX_STEPS,
  started_at: new Date().toISOString(),
  steps: [],              // per-action claims + page fingerprints
  task_claim: null,       // the agent's own end-of-run self-report
  before: null,
  after: null,
  after_reload: null,
  verify_page: null,        // ground truth: the page where the result actually lives
  screenshots: {},
  counts: null,
  errors: [],
  bucket: null,           // hand-graded afterwards
};

let browser, stagehand;
try {
  browser = await localBrowser.launch({ headless: HEADLESS });
  stagehand = await Stagehand.create({ browser, model: { modelName: MODEL, apiKey } });
  const [page] = await browser.context.pages();

  await page.goto(task.site);
  await page.waitForLoadState("load").catch(() => {});
  record.before = await snapshot(page, "before");
  record.screenshots.before = await shot(page, runId, "before");

  let prev = record.before;
  let consecutiveNoAction = 0;

  for (let i = 1; i <= MAX_STEPS; i++) {
    const step = { n: i, before_fingerprint: prev.fingerprint, before_url: prev.url };
    try {
      let r;
      try {
        r = await stagehand.act(task.instruction);
      } catch (e) {
        // Free tier is 5 requests/minute and Stagehand retries internally, so a
        // single act() can burn three. Wait out the window and try once more
        // rather than poisoning the run with a quota error.
        if (/quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(String(e))) {
          step.quota_backoff = true;
          await sleep(65000);
          r = await stagehand.act(task.instruction);
        } else { throw e; }
      }
      step.claim = {
        success: r?.data?.success ?? null,
        message: r?.data?.message ?? null,
        actionDescription: r?.data?.actionDescription ?? null,
        actions: r?.data?.actions ?? null,
      };
    } catch (e) {
      step.claim = { success: null, threw: String(e) };
      record.errors.push({ stage: `act:${i}`, error: String(e) });
    }

    const after = await snapshot(page, `step${i}`, { full: false });
    step.after_fingerprint = after.fingerprint;
    step.after_url = after.url;
    // Mechanical observation, not a verdict: did anything change at all?
    // Inconclusive is a first-class verdict. If either snapshot failed we do NOT
    // know whether the page changed — two missing fingerprints must never compare
    // equal and be counted as "nothing happened".
    step.dom_changed =
      step.before_fingerprint && step.after_fingerprint
        ? step.before_fingerprint !== step.after_fingerprint
        : null;
    step.url_changed =
      step.before_url && step.after_url ? step.before_url !== step.after_url : null;
    record.steps.push(step);

    prev = after;

    if (step.claim?.success === false || step.claim?.success === null) {
      if (++consecutiveNoAction >= 2) break;   // agent is stuck
    } else {
      consecutiveNoAction = 0;
    }

    // Stop when the agent re-targets the SAME ELEMENT. Dedupe on the selector,
    // never on actionDescription — the model paraphrases itself every step while
    // emitting an identical xpath, so a description match never fires and a stuck
    // agent re-clicks until MAX_STEPS, scoring a fresh "ghost" on every repeat.
    const sel = (m) => (String(m ?? "").match(/xpath=\S+/) || [null])[0];
    const sels = record.steps.map((x) => sel(x.claim?.message)).filter(Boolean);
    step.selector = sel(step.claim?.message);
    const lastSel = sels[sels.length - 1];
    if (lastSel && sels.filter((d) => d === lastSel).length >= 2) {
      step.stopped_because = "repeated_selector";
      break;
    }

    if (i < MAX_STEPS) await sleep(THROTTLE_MS);
  }

  await sleep(THROTTLE_MS);

  // The agent's own task-level claim. A claim channel, not ground truth — recorded
  // precisely so it can be checked against the page.
  //
  // Skipped when no action ever claimed success: the answer is near-determined
  // ("not_done") and it costs a whole request against a tight quota. The one case
  // it would catch — the task succeeded despite the agent reporting failure — is
  // caught by the verify page anyway. The record says why it is null rather than
  // leaving a silent gap.
  const anyClaimedSuccess = record.steps.some((x) => x.claim?.success === true);
  if (!anyClaimedSuccess) {
    record.task_claim_skipped = "no action claimed success — self-report would be near-determined";
  }
  try {
    if (!anyClaimedSuccess) throw { __skip: true };
    const askVerdict = () => stagehand.extract(
      `Has this task been completed on this page: "${task.instruction}"? ` +
      `Answer done or not_done, and give the evidence you are relying on.`,
      z.object({
        status: z.enum(["done", "not_done"]),
        evidence: z.string(),
      })
    );
    let verdict;
    try {
      verdict = await askVerdict();
    } catch (e) {
      // Same backoff the actions get. Without it the most interesting runs —
      // the long ones — are exactly the ones that lose their self-report.
      if (/quota|rate limit|RESOURCE_EXHAUSTED|429/i.test(String(e))) {
        record.task_claim_backoff = true;
        await sleep(65000);
        verdict = await askVerdict();
      } else { throw e; }
    }
    record.task_claim = verdict?.data ?? verdict ?? null;
  } catch (e) {
    if (!e?.__skip) record.errors.push({ stage: "task_claim", error: String(e) });
  }

  record.after = await snapshot(page, "after");
  record.screenshots.after = await shot(page, runId, "after");

  // Tier 2 — persistence. Optimistic UI dies here and nowhere else.
  try {
    await page.reload();
    await page.waitForLoadState("load").catch(() => {});
    record.after_reload = await snapshot(page, "after_reload");
    record.screenshots.after_reload = await shot(page, runId, "after_reload");
  } catch (e) {
    record.errors.push({ stage: "reload", error: String(e) });
  }

  // Ground truth. The collection page cannot tell you whether the cart changed —
  // the cart page can. Navigate to where the result actually lives and look.
  if (task.verify_url) {
    try {
      await page.goto(task.verify_url);
      await page.waitForLoadState("load").catch(() => {});
      record.verify_page = await snapshot(page, "verify");
      record.screenshots.verify = await shot(page, runId, "verify");
    } catch (e) {
      record.errors.push({ stage: "verify", error: String(e) });
    }
  }
} catch (e) {
  record.errors.push({ stage: "setup", error: String(e) });
} finally {
  record.finished_at = new Date().toISOString();
  try { await stagehand?.close(); } catch {}
  try { await browser?.close(); } catch {}
}

const s = record.steps;
record.counts = {
  actions_attempted: s.length,
  actions_claimed_success: s.filter((x) => x.claim?.success === true).length,
  actions_claimed_failure: s.filter((x) => x.claim?.success === false).length,
  actions_threw: s.filter((x) => x.claim?.threw).length,
  // claimed success but the page did not change at all — Tier 0 guard, mechanical
  // claimed success and the page provably did not change — the ghost count
  claimed_success_dom_unchanged: s.filter((x) => x.claim?.success === true && x.dom_changed === false).length,
  // claimed success but we could not observe the page — excluded from the ghost count
  claimed_success_inconclusive: s.filter((x) => x.claim?.success === true && x.dom_changed === null).length,
  snapshot_failures: s.filter((x) => x.dom_changed === null).length,
};

const out = join(RUNS_DIR, `${runId}.json`);
await writeFile(out, JSON.stringify(record, null, 2));
const c = record.counts;
console.log(
  `${runId}  actions=${c.actions_attempted} ok=${c.actions_claimed_success} ` +
  `fail=${c.actions_claimed_failure} ghost=${c.claimed_success_dom_unchanged} ` +
  `inconc=${c.claimed_success_inconclusive}  ` +
  `task_claim=${record.task_claim?.status ?? "?"} key=${keyIndex}  -> ${out}`
);
