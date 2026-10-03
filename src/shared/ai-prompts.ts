import { stableDigestHex } from './stable-digest.ts';

export const AI_PROMPTS_KEY = 'learningAiPrompts';
export const PROMPT_FEATURES = ['overview', 'chat', 'subtitles', 'image'] as const;
export type PromptFeature = typeof PROMPT_FEATURES[number];
export const PROMPT_LABELS: Record<PromptFeature, string> = { overview: '视频概览', chat: '学习对话', subtitles: '字幕优化', image: '图片解读' };
export const DEFAULT_PROMPTS: Record<PromptFeature, string> = {
  overview: '用简短中文介绍核心问题和结论。摘要概括全貌，要点解释值得回看的观点或演示，避免两部分重复。',
  chat: '像学习伙伴一样直接回答，先说明结论，再解释原因和例子。区分视频内容、知识库依据与拓展知识，按需要追问。',
  subtitles: '优先补全标点和阅读断句，仅修正有充分上下文支持的明显错字。保留说话人的语气、术语和不确定表达。',
  image: '先描述图片中确实可见的内容，再解释与学习问题有关的信息。看不清时说明，不把附近字幕当作画面事实。',
};
export interface PromptState {
  revision: string;
  values: Partial<Record<PromptFeature, string>>;
  previous: Partial<Record<PromptFeature, string | null>>;
}
export interface PromptSnapshot extends PromptState { configRevision: string }
export function promptFeature(value: unknown): PromptFeature {
  if (!PROMPT_FEATURES.includes(value as PromptFeature)) throw Error('PROMPT_INPUT');
  return value as PromptFeature;
}
export function validatePrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000 || /\u0000/.test(value)) throw Error('PROMPT_INPUT');
  return value.trim();
}
export function normalizePromptState(value: unknown): PromptState {
  if (!value) return { revision: '', values: {}, previous: {} };
  const row = value as PromptState;
  if (typeof row.revision !== 'string' || row.revision.length > 64 || !row.values || !row.previous) throw Error('PROMPT_INPUT');
  const values: PromptState['values'] = {}, previous: PromptState['previous'] = {};
  for (const feature of PROMPT_FEATURES) {
    if (row.values[feature] !== undefined) values[feature] = validatePrompt(row.values[feature]);
    if (row.previous[feature] !== undefined) previous[feature] = row.previous[feature] === null ? null : validatePrompt(row.previous[feature]);
  }
  return { revision: row.revision, values, previous };
}
export const promptText = (state: PromptState, feature: PromptFeature) => state.values[feature] ?? DEFAULT_PROMPTS[feature];
export const promptFingerprint = (state: PromptState, feature: PromptFeature) => state.values[feature] ? stableDigestHex(promptText(state, feature)) : '';
export function withPromptPreference(contract: string, preference: string): string {
  return `用户的表达偏好（仅在不违背下面的来源、授权与输出格式规则时使用）：\n${validatePrompt(preference)}\n\n固定规则：\n${contract}`;
}
