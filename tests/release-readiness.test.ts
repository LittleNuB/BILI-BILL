import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectManifestContentScriptFiles,
  collectManifestEntryFiles,
  getRequiredReleaseEntryFiles,
  REQUIRED_BUILD_ENTRY_FILES,
} from "../scripts/release-entry-contract.mjs";
import {
  collectPackageAttributionFiles,
  collectProductionPackages,
  getPackageLicenseDirectory,
  getPackageNoticeLine,
  isAttributionFilePath,
} from "../scripts/production-license-contract.mjs";

async function readRepositoryFile(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("release metadata, permissions, and license stay coherent", async () => {
  const [packageSource, manifestSource, licenseSource, agentGuideSource] =
    await Promise.all([
      readRepositoryFile("package.json"),
      readRepositoryFile("public/manifest.json"),
      readRepositoryFile("LICENSE"),
      readRepositoryFile("AGENTS.md"),
    ]);
  const packageJson = JSON.parse(packageSource) as {
    name: string;
    version: string;
    license?: string;
    dependencies: Record<string, string>;
  };
  const manifest = JSON.parse(manifestSource) as {
    version: string;
    version_name: string;
    permissions: string[];
  };

  assert.equal(packageJson.name, "bili-bill");
  assert.equal(packageJson.version, manifest.version_name);
  assert.equal(manifest.version, packageJson.version.replace(/-alpha$/, ""));
  assert.equal(packageJson.license, "MIT");
  assert.match(licenseSource, /^MIT License/m);
  assert.match(licenseSource, /Bili-Bill contributors/);
  assert.ok(!manifest.permissions.includes("cookies"));
  assert.match(
    agentGuideSource,
    /Do not add the `cookies` permission unless an accepted issue introduces a reviewed `chrome\.cookies` use case/,
  );
});

test("the supported ECharts 6 word-cloud integration is registered", async () => {
  const [packageSource, registrySource, preferenceSource] = await Promise.all([
    readRepositoryFile("package.json"),
    readRepositoryFile("src/shared/echarts/register.ts"),
    readRepositoryFile("dashboard/modules/preference/PreferencePage.tsx"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    dependencies: Record<string, string>;
  };

  assert.match(packageJson.dependencies.echarts, /^\^6\.1\./);
  assert.equal(packageJson.dependencies["@echarts-x/custom-word-cloud"], "^1.0.1");
  assert.equal(packageJson.dependencies["echarts-wordcloud"], undefined);
  assert.match(registrySource, /@echarts-x\/custom-word-cloud/);
  assert.match(registrySource, /CustomChart/);
  assert.match(preferenceSource, /type: 'custom'/);
  assert.match(preferenceSource, /renderItem: 'wordCloud'/);
  assert.ok(!preferenceSource.includes("type: 'wordCloud'"));
});

test("production build keeps chart vendors bounded and background imports consistent", async () => {
  const [viteConfigSource, blindBoxSource, transcriptCacheSource, verificationSource] =
    await Promise.all([
      readRepositoryFile("vite.config.ts"),
      readRepositoryFile("src/background/api/video-blind-box-candidates.ts"),
      readRepositoryFile("src/background/current-video-transcript-cache.ts"),
      readRepositoryFile("scripts/verify-release-dist.mjs"),
    ]);

  assert.match(viteConfigSource, /rolldownOptions:/);
  assert.match(viteConfigSource, /codeSplitting:/);
  assert.match(viteConfigSource, /includeDependenciesRecursively: false/);
  assert.match(viteConfigSource, /echarts-word-cloud/);
  assert.match(viteConfigSource, /echarts-renderer/);
  assert.match(viteConfigSource, /name: 'echarts'/);
  assert.doesNotMatch(viteConfigSource, /manualChunks/);
  assert.doesNotMatch(viteConfigSource, /rollupOptions/);
  assert.doesNotMatch(viteConfigSource, /chunkSizeWarningLimit/);
  assert.match(blindBoxSource, /import \{ biliGet \} from '\.\/client\.ts';/);
  assert.doesNotMatch(blindBoxSource, /await import\('\.\/client\.ts'\)/);
  assert.match(transcriptCacheSource, /import \{ biliGet \} from '\.\/api\/client\.ts';/);
  assert.match(
    transcriptCacheSource,
    /import \{ upsertCurrentVideoTranscriptEvidence \} from '\.\/storage\/current-video-transcript-repo\.ts';/,
  );
  assert.doesNotMatch(transcriptCacheSource, /await import\('\.\/api\/client\.ts'\)/);
  assert.doesNotMatch(
    transcriptCacheSource,
    /await import\('\.\/storage\/current-video-transcript-repo\.ts'\)/,
  );
  assert.match(verificationSource, /MAX_MINIFIED_CHUNK_BYTES = 500_000/);
  assert.match(verificationSource, /getRequiredReleaseEntryFiles\(manifest\)/);
  assert.match(verificationSource, /new Script\(source/);
});

test("Vite 8 build configuration uses Rolldown and Oxc without deprecated compatibility options", async () => {
  const [
    packageSource,
    ciSource,
    devBuildSource,
    viteConfigSource,
    sidebarConfigSource,
    playerMonitorConfigSource,
  ] = await Promise.all([
    readRepositoryFile("package.json"),
    readRepositoryFile(".github/workflows/ci.yml"),
    readRepositoryFile("scripts/dev-build.mjs"),
    readRepositoryFile("vite.config.ts"),
    readRepositoryFile("vite.sidebar-card.config.ts"),
    readRepositoryFile("vite.player-monitor.config.ts"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    engines?: { node?: string };
    devDependencies: Record<string, string>;
  };

  assert.equal(packageJson.devDependencies.vite, "^8.2.0");
  assert.equal(packageJson.engines?.node, "^20.19.0 || >=22.12.0");
  assert.equal(
    (JSON.parse(packageSource) as { scripts: Record<string, string> }).scripts.dev,
    "node scripts/dev-build.mjs",
  );
  assert.match(devBuildSource, /vite\.config\.ts/);
  assert.match(devBuildSource, /vite\.sidebar-card\.config\.ts/);
  assert.match(devBuildSource, /vite\.player-monitor\.config\.ts/);
  assert.match(devBuildSource, /waitForInitialBuild/);
  assert.match(devBuildSource, /emptyOutDir: false/);
  assert.match(devBuildSource, /triggerIncrementalMainBuild/);
  assert.match(devBuildSource, /verifyDevelopmentEntries/);
  assert.match(ciSource, /node scripts\/dev-build\.mjs --smoke/);
  for (const configSource of [viteConfigSource, sidebarConfigSource, playerMonitorConfigSource]) {
    assert.match(configSource, /oxc:/);
    assert.match(configSource, /rolldownOptions:/);
    assert.doesNotMatch(configSource, /esbuild:/);
    assert.doesNotMatch(configSource, /rollupOptions:/);
    assert.doesNotMatch(configSource, /inlineDynamicImports/);
  }
  assert.doesNotMatch(viteConfigSource, /'content\/sidebar-card'/);
  assert.match(sidebarConfigSource, /'content\/sidebar-card'/);
  assert.match(sidebarConfigSource, /codeSplitting: false/);
  assert.match(playerMonitorConfigSource, /codeSplitting: false/);
});

test("release entry contract covers every manifest-declared runtime entry", async () => {
  const manifestSource = await readRepositoryFile("public/manifest.json");
  const manifest = JSON.parse(manifestSource) as {
    background?: { service_worker?: string };
    content_scripts?: Array<{ js?: string[] }>;
    action?: { default_popup?: string };
    options_page?: string;
    options_ui?: { page?: string };
    side_panel?: { default_path?: string };
    devtools_page?: string;
    chrome_url_overrides?: Record<string, string>;
    sandbox?: { pages?: string[] };
    web_accessible_resources?: Array<{ resources?: string[] }>;
  };
  const expectedManifestEntries = [
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap(entry => entry.js ?? []),
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.side_panel?.default_path,
    manifest.devtools_page,
    ...Object.values(manifest.chrome_url_overrides ?? {}),
    ...(manifest.sandbox?.pages ?? []),
    ...(manifest.web_accessible_resources ?? [])
      .flatMap(entry => entry.resources ?? [])
      .filter(resource => !resource.includes("*")),
  ]
    .filter((entry): entry is string => Boolean(entry))
    .sort();

  assert.deepEqual(collectManifestEntryFiles(manifest), expectedManifestEntries);
  assert.deepEqual(
    collectManifestContentScriptFiles(manifest),
    (manifest.content_scripts ?? []).flatMap(entry => entry.js ?? []).sort(),
  );
  assert.deepEqual(
    getRequiredReleaseEntryFiles(manifest),
    [...new Set([...expectedManifestEntries, ...REQUIRED_BUILD_ENTRY_FILES])].sort(),
  );
});

test("release entry contract ignores wildcard web resources but keeps concrete pages", () => {
  const manifest = {
    web_accessible_resources: [
      {
        resources: ["assets/*", "dashboard/index.html"],
      },
    ],
  };

  assert.deepEqual(collectManifestEntryFiles(manifest), ["dashboard/index.html"]);
  const requiredEntries = getRequiredReleaseEntryFiles(manifest);
  assert.ok(requiredEntries.includes("dashboard/index.html"));
  assert.ok(!requiredEntries.includes("assets/*"));
});

test("release builds carry project and third-party licenses", async () => {
  const [packageSource, lockSource, noticesSource, apacheSource, d3Source, wordCloudSource] =
    await Promise.all([
      readRepositoryFile("package.json"),
      readRepositoryFile("package-lock.json"),
      readRepositoryFile("THIRD_PARTY_NOTICES.txt"),
      readRepositoryFile("third_party/licenses/Apache-2.0.txt"),
      readRepositoryFile("third_party/licenses/BSD-3-Clause-d3.txt"),
      readRepositoryFile("third_party/licenses/MIT-wordcloud2.txt"),
    ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts: Record<string, string>;
  };
  const productionPackages = collectProductionPackages(JSON.parse(lockSource));
  const noticeLines = new Set(noticesSource.split(/\r?\n/).map(line => line.trim()));

  assert.match(packageJson.scripts.build, /copy-release-licenses\.mjs/);
  assert.match(packageJson.scripts.build, /verify-release-dist\.mjs/);
  assert.match(packageJson.scripts.build, /vite\.sidebar-card\.config\.ts/);
  assert.match(noticesSource, /Apache ECharts 6\.1\.0/);
  assert.match(noticesSource, /ECharts WordCloud Custom Series 1\.0\.1/);
  assert.match(apacheSource, /Apache License\s+Version 2\.0/);
  assert.match(d3Source, /Copyright 2010-2016 Mike Bostock/);
  assert.match(wordCloudSource, /Copyright \(c\) 2011- Timothy Guan-tin Chien/);
  assert.deepEqual(
    productionPackages.map(packageRecord => packageRecord.name),
    [
      "@echarts-x/custom-word-cloud",
      "@preact/signals",
      "@preact/signals-core",
      "argparse",
      "dexie",
      "echarts",
      "entities",
      "linkify-it",
      "lucide-preact",
      "markdown-it",
      "mdurl",
      "preact",
      "punycode.js",
      "tslib",
      "uc.micro",
      "zrender",
    ],
  );
  for (const packageRecord of productionPackages) {
    assert.ok(packageRecord.license);
    assert.ok(noticeLines.has(getPackageNoticeLine(packageRecord, packageRecord.license)));
    assert.match(
      getPackageLicenseDirectory(packageRecord),
      /^third_party_licenses\/npm\/package-[^/]+\/version-[^/]+\/location-[0-9a-f]{16}$/,
    );
    assert.ok(!getPackageLicenseDirectory(packageRecord).split("/").includes("node_modules"));
  }

  const echartsAttributions = await collectPackageAttributionFiles(
    fileURLToPath(new URL("../node_modules/echarts", import.meta.url)),
  );
  const tslibAttributions = await collectPackageAttributionFiles(
    fileURLToPath(new URL("../node_modules/tslib", import.meta.url)),
  );
  assert.ok(echartsAttributions.includes("licenses/LICENSE-d3"));
  assert.ok(tslibAttributions.includes("CopyrightNotice.txt"));
});

test("production license contract includes scoped and transitive packages but excludes dev-only packages", () => {
  const packages = collectProductionPackages({
    packages: {
      "": { dependencies: { runtime: "1.0.0" } },
      "node_modules/runtime": { version: "1.0.0" },
      "node_modules/runtime/node_modules/transitive": { version: "2.0.0" },
      "node_modules/@scope/runtime": { version: "3.0.0" },
      "node_modules/other/node_modules/runtime": {
        version: "1.0.0",
        resolved: "git+https://example.test/runtime.git#different-source",
      },
      "node_modules/dev-only": { version: "4.0.0", dev: true },
    },
  });

  assert.deepEqual(packages.map(packageRecord => packageRecord.location), [
    "node_modules/@scope/runtime",
    "node_modules/other/node_modules/runtime",
    "node_modules/runtime",
    "node_modules/runtime/node_modules/transitive",
  ]);
  assert.equal(packages.filter(packageRecord => packageRecord.name === "runtime").length, 2);
  assert.equal(
    packages.find(packageRecord => packageRecord.location.includes("other"))?.resolved,
    "git+https://example.test/runtime.git#different-source",
  );
  const runtimeDirectories = packages
    .filter(packageRecord => packageRecord.name === "runtime")
    .map(getPackageLicenseDirectory);
  assert.equal(new Set(runtimeDirectories).size, 2);
  assert.throws(
    () => collectProductionPackages({
      packages: {
        "node_modules/../../escape": { version: "1.0.0" },
      },
    }),
    /Unsafe package-lock location/,
  );
});

test("production license contract recognizes non-standard and nested attribution paths", () => {
  for (const relativePath of [
    "LICENSE-MIT",
    "NOTICE-third-party",
    "THIRD_PARTY_NOTICES",
    "CopyrightNotice.txt",
    "licenses/LICENSE-d3",
    "legal/upstream.txt",
  ]) {
    assert.equal(isAttributionFilePath(relativePath), true, relativePath);
  }
  assert.equal(isAttributionFilePath("README.md"), false);
  for (const relativePath of ["dist/esm/icons/copyright.mjs", "dist/esm/icons/copyright.mjs.map", "src/license.ts", "icons/copyright.svg"]) {
    assert.equal(isAttributionFilePath(relativePath), false, relativePath);
  }
});

test("release packaging builds fresh and promotes only a validated artifact", async () => {
  const [packageSource, packagerSource] = await Promise.all([
    readRepositoryFile("package.json"),
    readRepositoryFile("scripts/package-release.ps1"),
  ]);
  const packageJson = JSON.parse(packageSource) as {
    scripts: Record<string, string>;
  };

  assert.match(packageJson.scripts["package:release"], /^npm run build && /);
  assert.match(packagerSource, /Invalid release version/);
  assert.match(packagerSource, /Assert-ChildPath/);
  assert.match(packagerSource, /Assert-NotReparsePoint/);
  assert.match(packagerSource, /Assert-SafeReleaseTree/);
  assert.match(packagerSource, /Forbidden release path/);
  assert.match(packagerSource, /browser\[-_\]\?profile/);
  assert.match(packagerSource, /key\\\.txt/);
  assert.match(packagerSource, /temporaryZipPath/);
  assert.match(packagerSource, /\[IO\.Path\]::GetTempPath\(\)/);
  assert.ok(!packagerSource.includes("$env:TEMP"));
  assert.match(packagerSource, /Refusing to replace a different existing release ZIP/);
  assert.match(packagerSource, /Assert-RequiredReleaseFiles/);
  assert.ok(!packagerSource.includes("Remove-Item -LiteralPath $zipPath"));
});
