import { digest, type Report } from './engine.ts';

// This continuation accepts only the user-supplied, audited 32-call export.
// It is not an arbitrary report/configuration import API.
export const APPROVED_SEED_SHA256 = 'bcd840008d46222c39b6af41f9788207721fdbba03ba8e95bc9c73fe3cde739f';
export async function parseSeed(text: string): Promise<Report> {
  if (await digest(text) !== APPROVED_SEED_SHA256) throw Error('EVAL_SEED_CONFLICT');
  const { frozenManifest: _manifest, cases: _cases, ...report } = JSON.parse(text);
  return report as Report;
}

export function reconcileSeed(existing: Report | undefined, seed: Report): Report {
  if (!existing?.rows.some(row => row.attempted)) return seed;
  for (const row of seed.rows.filter(row => row.attempted)) {
    const saved = existing.rows.find(saved => saved.id === row.id);
    if (!saved) throw Error('EVAL_SEED_CONFLICT');
    for (const key of Object.keys(row) as Array<keyof typeof row>) {
      // Later manual review is allowed, but charged attempts and usage cannot change.
      if (key !== 'grade' && JSON.stringify(saved[key]) !== JSON.stringify(row[key])) throw Error('EVAL_SEED_CONFLICT');
    }
  }
  if (existing.configStamp !== seed.configStamp || existing.datasetHash !== seed.datasetHash) throw Error('EVAL_SEED_CONFLICT');
  return existing;
}
