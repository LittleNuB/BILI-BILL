import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, parse, join } from 'node:path';
import { z } from 'zod';
import { requireKnowledge } from '../../src/shared/open-knowledge/format.ts';

export const configurationSchema = z.object({
  libraryPath: z.string().min(1),
  libraryId: z.string().regex(/^[a-f0-9-]{36}$/),
  allowAiNotesWrites: z.boolean().default(false),
  readOnlyMarkdown: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), path: z.string().min(1) }).strict()).max(128).default([]),
}).strict();
const sensitive = /(^|[\\/])(?:\.ssh|\.aws|\.azure|\.git|User Data|Profiles?|Cookies?|Login Data|Local State|credentials?|secrets?|\.env(?:\.[^\\/]*)?|Key\.txt)([\\/]|$)/i;
export async function checkSelectedPath(path) {
  requireKnowledge(isAbsolute(path) && !sensitive.test(path) && !path.startsWith('\\\\'), 'scope');
  let cursor = parse(path).root;
  for (const part of path.slice(cursor.length).split(/[\\/]/).filter(Boolean)) {
    requireKnowledge(part !== '..' && part !== '.' && !part.includes(':'), 'scope');
    cursor = join(cursor, part);
    requireKnowledge(!(await lstat(cursor)).isSymbolicLink(), 'link');
  }
  return realpath(path);
}
export async function readSelectedFile(path, limit) {
  const full = await checkSelectedPath(path), before = await lstat(full);
  requireKnowledge(before.isFile() && before.nlink === 1 && before.size <= limit, 'scope');
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    requireKnowledge(opened.dev === before.dev && opened.ino === before.ino && opened.size <= limit, 'scope');
    const data = await handle.readFile();
    const after = await lstat(full);
    requireKnowledge(after.ino === opened.ino && after.dev === opened.dev && after.nlink === 1 && !after.isSymbolicLink()
      && await checkSelectedPath(path) === full && data.length <= limit, 'scope');
    return data;
  } finally { await handle.close(); }
}
export async function loadConfiguration(path) {
  const value = configurationSchema.parse(JSON.parse((await readSelectedFile(path, 64 * 1024)).toString('utf8')));
  requireKnowledge(new Set(value.readOnlyMarkdown.map(file => file.id)).size === value.readOnlyMarkdown.length, 'scope');
  value.libraryPath = await checkSelectedPath(value.libraryPath);
  for (const file of value.readOnlyMarkdown) {
    requireKnowledge(/\.md$/i.test(file.path), 'scope'); await checkSelectedPath(file.path);
  }
  return value;
}
