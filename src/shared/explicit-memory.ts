import type { CurrentVideoQaSessionRecord } from './types/current-video-qa-session.ts';

export const MEMORY_MAX_ITEMS = 32;
export const MEMORY_MAX_SELECTED = 6;
export const MEMORY_MAX_TEXT_BYTES = 512;
export const MEMORY_MAX_BYTES = 32 * 1024;
export interface ExplicitMemory {
  id: string;
  kind: 'goal' | 'preference';
  text: string;
  selected: boolean;
  originSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MemoryState { key: 'state'; revision: number; items: ExplicitMemory[] }
export interface MemoryDraft { id?: string; kind: 'goal' | 'preference'; text: string; selected: boolean; originSessionId?: string | null }
export type MemoryOperation = { op: 'read' } | { op: 'save'; revision: number; draft: MemoryDraft }
  | { op: 'remove'; revision: number; id: string } | { op: 'clear'; revision: number };
export const emptyMemory = (): MemoryState => ({ key: 'state', revision: 0, items: [] });
export function memoryAssert(value: unknown, code = 'MEMORY_INVALID'): asserts value { if (!value) throw Error(code); }
export function memoryBytes(value: unknown) { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export function validateMemoryDraft(value: MemoryDraft): MemoryDraft {
  memoryAssert(value && (value.kind === 'goal' || value.kind === 'preference') && typeof value.text === 'string' && typeof value.selected === 'boolean');
  const text = value.text.trim();
  memoryAssert(text && new TextEncoder().encode(text).byteLength <= MEMORY_MAX_TEXT_BYTES, 'MEMORY_TEXT_LIMIT');
  memoryAssert(!/(?:sk-[\w-]{8,}|gh[pousr]_[\w]{10,}|github_pat_[\w]{10,}|-----BEGIN[^\n]*PRIVATE KEY|Bearer\s+[\w.\/-]{8,}|(?:password|passwd|api[_ -]?key|access[_ -]?token|secret|cookie|密码|密钥|令牌|口令|登录凭据)\s*[:：=是为]\s*\S+)/i.test(text), 'MEMORY_SECRET');
  memoryAssert(value.id === undefined || (typeof value.id === 'string' && /^[\w-]{1,80}$/.test(value.id)));
  memoryAssert(value.originSessionId == null || (typeof value.originSessionId === 'string' && value.originSessionId.trim().length > 0 && value.originSessionId.length <= 200));
  return { id: value.id, kind: value.kind, text, selected: value.selected, originSessionId: value.originSessionId ?? null };
}
export function memoryGrant(value: unknown): string | null {
  const item = value as { enabled?: unknown; generation?: unknown } | null;
  return item?.enabled === true && typeof item.generation === 'string' && item.generation.length > 0 && item.generation.length <= 64 ? item.generation : null;
}
export function memorySafeSession(session: CurrentVideoQaSessionRecord | null, stamp: string | null) {
  const first = session?.turns.findIndex(turn => turn.memoryStamp && turn.memoryStamp !== stamp) ?? -1;
  return first < 0 ? { session, omitted: false }
    : { session: { ...session!, turns: session!.turns.slice(0, first), learningContext: undefined }, omitted: true };
}
export function memoryError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code.includes('MEMORY_SECRET')) return '不要保存密码、密钥或登录信息。请删除敏感内容。';
  if (code.includes('MEMORY_TEXT_LIMIT')) return '请填写简短目标或偏好，最多 512 字节（约 170 个汉字）。';
  if (code.includes('MEMORY_CAPACITY')) return '最多保存 32 项，同时选用 6 项。请先取消选用或删除其他记忆。';
  if (code.includes('MEMORY_STALE')) return '记忆已在其他页面更新。请刷新后重试，当前输入仍保留。';
  if (code.includes('MEMORY_SESSION_GONE')) return '原会话已删除，本次未保存。';
  return '记忆操作未完成，请重试。';
}
