// Only prose fields are eligible for display. Model metadata never becomes a citation.
export function readableModelOutput(output: unknown, kind: 'qa' | 'summary'): string {
  const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
  const itemText = (value: unknown): string => {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const item = value as Record<string, unknown>;
    return [text(item.title), text(item.text) || text(item.description)].filter(Boolean).join('\n');
  };
  const list = (value: unknown): string => Array.isArray(value) ? value.map(itemText).filter(Boolean).join('\n\n') : itemText(value);
  let result = '';
  if (typeof output === 'string') {
    const plain = output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return readableModelOutput(JSON.parse(plain), kind); } catch { result = plain; }
  } else if (output && typeof output === 'object') {
    const record = output as Record<string, unknown>;
    result = kind === 'qa'
      ? list(record.answerPoints) || text(record.answer) || text(record.content) || text(record.text)
      : [list(record.summarySentences) || list(record.summary), list(record.keyPoints), list(record.highlights)].filter(Boolean).join('\n\n') || text(record.content) || text(record.text);
  }
  return result
    .replace(/\b(?:subtitle_url|sourceHash|segmentIds?|sourceIdentityKey|apiKey|access_token|authorization)\s*["']?\s*[:=]\s*[^\n,}]+/gi, '内部信息已隐藏')
    .replace(/\b(?:fallback|transcript|confidence|sourceHash|segmentIds?|subtitle_url)\b/gi, '内部字段')
    .trim();
}
