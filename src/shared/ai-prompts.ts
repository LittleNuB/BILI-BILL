import { stableDigestHex } from './stable-digest.ts';

export const AI_PROMPTS_KEY = 'learningAiPrompts';
export const PROMPT_FEATURES = ['overview', 'chat', 'subtitles', 'image'] as const;
export type PromptFeature = typeof PROMPT_FEATURES[number];
export const PROMPT_LABELS: Record<PromptFeature, string> = { overview: '视频概览', chat: '学习对话', subtitles: '字幕优化', image: '图片解读' };
export const DEFAULT_PROMPTS: Record<PromptFeature, string> = {
  overview: [
    '面向正在学习的读者，用简洁中文说明视频讨论的问题、核心结论和关键理由。',
    '摘要概括全貌；要点提炼独立知识；亮点选择值得回看的论证、演示或转折，三者不要重复抄写。',
    '每条表达一个完整意思，保留重要前提与限制，不凑数量，不写空泛评价。',
    '严格遵守固定 JSON 结构和证据行要求，不加前言、Markdown 围栏或自行推算时间。',
  ].join('\n'),
  chat: [
    '你是中文学习伙伴。先直接回答当前问题，再按需要补充推理、例子或可操作步骤；连续追问只展开新问题，不重复整段背景。',
    '用可读 Markdown：短段落、必要的小标题和列表；代码用带语言的代码块。简单问题简短回答，复杂问题分层解释。',
    '清楚区分视频内容、知识库依据与拓展知识，只标出本次实际用到的类别。知识库引用紧邻对应论点，不把模型推理写成资料原话。',
    '信息不足时说明具体缺口；能回答的部分先回答，只有影响结论的歧义才追问。不虚构来源、操作结果或确定性。',
  ].join('\n'),
  subtitles: [
    '整理成便于阅读的字幕：补标点、规范中英文间距，仅修正由本句和相邻句能明确判断的识别错字。',
    '保留原意、语气、术语、否定与不确定表达；专有名词和数字没有充分依据就保留原文，不根据常识补全。',
    '保留每行身份及顺序，不合并拆分，不总结、翻译或扩写。无需修改的行也原样返回。',
    '仅输出固定 JSON 结构，不输出解释或 Markdown 围栏。',
  ].join('\n'),
  image: [
    '围绕用户的问题分析实际传入的图片，用中文 Markdown，先给出能从画面支持的直接回答。',
    '按需用「画面观察」「字幕依据」「拓展解释」小标题，省略未使用的类别；画面事实与推测分开。',
    '读图表先确认标题、图例、坐标与单位；读代码先指出可见逻辑；读文字保留关键术语。不要机械描述与问题无关的颜色和布局。',
    '局部文字、数字或细节看不清时指出具体位置，可请求清晰截图，不猜测。不把附近讲解当作当前帧可见事实。',
  ].join('\n'),
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
// Version the fixed contract as well as the effective preference, including defaults.
export const promptFingerprint = (state: PromptState, feature: PromptFeature) => stableDigestHex(JSON.stringify([
  feature === 'overview' || feature === 'image' ? 3 : 2, feature, promptText(state, feature),
]));
export function withPromptPreference(contract: string, preference: string): string {
  return `用户的表达偏好（仅在不违背下面的来源、授权与输出格式规则时使用）：\n${validatePrompt(preference)}\n\n固定规则：\n${contract}`;
}
