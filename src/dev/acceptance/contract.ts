import { measuredTokens, OUTPUT_LIMITS } from '../prompt-eval/budget.ts';
import { LEGACY_TOKENS, MAX_TOKEN_RESERVATION, TOKEN_RESERVATION, TOTAL_TOKEN_BUDGET } from './limits.ts';
import type { Grade } from '../prompt-eval/engine.ts';
import type { AiResponseObservation } from '../../shared/ai-response-observation.ts';
import type { CurrentVideoTextLine } from '../../shared/current-video-primary-text.ts';
import type { LearningChatMessage } from '../../shared/learning-chat.ts';
import { canonicalJson, digest } from './identity.ts';
export { digest } from './identity.ts';

export const PORT = 'bili-bill-acceptance-v1';
export const HOST = 'com.bili_bill.acceptance';
export const STORAGE = 'developerAcceptanceV1';
export const LEGACY = { calls: 32, tokens: LEGACY_TOKENS, callLimit: 48,
  sha256: 'bcd840008d46222c39b6af41f9788207721fdbba03ba8e95bc9c73fe3cde739f' } as const;
export type Feature = 'overview' | 'chat' | 'subtitles' | 'image';
export interface Target { id: string; bvid: string; page: number }
export interface Step { id: string; target: string; feature: Feature; question?: string; after?: string; subtitleBatch?: number; imageThinking?: 'low'; imageAnswer?: 'bounded_explanation' }
export interface RetainedUnknown { id: string; reservation: number }
export interface Plan { version: 1; id: string; targets: Target[]; steps: Step[]; outputTokens: 2048 | 8192 | 16384; contextBytes?: 32768 | 65536 | 131072; reuseFrom?: string; retainedUnknown?: RetainedUnknown[] }
export interface Build { sourceCommit: string; buildHash: string }
export interface Material {
  version: 1; target: Target; cid: number; title: string; capturedAt: string; build: Build;
  source: 'bilibili_subtitle'; sourceType: 'bilibili_player_v2' | 'bilibili_player_wbi_v2'; language: string | null;
  lines: Array<Required<CurrentVideoTextLine>>;
  frame?: { data: string; timeMs: number; capturedAt: number; sha256: string };
  hash: string; evidence: 'real_material' | 'mock';
}
export interface Attempt {
  id: string; target: string; feature: Feature; state: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  attempted: true; tokenReservation: number; startedAt: string; elapsedMs?: number; model: string;
  materialHash: string; build: Build; parameters: unknown; messages: LearningChatMessage[]; inputHash: string;
  text: string; displayText?: string; parsed?: unknown; observation?: AiResponseObservation; error?: string;
  checks?: { format: boolean; failures: string[] }; grade?: Grade;
}
export interface Report {
  version: 1; plan: Plan; planHash: string; createdAt: string; legacy: typeof LEGACY;
  materials: Record<string, Material>; rows: Attempt[]; pause: string | null;
  evidence: { mock: boolean; installedOffline: boolean; realModel: boolean; realSiteUi: 'not_run' };
  reviews: Array<{ rowId: string; at: string; grade: Grade }>;
  priorCharges: Array<{ planHash: string; calls: number; measured: number; reserved: number; unknown: number }>;
}
export function requireValue(ok: unknown, code = 'ACCEPTANCE_INPUT'): asserts ok { if (!ok) throw Error(code); }
export const safeError = (error: unknown) => error instanceof Error && /^(ACCEPTANCE_[A-Z_]+|CHAT_[A-Z_]+|AI_[A-Z_]+(?:_\d{3})?|CORRECTION_[A-Z_]+)$/.test(error.message)
  ? error.message : 'ACCEPTANCE_OPERATION_FAILED';
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function validatePlan(value: unknown): Plan {
  const p = value as Plan;
  const id = (s: unknown) => typeof s === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(s);
  requireValue(p && keys(p, ['version', 'id', 'targets', 'steps', 'outputTokens', 'contextBytes', 'reuseFrom', 'retainedUnknown']) && p.version === 1 && id(p.id));
  requireValue(p.contextBytes === undefined || [32768, 65536, 131072].includes(p.contextBytes));
  requireValue(p.reuseFrom === undefined || /^[a-f0-9]{64}$/.test(p.reuseFrom));
  if (p.retainedUnknown !== undefined) {
    requireValue(p.reuseFrom && Array.isArray(p.retainedUnknown) && p.retainedUnknown.length > 0 && p.retainedUnknown.length <= 16, 'ACCEPTANCE_RETRY_INPUT');
    const ids = new Set<string>();
    for (const charge of p.retainedUnknown) {
      requireValue(charge && keys(charge, ['id', 'reservation']) && /^[a-f0-9]{64}:[a-z][a-z0-9-]{0,63}$/.test(charge.id)
        && !ids.has(charge.id) && Number.isSafeInteger(charge.reservation) && charge.reservation >= TOKEN_RESERVATION
        && charge.reservation <= MAX_TOKEN_RESERVATION, 'ACCEPTANCE_RETRY_INPUT');
      ids.add(charge.id);
    }
  }
  requireValue(Array.isArray(p.targets) && p.targets.length > 0 && p.targets.length <= 2);
  requireValue(Array.isArray(p.steps) && p.steps.length > 0 && p.steps.length <= 16 && OUTPUT_LIMITS.includes(p.outputTokens));
  const targets = new Set<string>(), videos = new Set<string>(), steps = new Map<string, Step>();
  for (const t of p.targets) {
    requireValue(t && keys(t, ['id', 'bvid', 'page']) && id(t.id) && /^BV[a-zA-Z0-9]{10}$/.test(t.bvid)
      && Number.isSafeInteger(t.page) && t.page > 0 && t.page <= 1000 && !targets.has(t.id) && !videos.has(`${t.bvid}:${t.page}`));
    targets.add(t.id); videos.add(`${t.bvid}:${t.page}`);
  }
  for (const s of p.steps) {
    requireValue(s && keys(s, ['id', 'target', 'feature', 'question', 'after', 'subtitleBatch', 'imageThinking', 'imageAnswer']) && id(s.id)
      && !steps.has(s.id) && targets.has(s.target) && ['overview', 'chat', 'subtitles', 'image'].includes(s.feature));
    if (s.feature === 'chat' || s.feature === 'image') requireValue(typeof s.question === 'string' && !!s.question.trim() && s.question.length <= 2000);
    else requireValue(s.question === undefined);
    if (s.after !== undefined) requireValue(s.feature === 'chat' && steps.get(s.after)?.feature === 'chat' && steps.get(s.after)?.target === s.target);
    if (s.feature === 'subtitles') requireValue(Number.isSafeInteger(s.subtitleBatch) && s.subtitleBatch! >= 0 && s.subtitleBatch! <= 999);
    else requireValue(s.subtitleBatch === undefined);
    requireValue(s.imageThinking === undefined || (s.feature === 'image' && s.imageThinking === 'low'));
    requireValue(s.imageAnswer === undefined || (s.feature === 'image' && s.imageAnswer === 'bounded_explanation'));
    steps.set(s.id, s);
  }
  return structuredClone(p);
}
export function targetUrl(t: Target) { return `https://www.bilibili.com/video/${t.bvid}/?p=${t.page}`; }
export function matchesTarget(url: string | undefined, t: Target): boolean {
  try { const u = new URL(url ?? ''); return u.protocol === 'https:' && u.hostname === 'www.bilibili.com' && !u.username && !u.password
    && (u.pathname === `/video/${t.bvid}/` || u.pathname === `/video/${t.bvid}`) && (u.searchParams.get('p') ?? '1') === String(t.page); }
  catch { return false; }
}
export function budget(report: Report) {
  let measured = LEGACY.tokens as number, reserved = 0, unknown = 0;
  for (const prior of report.priorCharges) { measured += prior.measured; reserved += prior.reserved; unknown += prior.unknown; }
  for (const row of report.rows) {
    const used = measuredTokens(row);
    const reservation = row.tokenReservation ?? TOKEN_RESERVATION;
    requireValue(Number.isSafeInteger(reservation) && reservation >= TOKEN_RESERVATION && reservation <= MAX_TOKEN_RESERVATION, 'ACCEPTANCE_LEDGER_INVALID');
    if (row.state === 'running' || used === null) { reserved += reservation; unknown++; }
    else measured += used;
  }
  return { limit: TOTAL_TOKEN_BUDGET, measured, reserved, unknown, remaining: Math.max(0, TOTAL_TOKEN_BUDGET - measured - reserved),
    legacyCalls: LEGACY.calls, legacyCallLimit: LEGACY.callLimit, newCalls: report.rows.length, newCallLimit: report.plan.steps.length };
}
export async function createReport(plan: Plan): Promise<Report> {
  const valid = validatePlan(plan);
  return { version: 1, plan: valid, planHash: await digest(canonicalJson(valid)), createdAt: new Date().toISOString(), legacy: LEGACY,
    materials: {}, rows: [], pause: null, evidence: { mock: false, installedOffline: false, realModel: false, realSiteUi: 'not_run' }, reviews: [], priorCharges: [] };
}
export function inheritHistory(fresh: Report, previous: Report[]) {
  if (fresh.plan.retainedUnknown) {
    requireValue(fresh.plan.reuseFrom === previous.at(-1)?.planHash, 'ACCEPTANCE_RETRY_HISTORY');
    const unknown: RetainedUnknown[] = [];
    for (const report of previous) {
      requireValue(!report.pause || report.pause === 'ACCEPTANCE_USAGE_UNKNOWN', 'ACCEPTANCE_RETRY_BLOCKED');
      for (const row of report.rows) if (row.state === 'running' || measuredTokens(row) === null) {
        requireValue(row.state === 'failed' && row.error === 'CHAT_NETWORK', 'ACCEPTANCE_RETRY_BLOCKED');
        unknown.push({ id: `${report.planHash}:${row.id}`, reservation: row.tokenReservation ?? TOKEN_RESERVATION });
      }
    }
    const sorted = (charges: RetainedUnknown[]) => [...charges].sort((a, b) => a.id.localeCompare(b.id));
    requireValue(canonicalJson(sorted(unknown)) === canonicalJson(sorted(fresh.plan.retainedUnknown)), 'ACCEPTANCE_RETRY_HISTORY');
  }
  fresh.priorCharges = previous.map(r => {
    const b = budget({ ...r, priorCharges: [] });
    return { planHash: r.planHash, calls: r.rows.length, measured: b.measured - LEGACY.tokens, reserved: b.reserved, unknown: b.unknown };
  });
  if (fresh.plan.reuseFrom) {
    const prior = previous.find(r => r.planHash === fresh.plan.reuseFrom); requireValue(prior, 'ACCEPTANCE_FROZEN_PLAN_REQUIRED');
    for (const target of fresh.plan.targets) {
      const material = prior.materials[target.id];
      requireValue(material && canonicalJson(material.target) === canonicalJson(target), 'ACCEPTANCE_FROZEN_TARGET');
      fresh.materials[target.id] = structuredClone(material);
      fresh.evidence.mock ||= material.evidence === 'mock';
    }
  }
}
export function summary(report: Report) {
  return { planId: report.plan.id, planHash: report.planHash, budget: budget(report), pause: report.pause, evidence: report.evidence,
    materials: Object.values(report.materials).map(m => ({ target: m.target, hash: m.hash, cid: m.cid, lines: m.lines.length, frameTimeMs: m.frame?.timeMs ?? null })),
    rows: report.rows.map(r => ({ id: r.id, state: r.state, error: r.error, checks: r.checks, reviewed: !!r.grade })) };
}
