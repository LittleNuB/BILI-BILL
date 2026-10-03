import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const ATTRIBUTION_DIRECTORY_PATTERN = /^(?:licenses?|licences?|notices?|legal)$/i;
const ATTRIBUTION_NAME_PATTERN = /(?:^|[-_.])(?:licen[cs]e|notices?|copying|copyright(?:notices?)?|authors?)(?:$|[-_.])/i;
const LICENSE_NAME_PATTERN = /(?:^|[-_.])(?:licen[cs]e|copying)(?:$|[-_.])/i;
const NON_ATTRIBUTION_EXTENSION = /\.(?:[cm]?js|[cm]?ts|jsx|tsx|map|json|svg|png|jpe?g|webp|woff2?|ttf|wasm|node)$/i;

export function collectProductionPackages(packageLock) {
  if (!packageLock?.packages || typeof packageLock.packages !== 'object') {
    throw new TypeError('package-lock.json does not contain a packages map');
  }

  const packages = [];
  for (const [location, metadata] of Object.entries(packageLock.packages)) {
    if (!location.startsWith('node_modules/') || metadata?.dev === true) continue;
    assertSafePackageLocation(location);
    if (typeof metadata?.version !== 'string' || metadata.version.length === 0) {
      throw new TypeError(`Production package is missing a version: ${location}`);
    }

    packages.push({
      name: packageNameFromLocation(location),
      version: metadata.version,
      location,
      license: typeof metadata.license === 'string' ? metadata.license : null,
      resolved: typeof metadata.resolved === 'string' ? metadata.resolved : null,
      integrity: typeof metadata.integrity === 'string' ? metadata.integrity : null,
    });
  }

  return packages.sort((left, right) => left.location.localeCompare(right.location));
}

export function getPackageLicenseDirectory(packageRecord) {
  const packageSlug = safePathSegment(packageRecord.name);
  const versionSlug = safePathSegment(packageRecord.version);
  const locationDigest = createHash('sha256')
    .update(packageRecord.location)
    .digest('hex')
    .slice(0, 16);
  return path.posix.join(
    'third_party_licenses',
    'npm',
    `package-${packageSlug}`,
    `version-${versionSlug}`,
    `location-${locationDigest}`,
  );
}

export function getPackageNoticeLine(packageRecord, declaredLicense) {
  return `- ${packageRecord.name} ${packageRecord.version} | License: ${declaredLicense} | Lock path: ${packageRecord.location}`;
}

export function getDeclaredLicense(packageMetadata, packageLabel) {
  if (typeof packageMetadata?.license !== 'string' || packageMetadata.license.trim().length === 0) {
    throw new TypeError(`Production package has no declared license: ${packageLabel}`);
  }
  return packageMetadata.license.trim();
}

export async function collectPackageAttributionFiles(packageRoot, relativeDirectory = '') {
  const entries = await readdir(path.join(packageRoot, relativeDirectory), { withFileTypes: true });
  const files = await Promise.all(entries.map(async entry => {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') return [];
      return collectPackageAttributionFiles(packageRoot, relativePath);
    }
    return entry.isFile() && isAttributionFilePath(relativePath) ? [relativePath] : [];
  }));
  return files.flat().sort();
}

export function isAttributionFilePath(relativePath) {
  if (NON_ATTRIBUTION_EXTENSION.test(relativePath)) return false;
  const segments = relativePath.replaceAll('\\', '/').split('/');
  const fileName = segments.at(-1) ?? '';
  return (
    ATTRIBUTION_NAME_PATTERN.test(fileName)
    || segments.slice(0, -1).some(segment => ATTRIBUTION_DIRECTORY_PATTERN.test(segment))
  );
}

export function isLicenseFilePath(relativePath) {
  if (NON_ATTRIBUTION_EXTENSION.test(relativePath)) return false;
  const segments = relativePath.replaceAll('\\', '/').split('/');
  const fileName = segments.at(-1) ?? '';
  return (
    LICENSE_NAME_PATTERN.test(fileName)
    || segments.slice(0, -1).some(segment => /^(?:licenses?|licences?)$/i.test(segment))
  );
}

function packageNameFromLocation(location) {
  const marker = 'node_modules/';
  const markerIndex = location.lastIndexOf(marker);
  const name = location.slice(markerIndex + marker.length);
  if (!name || name === '@' || name.endsWith('/')) {
    throw new TypeError(`Cannot derive package name from lockfile location: ${location}`);
  }
  return name;
}

function assertSafePackageLocation(location) {
  const segments = location.split('/');
  if (
    location.includes('\\')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new TypeError(`Unsafe package-lock location: ${location}`);
  }
}

function safePathSegment(value) {
  const segment = value.replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '');
  return segment || 'unnamed';
}
