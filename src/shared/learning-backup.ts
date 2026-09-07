import {
  LEARNING_MAX_ASSETS,
  LEARNING_MAX_BYTES,
  canonicalLearning,
  learningAssert,
  learningBytes,
  validateLearningAsset,
  type LearningAsset,
} from "./learning.ts";

const encoder = new TextEncoder();
const PREFIX = '{"assets":';
const SUFFIX = ',"format":"bili-bill-learning","version":1}';
export const LEARNING_MAX_FILE_BYTES =
  LEARNING_MAX_BYTES + encoder.encode(PREFIX + SUFFIX).length;
const ordered = (rows: LearningAsset[]) =>
  [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const learningYield = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export const learningNotCancelled = (signal?: AbortSignal) =>
  learningAssert(!signal?.aborted, "cancelled");

export function sameLearningContent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    left === null ||
    right === null ||
    typeof left !== "object" ||
    typeof right !== "object"
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    )
      return false;
    for (let index = 0; index < left.length; index++) {
      if (
        !Object.hasOwn(left, index) ||
        !Object.hasOwn(right, index) ||
        !sameLearningContent(left[index], right[index])
      )
        return false;
    }
    return true;
  }
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && sameLearningContent(a[key], b[key]),
    )
  );
}

export function validateLearningAssets(
  rows: unknown,
): asserts rows is LearningAsset[] {
  learningAssert(
    Array.isArray(rows) && rows.length <= LEARNING_MAX_ASSETS,
    "capacity_count",
  );
  const ids = new Set<string>();
  for (const row of rows) {
    validateLearningAsset(row);
    learningAssert(!ids.has(row.id), "duplicate_id");
    ids.add(row.id);
  }
  learningAssert(learningBytes(rows) <= LEARNING_MAX_BYTES, "capacity_bytes");
}

// Resource guard only. Native JSON parsing and exact canonical encoding decide syntax.
export function parseLearningBackupJson(text: string): unknown {
  learningAssert(
    typeof text === "string" && text.length <= LEARNING_MAX_FILE_BYTES,
    "file_size",
  );
  const stack: { kind: string; entries: number }[] = [];
  const limit =
    2 + LEARNING_MAX_ASSETS * 9 + Math.floor(LEARNING_MAX_BYTES / 30);
  let containers = 0,
    inString = false,
    escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      learningAssert(
        !(char === "[" && stack.at(-1)?.kind === "["),
        "json_resource_limit",
      );
      containers++;
      learningAssert(
        stack.length < 6 && containers <= limit,
        "json_resource_limit",
      );
      stack.push({ kind: char, entries: 1 });
    } else if (char === "}" || char === "]") {
      learningAssert(
        stack.pop()?.kind === (char === "}" ? "{" : "["),
        "invalid_json",
      );
    } else if (char === "," && stack.length) {
      const frame = stack.at(-1)!;
      frame.entries++;
      learningAssert(
        frame.entries <= (frame.kind === "[" ? 4096 : 11),
        "json_resource_limit",
      );
    }
  }
  return JSON.parse(text);
}

async function digest(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function validateLearningImportIdentity(row: LearningAsset) {
  if (!row.importedFrom) return;
  const receipt = row.importedFrom;
  const original = parseLearningBackupJson(receipt.original);
  validateLearningAsset(original);
  learningAssert(
    canonicalLearning(original) === receipt.original &&
      original.id === receipt.id,
    "import_identity",
  );
  learningAssert(
    (await digest(receipt.original)) === receipt.digest,
    "import_identity",
  );
  learningAssert(
    (await digest("lg0-import:" + receipt.id + ":" + receipt.digest)) ===
      row.id,
    "import_identity",
  );
  const immutable = (value: LearningAsset) => {
    const { id, personal, updatedAt, importedFrom, ...rest } = value;
    return rest;
  };
  learningAssert(
    sameLearningContent(immutable(original), immutable(row)),
    "import_identity",
  );
}

export async function encodeLearningBackup(
  rows: LearningAsset[],
  signal?: AbortSignal,
): Promise<string> {
  learningNotCancelled(signal);
  await learningYield();
  learningNotCancelled(signal);
  validateLearningAssets(rows);
  for (const row of rows) {
    await validateLearningImportIdentity(row);
    learningNotCancelled(signal);
  }
  const text = PREFIX + canonicalLearning(ordered(rows)) + SUFFIX;
  await learningYield();
  learningNotCancelled(signal);
  return text;
}

export async function decodeLearningBackup(
  file: Blob,
  signal?: AbortSignal,
): Promise<LearningAsset[]> {
  learningNotCancelled(signal);
  learningAssert(
    Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      file.size <= LEARNING_MAX_FILE_BYTES,
    "file_size",
  );
  const bytes = await file.arrayBuffer();
  learningNotCancelled(signal);
  learningAssert(bytes.byteLength === file.size, "file_size");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const data = parseLearningBackupJson(text) as {
    format: unknown;
    version: unknown;
    assets: unknown;
  };
  learningAssert(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      Object.keys(data).sort().join(",") === "assets,format,version",
    "format",
  );
  learningAssert(
    data.format === "bili-bill-learning" && data.version === 1,
    "format",
  );
  validateLearningAssets(data.assets);
  learningAssert(
    (await encodeLearningBackup(data.assets, signal)) === text,
    "noncanonical_backup",
  );
  learningNotCancelled(signal);
  return data.assets;
}

export async function mergeLearningAssets(
  local: LearningAsset[],
  incoming: LearningAsset[],
  signal?: AbortSignal,
): Promise<LearningAsset[]> {
  validateLearningAssets(local);
  validateLearningAssets(incoming);
  local = structuredClone(local);
  incoming = structuredClone(incoming);
  for (const row of [...local, ...incoming]) {
    await validateLearningImportIdentity(row);
    learningNotCancelled(signal);
  }
  const result = new Map(local.map((row) => [row.id, row]));
  for (const row of ordered(incoming)) {
    learningNotCancelled(signal);
    const current = result.get(row.id);
    if (!current) {
      result.set(row.id, row);
      continue;
    }
    if (sameLearningContent(current, row)) continue;
    const original = canonicalLearning(row);
    const hash = await digest(original);
    const id = await digest("lg0-import:" + row.id + ":" + hash);
    const importedFrom = { id: row.id, digest: hash, original };
    const existing = result.get(id);
    if (existing) {
      learningAssert(
        sameLearningContent(existing.importedFrom, importedFrom),
        "import_identity_collision",
      );
      continue;
    }
    result.set(id, { ...row, id, importedFrom });
  }
  const rows = ordered([...result.values()]);
  validateLearningAssets(rows);
  return rows;
}
