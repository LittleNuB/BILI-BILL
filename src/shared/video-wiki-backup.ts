import {
  LEARNING_MAX_FILE_BYTES,
  decodeLearningBackup,
  encodeLearningBackup,
  learningNotCancelled,
  learningYield,
} from './learning-backup.ts';
import { learningAssert, type LearningAsset } from './learning.ts';
import {
  WIKI_MAX_BYTES,
  WIKI_MAX_PAGES,
  WIKI_MAX_RELATIONS,
  WIKI_MAX_TOPICS,
  validateWiki,
  type WikiState,
} from './video-wiki.ts';

const encoder = new TextEncoder();
const OUTER_FORMAT = 'bili-bill-learning-wiki';
const OUTER_VERSION = 1;
const OUTER_PREFIX = `{"format":"${OUTER_FORMAT}","version":${OUTER_VERSION},"learning":`;
const OUTER_WIKI = ',"wiki":';
const OUTER_SUFFIX = '}';

export const WIKI_MAX_FILE_BYTES = LEARNING_MAX_FILE_BYTES + WIKI_MAX_BYTES + 1024;

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  learningAssert(
    value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === [...keys].sort().join(','),
    'wiki_format',
  );
}

function canonicalWiki(state: WikiState): WikiState {
  validateWiki(state);
  const canonical: WikiState = {
    key: 'state',
    revision: state.revision,
    pages: [...state.pages]
      .sort((left, right) => compare(left.bvid, right.bvid))
      .map(page => ({ bvid: page.bvid, createdAt: page.createdAt, deleted: page.deleted })),
    topics: [...state.topics]
      .sort((left, right) => compare(left.id, right.id))
      .map(topic => ({ id: topic.id, name: topic.name, term: topic.term })),
    relations: [...state.relations]
      .sort((left, right) => compare(left.topicId, right.topicId)
        || compare(left.bvid, right.bvid)
        || compare(left.mode, right.mode))
      .map(relation => ({ topicId: relation.topicId, bvid: relation.bvid, mode: relation.mode })),
  };
  validateWiki(canonical);
  return canonical;
}

// This is only a resource guard. The exact re-encoding check below rejects
// duplicate keys, whitespace, reordered fields, and any other noncanonical form.
function parseWikiBackupJson(text: string): unknown {
  const stack: { kind: string; entries: number }[] = [];
  const containerLimit = 3
    + WIKI_MAX_PAGES
    + WIKI_MAX_TOPICS
    + WIKI_MAX_RELATIONS
    + 9_000
    + Math.floor(LEARNING_MAX_FILE_BYTES / 30);
  let containers = 0;
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') {
      learningAssert(!(char === '[' && stack.at(-1)?.kind === '['), 'json_resource_limit');
      containers++;
      learningAssert(stack.length < 7 && containers <= containerLimit, 'json_resource_limit');
      stack.push({ kind: char, entries: 1 });
    } else if (char === '}' || char === ']') {
      learningAssert(stack.pop()?.kind === (char === '}' ? '{' : '['), 'invalid_json');
    } else if (char === ',' && stack.length) {
      const frame = stack.at(-1)!;
      frame.entries++;
      learningAssert(frame.entries <= (frame.kind === '[' ? WIKI_MAX_RELATIONS : 11), 'json_resource_limit');
    }
  }
  return JSON.parse(text);
}

export async function encodeWikiBackup(
  assets: LearningAsset[],
  state: WikiState,
  signal?: AbortSignal,
): Promise<string> {
  learningNotCancelled(signal);
  const learning = await encodeLearningBackup(assets, signal);
  const wiki = canonicalWiki(state);
  learningNotCancelled(signal);
  const text = OUTER_PREFIX + learning + OUTER_WIKI + JSON.stringify(wiki) + OUTER_SUFFIX;
  learningAssert(encoder.encode(text).byteLength <= WIKI_MAX_FILE_BYTES, 'file_size');
  await learningYield();
  learningNotCancelled(signal);
  return text;
}

export async function decodeWikiBackup(
  file: Blob,
  signal?: AbortSignal,
): Promise<{ assets: LearningAsset[]; wiki: WikiState | null }> {
  learningNotCancelled(signal);
  learningAssert(
    Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= WIKI_MAX_FILE_BYTES,
    'file_size',
  );
  const bytes = await file.arrayBuffer();
  learningNotCancelled(signal);
  learningAssert(bytes.byteLength === file.size, 'file_size');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const data = parseWikiBackupJson(text) as Record<string, unknown> | null;

  if (data?.format === 'bili-bill-learning') {
    return { assets: await decodeLearningBackup(file, signal), wiki: null };
  }

  exact(data, ['format', 'version', 'learning', 'wiki']);
  learningAssert(data.format === OUTER_FORMAT && data.version === OUTER_VERSION, 'wiki_format');
  const wiki = canonicalWiki(data.wiki as WikiState);
  const learning = JSON.stringify(data.learning);
  const assets = await decodeLearningBackup(
    new Blob([learning], { type: 'application/json' }),
    signal,
  );
  learningNotCancelled(signal);
  learningAssert((await encodeWikiBackup(assets, wiki, signal)) === text, 'noncanonical_backup');
  return { assets, wiki };
}
