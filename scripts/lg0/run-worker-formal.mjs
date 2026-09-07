import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCENARIOS, SEED } from "./fixtures.mjs";
import { MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";
import { WORKER_INPUTS, buildWorkerBundles, evaluateWorkerReport, verifyWorkerBindings } from "./verify-worker-report.mjs";
import { workerHeapSampler } from "./worker-heap-sampler.mjs";

const root = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
assert.equal(git("status", "--porcelain"), "", "formal measurement requires a clean committed source");
assert.ok(process.env.LG0_PLAYWRIGHT_MODULE && process.env.LG0_CHROME_EXECUTABLE, "explicit test runtime required");
const { chromium } = await import(pathToFileURL(process.env.LG0_PLAYWRIGHT_MODULE).href);
const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
const directory = path.join(root, "release-artifacts", "lg0-formal-worker", runId);
await mkdir(directory, { recursive: true });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const bundles = await buildWorkerBundles(root);
const preflight = {
  kind: "formal-worker-matrix", runId, commit: git("rev-parse", "HEAD"),
  sourceRevisionState: "clean", sourceEncoding: "utf8-lf", seed: SEED, sources: {},
  bundles: Object.fromEntries(Object.entries(bundles).map(([url, bytes]) => [url, sha(bytes)])),
  node: process.version, os: { platform: os.platform(), release: os.release(), arch: os.arch() },
  hardware: { cpu: os.cpus()[0].model, logicalCores: os.cpus().length, totalMemoryBytes: os.totalmem() },
  scenarios: SCENARIOS, runsPerScenario: { cold: 3, warm: 5 },
  limits: { assets: 1000, logicalBytes: MAX_BYTES, inputBytes: MAX_FILE_BYTES,
    coldSearchMs: 2000, warmSearchMs: 500, mainThreadMs: 200, progressGapMs: 2000,
    sampledCombinedHeapGrowthBytes: 256 * 1024 * 1024 },
  measurement: "Search includes Worker/DB open when cold and second UI animation frame; cold restarts browser, not OS cache. Export and fresh/idempotent restore end at actual reply. Main-thread >=50ms tasks and 25ms-requested CDP page+Worker heap samples cover the whole workflow including integrity checks. No forced GC. Samples are nonsimultaneous and may miss peaks; actual gaps retained. Not absolute heap or RSS. Separate safety and PM acceptance are required; no historical verdict changes.",
};
for (const input of WORKER_INPUTS) preflight.sources[input] = sha((await readFile(path.join(root, input), "utf8")).replace(/\r\n/g, "\n"));
await verifyWorkerBindings(preflight, root);
await writeFile(path.join(directory, "preflight.json"), JSON.stringify(preflight, null, 2) + "\n", { flag: "wx" });
const report = { ...preflight, runs: [], errors: [], networkRejected: 0, profileCount: 0, profilesRemoved: 0 };
const server = createServer((request, response) => {
  response.setHeader("Content-Type", request.url === "/" ? "text/html" : "text/javascript");
  if (request.url === "/") response.end('<!doctype html><meta charset="utf-8"><title>LG-0 synthetic Worker matrix</title><output>0</output><script type="module" src="/formal.js"></script>');
  else if (bundles[request.url]) response.end(bundles[request.url]);
  else { response.statusCode = 404; response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profiles = new Set();
let context;
const persist = () => writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
async function launch(profile) {
  context = await chromium.launchPersistentContext(profile, { executablePath: process.env.LG0_CHROME_EXECUTABLE,
    headless: true, args: ["--disable-background-networking", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] });
  await context.route("**/*", route => {
    if (route.request().url().startsWith(origin + "/")) return route.continue();
    report.networkRejected++;
    return route.abort();
  });
  const page = context.pages()[0];
  page.on("pageerror", error => report.errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const sampler = await workerHeapSampler(cdp);
  const version = await cdp.send("Browser.getVersion");
  if (report.browser) assert.equal(version.product, report.browser.product);
  else {
    report.browser = version;
    preflight.browser = version;
    await writeFile(path.join(directory, "preflight.json"), JSON.stringify(preflight, null, 2) + "\n");
  }
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.formal);
  return { page, sampler };
}
async function cleanup(profile) {
  const actual = await realpath(profile);
  assert.equal(path.dirname(actual), await realpath(directory));
  assert.ok(path.basename(actual).startsWith("synthetic-"));
  assert.ok(path.relative(root, actual).startsWith(`release-artifacts${path.sep}lg0-formal-worker${path.sep}`));
  await rm(actual, { recursive: true, maxRetries: 8, retryDelay: 250 });
  profiles.delete(profile); report.profilesRemoved++;
}
try {
  for (const scenario of SCENARIOS) {
    for (let cold = 1; cold <= 3; cold++) {
      const profile = path.join(directory, `synthetic-${scenario}-${cold}`);
      profiles.add(profile); report.profileCount++;
      let runtime = await launch(profile);
      const name = "lg0-formal-" + scenario;
      const seeded = await runtime.page.evaluate(({ name, scenario }) => formal.seed(name, scenario), { name, scenario });
      await context.close(); context = null;
      runtime = await launch(profile);
      for (const [mode, repetitions] of [["cold", 1], ["warm", cold === 3 ? 5 : 0]]) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          const measured = await runtime.sampler.measure(() => runtime.page.evaluate(params => formal.run(params),
            { name, scenario, mode, stores: seeded.stores, seeded }));
          const run = { ...measured.result, repetition: mode === "cold" ? cold : repetition,
            memory: measured.memory, ...(mode === "cold" ? { seeded } : {}) };
          report.runs.push(run);
          await persist();
          console.log(JSON.stringify({ scenario, mode, repetition: run.repetition,
            searchMs: run.stages[0].elapsedMs, heapGrowthMiB: run.memory.sampledCombinedHeapGrowthBytes / 1024 ** 2 }));
        }
      }
      await context.close(); context = null;
      await cleanup(profile);
    }
  }
  report.status = "measured";
} catch (error) {
  report.status = "incomplete";
  report.errors.push(error.message.split("\n")[0]);
  process.exitCode = 1;
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  for (const profile of profiles) await cleanup(profile);
  await persist();
}
if (report.status === "measured") {
  const verdict = evaluateWorkerReport(report);
  await writeFile(path.join(directory, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ directory, ...verdict }, null, 2));
} else console.log(JSON.stringify({ directory, status: report.status, errors: report.errors }, null, 2));
