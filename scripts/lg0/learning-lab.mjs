import Dexie from "dexie";

export const MAX_ASSETS = 1_000;
export const MAX_BYTES = 10_485_760;
export const FORMAT = "bili-bill-learning";
const encoder = new TextEncoder();
const PREFIX = `{"assets":`;
const SUFFIX = `,"format":"${FORMAT}","version":1}`;
export const MAX_FILE_BYTES =
  MAX_BYTES + encoder.encode(PREFIX + SUFFIX).length;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = ["note", "bookmark", "excerpt", "answer"];

function requireValue(ok, code) {
  if (!ok) throw new Error(code);
}
function keys(value, fields) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "fields",
  );
  requireValue(
    Object.keys(value).sort().join(",") === [...fields].sort().join(","),
    "fields",
  );
}
function string(value, max = MAX_BYTES) {
  requireValue(
    typeof value === "string" && value.length <= max && value.isWellFormed(),
    "string",
  );
}
function integer(value, min = 0) {
  requireValue(Number.isSafeInteger(value) && value >= min, "integer");
}
function hash(value) {
  requireValue(typeof value === "string" && HASH.test(value), "id");
}
function part(value) {
  keys(value, ["cid", "page"]);
  requireValue(
    typeof value.cid === "string" && /^[1-9][0-9]{0,19}$/.test(value.cid),
    "cid",
  );
  integer(value.page, 1);
}

// Canonical JSON: lexicographic object keys, caller-ordered arrays, no whitespace.
// Only call on the fixed-depth, whitelisted schema after validation at ingress.
export function canonical(value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
function ordered(rows) {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
// Validated JSON only: compare content without allocating full backup strings.
function sameContent(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameContent(value, right[index]));
  }
  const fields = Object.keys(left);
  return fields.length === Object.keys(right).length
    && fields.every(key => Object.hasOwn(right, key) && sameContent(left[key], right[key]));
}
export function logicalBytes(rows) {
  // Array order does not affect byte size. Count per record without allocating
  // a second, whole-backup UTF-8 buffer (including the single-large-record case).
  let bytes = 2 + Math.max(0, rows.length - 1);
  for (const row of rows) {
    const text = canonical(row);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) bytes++;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    }
  }
  return bytes;
}

export function validateAsset(row) {
  keys(row, [
    "id",
    "kind",
    "createdAt",
    "updatedAt",
    "video",
    "part",
    "personal",
    "snapshot",
    "bookmarkMs",
    "importedFrom",
  ]);
  hash(row.id);
  requireValue(TYPES.includes(row.kind), "kind");
  integer(row.createdAt);
  integer(row.updatedAt, row.createdAt);
  keys(row.video, ["bvid", "title"]);
  requireValue(
    typeof row.video.bvid === "string" &&
      /^BV[a-zA-Z0-9]{10}$/.test(row.video.bvid),
    "bvid",
  );
  string(row.video.title, 4096);
  if (row.part !== null) part(row.part);
  keys(row.personal, ["title", "note", "tags"]);
  string(row.personal.title, 4096);
  string(row.personal.note);
  requireValue(
    Array.isArray(row.personal.tags) && row.personal.tags.length <= 64,
    "tags",
  );
  row.personal.tags.forEach((tag) => string(tag, 256));
  requireValue(
    new Set(row.personal.tags).size === row.personal.tags.length,
    "tags",
  );
  if (row.importedFrom !== null) {
    keys(row.importedFrom, ["id", "digest", "original"]);
    hash(row.importedFrom.id);
    hash(row.importedFrom.digest);
    string(row.importedFrom.original);
  }
  if (row.kind === "bookmark") {
    requireValue(row.part !== null, "bookmark_part");
    integer(row.bookmarkMs);
  } else requireValue(row.bookmarkMs === null, "bookmark");
  if (row.kind === "note" || row.kind === "bookmark") {
    requireValue(row.snapshot === null, "snapshot");
    return;
  }
  requireValue(row.part !== null, "source_part");
  keys(row.snapshot, ["origin", "body", "source", "citations"]);
  const snapshot = row.snapshot;
  requireValue(
    (row.kind === "answer" && snapshot.origin === "answer") ||
      (row.kind === "excerpt" &&
        ["subtitle", "summary", "highlights"].includes(snapshot.origin)),
    "origin",
  );
  string(snapshot.body);
  requireValue(snapshot.body.length > 0, "body");
  keys(snapshot.source, ["kind", "hash"]);
  requireValue(["bilibili", "local"].includes(snapshot.source.kind), "source");
  hash(snapshot.source.hash);
  requireValue(
    Array.isArray(snapshot.citations) &&
      snapshot.citations.length > 0 &&
      snapshot.citations.length <= 4096,
    "citations",
  );
  for (const span of snapshot.citations) {
    keys(span, ["fromMs", "toMs", "text"]);
    requireValue(
      Number.isSafeInteger(span.fromMs) &&
        span.fromMs >= 0 &&
        Number.isSafeInteger(span.toMs) &&
        span.toMs > span.fromMs,
      "range",
    );
    string(span.text);
    requireValue(span.text.length > 0, "citation_text");
  }
}

