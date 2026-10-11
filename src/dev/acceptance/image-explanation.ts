import { IMAGE_CHAT_PROMPT } from '../../shared/image-grounding-prompt.ts';

// Explicit developer experiment, not an implicit mode for ordinary image/code questions.
export const IMAGE_EXPLANATION_PROMPT = [
  '本轮确实提供了图片。任务是简短解释画面，而非逐项转录。只输出一个 JSON 对象，中文字段内容为简短自然文字。',
  ...IMAGE_CHAT_PROMPT.split('\n').slice(1),
  'JSON 示例（仅为结构示意，不是本次画面事实）：{"purpose":"一句话说明画面用途","observations":["一项直接可见且相关的观察"],"captionRelation":"仅据附近字幕概括关联；推测需明说","limitations":"必要的具体缺口，没有则为空字符串"}。',
  '仅允许 purpose、observations、captionRelation、limitations 四个字段。purpose 最多80字符；observations为1至3项，每项最多80字符；captionRelation最多140字符；limitations最多100字符。全部字段内容总计不超过500字符。',
  '各字段为单段文字，不用嵌套列表、换行、标题、链接或时间戳，不重复其他字段。不要为了填满三项而补写细节。标识符只有清晰且直接相关时才引用；无需列界面计数、版本和文件清单。',
].join('\n');

export interface ImageExplanation { purpose: string; observations: string[]; captionRelation: string; limitations: string }
type Result = { ok: true; value: ImageExplanation; failures: [] } | { ok: false; value?: never; failures: string[] };
export function parseImageExplanation(raw: string): Result {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, failures: ['image_explanation_json'] }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, failures: ['image_explanation_fields'] };
  const item = value as Record<string, unknown>, fields = ['purpose', 'observations', 'captionRelation', 'limitations'];
  if (Object.keys(item).length !== fields.length || fields.some(key => !Object.hasOwn(item, key)))
    return { ok: false, failures: ['image_explanation_fields'] };
  const failures: string[] = [];
  const text = (v: unknown, limit: number, required: boolean) => typeof v === 'string' && (!required || !!v.trim()) && v.length <= limit;
  if (!text(item.purpose, 80, true) || !text(item.captionRelation, 140, false) || !text(item.limitations, 100, false)) failures.push('image_explanation_field_length');
  if (!Array.isArray(item.observations) || item.observations.length < 1 || item.observations.length > 3
    || item.observations.some(v => !text(v, 80, true))) failures.push('image_explanation_observations');
  if (failures.length) return { ok: false, failures };
  const answer = item as unknown as ImageExplanation;
  const parts = [answer.purpose, ...answer.observations, answer.captionRelation, answer.limitations];
  if (parts.reduce((n, v) => n + v.length, 0) > 500) failures.push('image_explanation_total_length');
  if (parts.some(v => /[\r\n]|^\s*(?:[-*#]|\d+[.)])|<[^>]+>|https?:\/\/|\[\d+\]|\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(v))) failures.push('image_explanation_plain_text');
  // These are shape checks only. A misspelled name or unsupported claim still requires material review.
  return failures.length ? { ok: false, failures } : { ok: true, value: answer, failures: [] };
}
export function renderImageExplanation(value: ImageExplanation): string {
  return [value.purpose, `画面观察\n${value.observations.map(v => `- ${v}`).join('\n')}`,
    value.captionRelation && `字幕与画面的关系\n${value.captionRelation}`,
    value.limitations && `限制\n${value.limitations}`].filter(Boolean).join('\n\n');
}
