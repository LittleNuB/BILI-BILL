import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { assertOrdinaryDistribution } from './ordinary-candidate-contract.mjs';
import {
  collectManifestContentScriptFiles,
  getRequiredReleaseEntryFiles,
} from './release-entry-contract.mjs';
import {
  collectPackageAttributionFiles,
  collectProductionPackages,
  getDeclaredLicense,
  getPackageLicenseDirectory,
  getPackageNoticeLine,
  isLicenseFilePath,
} from './production-license-contract.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = path.join(repositoryRoot, 'dist');

const requiredFiles = [
  ['LICENSE.txt', /^MIT License/m],
  ['THIRD_PARTY_NOTICES.txt', /Apache ECharts 6\.1\.0/],
  ['third_party_licenses/Apache-2.0.txt', /Apache License\s+Version 2\.0/],
  ['third_party_licenses/BSD-3-Clause-d3.txt', /Copyright 2010-2016 Mike Bostock/],
  ['third_party_licenses/MIT-wordcloud2.txt', /Copyright \(c\) 2011- Timothy Guan-tin Chien/],
];
const canonicalLfFiles = ['content/page-runtime-bridge.js'];
const MAX_MINIFIED_CHUNK_BYTES = 500_000;

const manifest = JSON.parse(await readFile(path.join(distRoot, 'manifest.json'), 'utf8'));
const expectedManifest = JSON.parse(await readFile(path.join(repositoryRoot, 'public/manifest.json'), 'utf8'));
const ordinaryScan = await assertOrdinaryDistribution(distRoot, expectedManifest);
const packageLock = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const thirdPartyNotices = await readFile(path.join(distRoot, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
const thirdPartyNoticeLines = new Set(thirdPartyNotices.split(/\r?\n/).map(line => line.trim()));
const requiredEntryFiles = getRequiredReleaseEntryFiles(manifest);
let productionAttributionFileCount = 0;

for (const [relativePath, expected] of requiredFiles) {
  const source = await readFile(path.join(distRoot, relativePath), 'utf8');
  assert.match(source, expected, `Release distribution notice is invalid: ${relativePath}`);
  assert.equal(
    source.includes('\r'),
    false,
    `Release distribution notice must use canonical LF: ${relativePath}`,
  );
}

for (const relativePath of canonicalLfFiles) {
  const source = await readFile(path.join(distRoot, relativePath), 'utf8');
  assert.equal(
    source.includes('\r'),
    false,
    `Release distribution runtime text must use canonical LF: ${relativePath}`,
  );
}

for (const packageRecord of collectProductionPackages(packageLock)) {
  const packageLabel = `${packageRecord.name} ${packageRecord.version}`;
  const packageRoot = path.join(repositoryRoot, ...packageRecord.location.split('/'));
  const packageMetadata = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  assert.equal(packageMetadata.name, packageRecord.name, `Installed package name changed: ${packageLabel}`);
  assert.equal(
    packageMetadata.version,
    packageRecord.version,
    `Installed package version changed: ${packageLabel}`,
  );
  const declaredLicense = getDeclaredLicense(packageMetadata, packageLabel);
  if (packageRecord.license && packageRecord.license !== declaredLicense) {
    throw new Error(`Installed package license does not match lockfile: ${packageLabel}`);
  }
  assert.ok(
    thirdPartyNoticeLines.has(getPackageNoticeLine(packageRecord, declaredLicense)),
    `Third-party notices omit or misstate production package license: ${packageLabel}`,
  );

  const attributionFiles = await collectPackageAttributionFiles(packageRoot);
  assert.ok(
    attributionFiles.some(isLicenseFilePath),
    `Production package has no source license file: ${packageLabel}`,
  );

  const releaseDirectory = getPackageLicenseDirectory(packageRecord);
  for (const relativePath of attributionFiles) {
    const [source, released] = await Promise.all([
      readFile(path.join(packageRoot, ...relativePath.split('/'))),
      readFile(path.join(distRoot, releaseDirectory, ...relativePath.split('/'))),
    ]);
    assert.deepEqual(
      released,
      source,
      `Release distribution changed ${packageLabel} ${relativePath}`,
    );
    productionAttributionFileCount += 1;
  }
}

for (const relativePath of requiredEntryFiles) {
  const entry = await stat(path.join(distRoot, relativePath));
  assert.ok(entry.isFile(), `Release distribution entry point is missing: ${relativePath}`);
}

for (const relativePath of collectManifestContentScriptFiles(manifest)) {
  const source = await readFile(path.join(distRoot, relativePath), 'utf8');
  assert.doesNotThrow(
    () => new Script(source, { filename: relativePath }),
    `Manifest content script is not valid classic JavaScript: ${relativePath}`,
  );
}

const chunkFiles = await collectJavaScriptFiles(distRoot);
for (const relativePath of chunkFiles) {
  const chunk = await stat(path.join(distRoot, relativePath));
  assert.ok(
    chunk.size <= MAX_MINIFIED_CHUNK_BYTES,
    `Minified chunk exceeds ${MAX_MINIFIED_CHUNK_BYTES} bytes: ${relativePath} (${chunk.size})`,
  );
}

console.log(
  `PASS release distribution: ${requiredFiles.length + productionAttributionFileCount} license/notice files, ${requiredEntryFiles.length} entries, ${chunkFiles.length} chunks; no developer interfaces in ${ordinaryScan.scannedContents} text assets`,
);

async function collectJavaScriptFiles(directory, relativeDirectory = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async entry => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) {
        return collectJavaScriptFiles(path.join(directory, entry.name), relativePath);
      }
      return entry.isFile() && entry.name.endsWith('.js') ? [relativePath] : [];
    }),
  );
  return files.flat();
}
