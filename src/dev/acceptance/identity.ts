import type { Material, Plan, Target } from './contract.ts';

export const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map(n => n.toString(16).padStart(2, '0')).join('');
export function canonicalJson(value: unknown): string {
  const ordered = (item: any): any => Array.isArray(item) ? item.map(ordered)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, ordered(item[key])])) : item;
  return JSON.stringify(ordered(value));
}
const target = (t: Target) => ({ id: t.id, bvid: t.bvid, page: t.page });

// Early packages hashed insertion order. Reconstruct their published layout and
// require its exact original digest; do not replace historical hashes or fees.
export async function planHashMatches(plan: Plan, hash: string): Promise<boolean> {
  if (hash === await digest(canonicalJson(plan))) return true;
  const legacy = { version: plan.version, id: plan.id, targets: plan.targets.map(target), outputTokens: plan.outputTokens,
    steps: plan.steps.map(s => ({ id: s.id, target: s.target, feature: s.feature,
      ...(s.question === undefined ? {} : { question: s.question }), ...(s.after === undefined ? {} : { after: s.after }),
      ...(s.subtitleBatch === undefined ? {} : { subtitleBatch: s.subtitleBatch }) })),
    ...(plan.contextBytes === undefined ? {} : { contextBytes: plan.contextBytes }), ...(plan.reuseFrom === undefined ? {} : { reuseFrom: plan.reuseFrom }) };
  return canonicalJson(plan) === canonicalJson(legacy) && hash === await digest(JSON.stringify(legacy));
}
export async function materialHashMatches(material: Material): Promise<boolean> {
  const { hash, ...body } = material;
  if (hash === await digest(canonicalJson(body))) return true;
  const legacy = { version: body.version, target: target(body.target), cid: body.cid, title: body.title, capturedAt: body.capturedAt,
    build: { sourceCommit: body.build.sourceCommit, buildHash: body.build.buildHash }, source: body.source, sourceType: body.sourceType,
    language: body.language, evidence: body.evidence,
    lines: body.lines.map(l => ({ lineNo: l.lineNo, startSeconds: l.startSeconds, endSeconds: l.endSeconds, text: l.text })),
    ...(body.frame ? { frame: { data: body.frame.data, timeMs: body.frame.timeMs, capturedAt: body.frame.capturedAt, sha256: body.frame.sha256 } } : {}) };
  return canonicalJson(body) === canonicalJson(legacy) && hash === await digest(JSON.stringify(legacy));
}
