import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCENARIOS, SEED } from "./fixtures.mjs";
import { MAX_ASSETS, MAX_BYTES, MAX_FILE_BYTES } from "./learning-lab.mjs";
import { evaluateReport } from "./verify-report.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const hash = (data) => createHash("sha256").update(data).digest("hex");
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
) {
  throw new Error(
    "Commit the complete lab source before measuring; dirty worktree refused",
  );
}
const playwrightPath = process.env.LG0_PLAYWRIGHT_MODULE;
const chromePath = process.env.LG0_CHROME_EXECUTABLE;
if (!playwrightPath || !chromePath)
  throw new Error("Set LG0_PLAYWRIGHT_MODULE and LG0_CHROME_EXECUTABLE");
const { chromium } = await import(pathToFileURL(playwrightPath).href);
const runId =
  new Date().toISOString().replace(/[:.]/g, "-") +
  "-" +
  randomUUID().slice(0, 8);
const output = path.join(root, "release-artifacts", "lg0", runId);
await mkdir(output, { recursive: true });
const bundle = await build({
  entryPoints: [path.join(root, "scripts/lg0/browser-lab.mjs")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "chrome152",
});
const js = bundle.outputFiles[0].contents;
const inputs = [
  "scripts/lg0/learning-lab.mjs",
  "scripts/lg0/fixtures.mjs",
  "scripts/lg0/legacy-fixture.mjs",
  "scripts/lg0/browser-lab.mjs",
  "scripts/lg0/run-browser.mjs",
  "scripts/lg0/verify-report.mjs",
  "docs/architecture/lg0-bounded-learning-contract.md",
  "package-lock.json",
  "src/background/storage/db.ts",
  "src/background/storage/current-video-transcript-migration.ts",
];
const sources = {};
for (const input of inputs)
  sources[input] = hash(
    (await readFile(path.join(root, input), "utf8")).replace(/\r\n/g, "\n"),
  );
const preflight = {
  runId,
  sourceEncoding: "utf8-lf",
  sourceRevisionState: "clean",
  seed: SEED,
  startedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  sources,
  bundleSha256: hash(js),
  node: process.version,
  os: { platform: os.platform(), release: os.release(), arch: os.arch() },
  hardware: {
    cpu: os.cpus()[0].model,
    logicalCores: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  limits: {
    assets: MAX_ASSETS,
    logicalBytes: MAX_BYTES,
    inputBytes: MAX_FILE_BYTES,
    sampledHeapGrowthBytes: 256 * 1024 * 1024,
  },
  scenarios: SCENARIOS,
  runsPerScenario: { cold: 3, warm: 5 },
  metrics:
    "query to second animation frame including DB open when cold; all stages and long tasks; sampled V8 heap is not an absolute peak or renderer RSS",
  disclosure:
    "synthetic lab page, not production extension; quota/abort injected; process close is graceful, not crash",
};
await writeFile(
  path.join(output, "preflight.json"),
  JSON.stringify(preflight, null, 2) + "\n",
);
const server = http.createServer((req, res) => {
  if (req.url === "/lab.js") {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(js);
    return;
  }
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      '<!doctype html><html lang="zh-CN"><title>LG-0 Synthetic Lab</title><body><output id="result">0</output><script src="/lab.js"></script></body></html>',
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const report = {
  ...preflight,
  runs: [],
  faults: null,
  errors: [],
  networkRejected: [],
};
let context;
const profiles = new Set();
async function removeProfile(profile) {
  const resolved = await realpath(profile);
  const allowed = await realpath(output);
  if (!resolved.startsWith(allowed + path.sep))
    throw new Error("unsafe_cleanup_path");
  await rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
  });
  profiles.delete(profile);
}
async function launch(profile) {
  profiles.add(profile);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: chromePath,
    headless: true,
    args: [
      "--enable-precise-memory-info",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    ],
  });
  await context.route("**/*", async (route) => {
    if (
      route
        .request()
        .url()
        .startsWith(address + "/")
    )
      await route.continue();
    else {
      report.networkRejected.push({
        origin: new URL(route.request().url()).origin,
      });
      await route.abort();
    }
  });
  const page = context.pages()[0];
  page.on("pageerror", (error) =>
    report.errors.push({ type: "page", message: error.message }),
  );
  await page.goto(address);
  await page.waitForFunction(() => !!globalThis.lg0);
  const cdp = await context.newCDPSession(page);
  const version = await cdp.send("Browser.getVersion");
  report.browser = {
    product: version.product,
    jsVersion: version.jsVersion,
    protocolVersion: version.protocolVersion,
  };
  if (!preflight.browser) {
    preflight.browser = report.browser;
    await writeFile(
      path.join(output, "preflight.json"),
      JSON.stringify(preflight, null, 2) + "\n",
    );
  } else if (preflight.browser.product !== report.browser.product) {
    throw new Error("browser_version_changed");
  }
  if (report.runs.length === 0) {
    for (const input of inputs) {
      const committed = execFileSync(
        "git",
        ["show", `${preflight.commit}:${input}`],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      )
        .toString("utf8")
        .replace(/\r\n/g, "\n");
      if (hash(committed) !== sources[input])
        throw new Error("source_commit_mismatch");
    }
  }
  return page;
}
try {
  for (const scenario of SCENARIOS) {
    for (let cold = 1; cold <= 3; cold++) {
      const profile = path.join(output, `synthetic-${scenario}-${cold}`);
      let page = await launch(profile);
      const seeded = await page.evaluate(
        (name) => globalThis.lg0.seed(name),
        scenario,
      );
      await context.close();
      context = null;
      page = await launch(profile);
      const receipt = await page.evaluate(
        (name) => globalThis.lg0.run(name, "cold"),
        scenario,
      );
      report.runs.push({ ...receipt, repetition: cold, seeded });
      await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
      );
      if (cold === 3) {
        for (let warm = 1; warm <= 5; warm++) {
          const receipt = await page.evaluate(
            (name) => globalThis.lg0.run(name, "warm"),
            scenario,
          );
          report.runs.push({ ...receipt, repetition: warm });
          await writeFile(
            path.join(output, "report.json"),
            JSON.stringify(report, null, 2) + "\n",
          );
        }
        if (scenario === "typical")
          report.faults = await page.evaluate(() => globalThis.lg0.faults());
      }
      await context.close();
      context = null;
      await removeProfile(profile);
    }
    console.log(`LG0 ${scenario}: 3 cold + 5 warm recorded`);
  }
} catch (error) {
  report.errors.push({ type: "runner", message: String(error) });
  process.exitCode = 1;
} finally {
  try {
    if (context) await context.close();
  } catch (error) {
    report.errors.push({ type: "close", message: String(error) });
  }
  await new Promise((resolve) => server.close(resolve));
  for (const profile of [...profiles]) {
    try {
      await removeProfile(profile);
    } catch (error) {
      report.errors.push({ type: "cleanup", message: String(error) });
    }
  }
  report.completedAt = new Date().toISOString();
  report.status =
    report.runs.length === 48 && report.errors.length === 0
      ? "measured"
      : "incomplete";
  report.lg0GateStatus = "insufficient_evidence";
  try {
    report.verdict = evaluateReport(report);
    report.lg0GateStatus = report.verdict.candidateGateStatus;
  } catch (error) {
    report.status = "invalid";
    report.errors.push({ type: "receipt-validation", message: String(error) });
    process.exitCode = 1;
  }
  await writeFile(
    path.join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      output: path.relative(root, output),
      status: report.status,
      runCount: report.runs.length,
      errors: report.errors,
    }),
  );
}