export function validateAssets(rows) {
  requireValue(
    Array.isArray(rows) && rows.length <= MAX_ASSETS,
    "capacity_count",
  );
  const ids = new Set();
  for (const row of rows) {
    validateAsset(row);
    requireValue(!ids.has(row.id), "duplicate_id");
    ids.add(row.id);
  }
  const bytes = logicalBytes(rows);
  requireValue(bytes <= MAX_BYTES, "capacity_bytes");
  return bytes;
}

export function assertCapture(row, evidence) {
  validateAsset(row);
  if (row.kind === "note") return;
  requireValue(
    evidence &&
      row.video.bvid === evidence.bvid &&
      canonical(row.part) === canonical(evidence.part),
    "stale_capture",
  );
  if (row.kind === "bookmark") {
    requireValue(
      evidence.positionMs === row.bookmarkMs &&
        row.bookmarkMs <= evidence.durationMs,
      "bookmark_position",
    );
    return;
  }
  requireValue(
    canonical(row.snapshot.source) === canonical(evidence.source),
    "stale_capture",
  );
  requireValue(
    row.snapshot.citations.every((span) =>
      evidence.spans.some((current) => canonical(span) === canonical(current)),
    ),
    "citation",
  );
  if (row.snapshot.origin === "subtitle") {
    requireValue(
      row.snapshot.body ===
        row.snapshot.citations.map((span) => span.text).join("\n"),
      "excerpt_body",
    );
  } else {
    requireValue(
      evidence.validated &&
        canonical(evidence.validated) ===
          canonical({
            origin: row.snapshot.origin,
            body: row.snapshot.body,
            citations: row.snapshot.citations,
          }),
      "unvalidated_answer",
    );
  }
}

export async function encodeBackup(rows, { signal, onPhase } = {}) {
  cancelled(signal);
  onPhase?.("before-encode");
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled(signal);
  onPhase?.("encoding");
  validateAssets(rows);
  for (const row of rows) await validateImportIdentity(row);
  const encoded = PREFIX + canonical(ordered(rows)) + SUFFIX;
  // Let a queued Worker cancellation run before publishing the export.
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled(signal);
  return encoded;
}
function cancelled(signal) {
  requireValue(!signal?.aborted, "cancelled");
}

export function parseBoundedBackupJson(text) {
  requireValue(
    typeof text === "string" && text.length <= MAX_FILE_BYTES,
    "file_size",
  );
  // This is a resource guard, not a JSON parser. Native JSON.parse and the
  // existing schema/canonical checks remain authoritative for valid syntax.
  // Legal backup depth is envelope/assets/asset/snapshot/citations/span (6).
  // Each asset has at most 9 non-span containers; every span costs >=30 bytes.
  const containerLimit = 2 + MAX_ASSETS * 9 + Math.floor(MAX_BYTES / 30);
  const stack = [];
  let containers = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
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
      // No legal schema array contains another array directly.
      requireValue(
        !(char === "[" && stack.at(-1)?.kind === "["),
        "json_resource_limit",
      );
      containers++;
      requireValue(
        stack.length < 6 && containers <= containerLimit,
        "json_resource_limit",
      );
      stack.push({ kind: char, entries: 1 });
    } else if (char === "}" || char === "]") {
      const frame = stack.pop();
      requireValue(frame?.kind === (char === "}" ? "{" : "["), "invalid_json");
    } else if (char === "," && stack.length) {
      const frame = stack.at(-1);
      frame.entries++;
      requireValue(
        frame.entries <= (frame.kind === "[" ? 4096 : 11),
        "json_resource_limit",
      );
    }
  }
  return JSON.parse(text);
}

