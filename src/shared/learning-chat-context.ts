import type { CurrentVideoQaSessionRecord, CurrentVideoQaSessionTurn } from './types/current-video-qa-session.ts';
import { stableDigestHex } from './stable-digest.ts';

export const CHAT_CONTEXT_STATE_BYTES = 64 * 1024;
export interface ChatHistorySummary {
  turnIds: string[];
  digest: string;
  start: number;
  end: number;
  text: string;
}
export interface ChatVideoPart {
  start: number;
  end: number;
  status: 'pending' | 'complete' | 'failed';
  text: string;
}
export interface ChatContextState {
  version: 1;
  summaries: ChatHistorySummary[];
  historyProgress?: Array<{ turnId: string; digest: string; end: number }>;
  video: { digest: string; length: number; parts: ChatVideoPart[] } | null;
}
export const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

export function fitChatText(text: string, bytes: number): string {
  let low = 0; let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serializedBytes(text.slice(0, mid)) <= bytes) low = mid;
    else high = mid - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return text.slice(0, low);
}

export function chatTextParts(text: string, bytes: number, limit = 24): ChatVideoPart[] {
  const parts: ChatVideoPart[] = [];
  let start = 0;
  while (start < text.length && parts.length < limit) {
    let length = fitChatText(text.slice(start), bytes).length;
    if (!length) break;
    const newline = text.lastIndexOf('\n', start + length - 1);
    if (newline >= start + length * 0.7) length = newline + 1 - start;
    parts.push({ start, end: start + length, status: 'pending', text: '' });
    start += length;
  }
  return parts;
}

export function conversationTurns(session: CurrentVideoQaSessionRecord | null, retryTurnId?: string): CurrentVideoQaSessionTurn[] {
  const all = session?.turns ?? [];
  const index = all.findIndex(turn => turn.turnId === retryTurnId);
  return (index < 0 ? all : all.slice(0, index)).filter(turn => turn.status !== 'pending' && turn.answer.trim());
}
export function historyMaterial(turn: CurrentVideoQaSessionTurn): string {
  return `用户：${turn.question}\n助手（${turn.status === 'cancelled' || turn.status === 'error' ? '未完成；' : ''}非视频证据${turn.source?.title ? `；当时视频：${turn.source.title}` : ''}）：${turn.answer}`;
}
export function historyDigest(turns: CurrentVideoQaSessionTurn[]): string {
  return stableDigestHex(JSON.stringify(turns.map(turn => [turn.turnId, turn.requestId, turn.status, historyMaterial(turn)])));
}
export function validHistorySummary(summary: ChatHistorySummary, turns: CurrentVideoQaSessionTurn[]): boolean {
  const start = turns.findIndex(turn => turn.turnId === summary.turnIds[0]);
  const covered = turns.slice(start, start + summary.turnIds.length);
  return start >= 0 && summary.turnIds.length > 0 && covered.every((turn, i) => turn.turnId === summary.turnIds[i])
    && covered.length === summary.turnIds.length && historyDigest(covered) === summary.digest
    && summary.start >= 0 && summary.end > summary.start && summary.end <= covered.map(historyMaterial).join('\n\n').length;
}

export function readChatContextState(value: unknown): ChatContextState {
  const empty: ChatContextState = { version: 1, summaries: [], video: null };
  if (!value || typeof value !== 'object' || serializedBytes(value) > CHAT_CONTEXT_STATE_BYTES) return empty;
  const state = value as ChatContextState;
  if (state.version !== 1 || !Array.isArray(state.summaries) || state.summaries.length > 8) return empty;
  if (state.summaries.some(s => !s || !Array.isArray(s.turnIds) || !s.turnIds.length || s.turnIds.some(id => typeof id !== 'string')
    || !Number.isSafeInteger(s.start) || !Number.isSafeInteger(s.end)
    || typeof s.digest !== 'string' || typeof s.text !== 'string' || s.text.length > 1600 || serializedBytes(s.text) > 2400)) return empty;
  if (state.historyProgress && (!Array.isArray(state.historyProgress) || state.historyProgress.length > 8
    || state.historyProgress.some(p => !p || typeof p.turnId !== 'string' || typeof p.digest !== 'string' || !Number.isSafeInteger(p.end) || p.end < 1))) return empty;
  if (state.video) {
    const video = state.video;
    if (typeof video.digest !== 'string' || !Number.isSafeInteger(video.length) || video.length < 1 || !Array.isArray(video.parts) || video.parts.length > 24) return empty;
    if (video.parts.some((part, i) => !part || !Number.isSafeInteger(part.start) || !Number.isSafeInteger(part.end)
      || part.start !== (i ? video.parts[i - 1].end : 0) || part.end <= part.start || part.end > video.length
      || !['pending', 'complete', 'failed'].includes(part.status) || typeof part.text !== 'string' || serializedBytes(part.text) > 1400
      || (part.status === 'complete' && !part.text.trim()))) return empty;
  }
  return structuredClone(state);
}

export function wholeVideoQuestion(question: string): boolean {
  return /全片|全视频|整个视频|整段视频|总结|概括|梳理|summari[sz]e|whole video/i.test(question);
}

// Local lexical retrieval only. It never searches another conversation or invents relevance.
export function chatRelevance(question: string, text: string): number {
  const terms = [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(question.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment);
  const haystack = text.toLowerCase();
  return [...new Set(terms)].reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}