export async function decodeBackup(file, { signal, onPhase } = {}) {
  cancelled(signal);
  requireValue(
    Number.isSafeInteger(file.size) &&
      file.size >= 0 &&
      file.size <= MAX_FILE_BYTES,
    "file_size",
  );
  const bytes = await file.arrayBuffer();
  cancelled(signal);
  requireValue(bytes.byteLength === file.size, "file_size");
  onPhase?.("decoding");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const data = parseBoundedBackupJson(text);
  keys(data, ["format", "version", "assets"]);
  requireValue(data.format === FORMAT && data.version === 1, "format");
  // Exact encoding also rejects duplicate JSON keys, reordered assets and padded files.
  requireValue(
    (await encodeBackup(data.assets, { signal })) === text,
    "noncanonical_backup",
  );
  cancelled(signal);
  return data.assets;
}

async function sha256(text) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function mergeAssets(local, incoming) {
  return mergeOwnedAssets(structuredClone(local), structuredClone(incoming));
}

// Both inputs are owned by this operation; sharing unchanged row references
// avoids cloning the same backup at every merge/CAS layer.
async function mergeOwnedAssets(local, incoming) {
  validateAssets(local);
  validateAssets(incoming);
  for (const row of [...local, ...incoming]) await validateImportIdentity(row);
  const result = new Map(local.map((row) => [row.id, row]));
  for (const row of ordered(incoming)) {
    const current = result.get(row.id);
    if (!current) {
      result.set(row.id, row);
      continue;
    }
    if (sameContent(current, row)) continue;
    const original = canonical(row);
    const digest = await sha256(original);
    const id = await sha256("lg0-import:" + row.id + ":" + digest);
    const importedFrom = { id: row.id, digest, original };
    const existing = result.get(id);
    if (existing) {
      requireValue(
        canonical(existing.importedFrom) === canonical(importedFrom),
        "import_identity_collision",
      );
      continue;
    }
    result.set(id, { ...row, id, importedFrom });
  }
  const rows = ordered([...result.values()]);
  validateAssets(rows);
  return rows;
}

async function validateImportIdentity(row) {
  if (!row.importedFrom) return;
  const receipt = row.importedFrom;
  const original = parseBoundedBackupJson(receipt.original);
  validateAsset(original);
  requireValue(
    canonical(original) === receipt.original && original.id === receipt.id,
    "import_identity",
  );
  requireValue(
    (await sha256(receipt.original)) === receipt.digest,
    "import_identity",
  );
  requireValue(
    (await sha256("lg0-import:" + receipt.id + ":" + receipt.digest)) ===
      row.id,
    "import_identity",
  );
  // Personal edits are allowed; every immutable field must still match the
  // retained original. The original personal content is retained and counted too.
  const immutable = (value) => {
    const { id, personal, updatedAt, importedFrom, ...rest } = value;
    return canonical(rest);
  };
  requireValue(immutable(original) === immutable(row), "import_identity");
}

export async function restore(db, epoch, incoming, options = {}) {
  const captured = structuredClone(incoming);
  return change(db, epoch, (rows) => mergeOwnedAssets(rows, captured), options);
}

export async function saveCapture(db, epoch, row, evidence, options = {}) {
  // Capture is checked both before work and immediately before commit. Production
  // adapters must supply live evidence, never a backup snapshot as current proof.
  const captured = structuredClone(row);
  validateAsset(captured);
  requireValue(captured.importedFrom === null, "capture_import_identity");
  cancelled(options.signal);
  const state = await readState(db);
  requireValue(state.meta.epoch === epoch, "stale_epoch");
  const saved = state.assets.find((item) => item.id === captured.id);
  if (saved) {
    requireValue(
      canonical(saved) === canonical(captured),
      "save_identity_conflict",
    );
    return state.assets;
  }
  let creating = true;
  return change(
    db,
    epoch,
    (rows) => {
      const existing = rows.find((item) => item.id === captured.id);
      creating = !existing;
      if (existing) {
        requireValue(
          canonical(existing) === canonical(captured),
          "save_identity_conflict",
        );
        return rows;
      }
      assertCapture(captured, evidence());
      return [...rows, captured];
    },
    {
      ...options,
      beforeWrite: () => {
        if (creating) assertCapture(captured, evidence());
      },
    },
  );
}

export async function editPersonal(db, epoch, id, personal, updatedAt) {
  return change(db, epoch, (rows) => {
    requireValue(
      rows.some((row) => row.id === id),
      "not_found",
    );
    return rows.map((row) =>
      row.id === id
        ? { ...row, personal: structuredClone(personal), updatedAt }
        : row,
    );
  });
}

export async function openLab(
  name,
  legacyStores = {},
  { failUpgrade = false } = {},
) {
  requireValue(
    typeof name === "string" && /^lg0-[a-zA-Z0-9-]+$/.test(name),
    "lab_database_only",
  );
  const db = new Dexie(name);
  if (Object.keys(legacyStores).length) db.version(13).stores(legacyStores);
  db.version(14)
    .stores({ lgAssets: "id", lgMeta: "key" })
    .upgrade(() => {
      if (failUpgrade) throw new Error("injected_upgrade_failure");
    });
  await db.open();
  return db;
}
export async function readState(db) {
  return db.transaction("r", db.lgAssets, db.lgMeta, async () => ({
    assets: await db.lgAssets.toArray(),
    meta: (await db.lgMeta.get("state")) ?? {
      key: "state",
      epoch: 0,
      revision: 0,
    },
  }));
}

// Expensive validation/hash work stays outside IDB; revision CAS retries prevent
// lost updates and capacity races, while the caller's epoch fences cleared drafts.
export async function change(db, epoch, transform, options = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    options.onPhase?.("preparing");
    cancelled(options.signal);
    const before = await readState(db);
    requireValue(before.meta.epoch === epoch, "stale_epoch");
    const rows = ordered(await transform(structuredClone(before.assets)));
    validateAssets(rows);
    for (const row of rows) await validateImportIdentity(row);
    const previous = new Map(before.assets.map((row) => [row.id, row]));
    const put = rows.filter((row) => {
      const old = previous.get(row.id);
      previous.delete(row.id);
      return !old || !sameContent(old, row);
    });
    const remove = [...previous.keys()];
    // Worker callers yield here so cancellation queued during synchronous
    // parsing/validation is observed before the atomic commit begins.
    await options.beforeCommit?.();
    cancelled(options.signal);
    options.onPhase?.("committing");
    cancelled(options.signal);
    const applied = await db.transaction(
      "rw",
      db.lgAssets,
      db.lgMeta,
      async () => {
        const current = (await db.lgMeta.get("state")) ?? {
          key: "state",
          epoch: 0,
          revision: 0,
        };
        requireValue(current.epoch === epoch, "stale_epoch");
        if (current.revision !== before.meta.revision) return false;
        options.beforeWrite?.();
        const changed = remove.length > 0 || put.length > 0;
        if (changed) integer(current.revision + 1);
        if (remove.length) await db.lgAssets.bulkDelete(remove);
        if (put.length) await db.lgAssets.bulkPut(put);
        if (options.afterWrite) await Dexie.waitFor(options.afterWrite());
        if (options.fault === "abort") throw new Error("injected_abort");
        if (options.fault === "quota")
          throw new DOMException("injected_quota", "QuotaExceededError");
        if (changed)
          await db.lgMeta.put({ ...current, revision: current.revision + 1 });
        return true;
      },
    );
    if (applied) {
      options.onPhase?.("committed");
      return rows;
    }
  }
  throw new Error("busy_retry");
}
export async function clearKnowledge(db) {
  await db.transaction("rw", db.lgAssets, db.lgMeta, async () => {
    const current = (await db.lgMeta.get("state")) ?? {
      key: "state",
      epoch: 0,
      revision: 0,
    };
    integer(current.epoch + 1);
    integer(current.revision + 1);
    await db.lgAssets.clear();
    await db.lgMeta.put({
      key: "state",
      epoch: current.epoch + 1,
      revision: current.revision + 1,
    });
  });
}

export async function search(db, query, filters = {}) {
  string(query, 256);
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const { assets } = await readState(db);
  return assets
    .filter((row) => {
      if (filters.kind && row.kind !== filters.kind) return false;
      if (filters.bvid && row.video.bvid !== filters.bvid) return false;
      const fields = [
        row.personal.title,
        row.personal.note,
        ...row.personal.tags,
        row.video.title,
        row.snapshot?.body ?? "",
        ...(row.snapshot?.citations.map((span) => span.text) ?? []),
      ].map((text) => text.normalize("NFKC").toLowerCase());
      return terms.every((term) =>
        fields.some((field) => field.includes(term)),
      );
    })
    .map((row) => row.id)
    .sort();
}
