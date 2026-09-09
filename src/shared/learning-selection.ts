import { learningAssert, type LearningSourceRequest, type LearningSnapshot } from './learning.ts';
import type { CurrentVideoSubtitleViewingSource } from './current-video-subtitle-view.ts';

// Offsets refer to displayed normalized line text, never to a guessed model citation.
export function resolveLearningSelection(request: LearningSourceRequest, view: CurrentVideoSubtitleViewingSource): LearningSnapshot {
  const selection = request.subtitleSelection;
  learningAssert(selection && Array.isArray(selection.lines) && selection.lines.length > 0 && selection.lines.length <= 32, 'stale_capture');
  learningAssert(view.identity.sourceIdentityKey === request.sourceIdentityKey, 'stale_capture');
  const startIndex = view.lines.findIndex(line => line.lineId === selection.lines[0].id);
  const lines = view.lines.slice(startIndex, startIndex + selection.lines.length);
  learningAssert(startIndex >= 0 && lines.length === selection.lines.length && lines.every((line, i) => line.lineId === selection.lines[i].id && line.lineBindingKey === selection.lines[i].binding), 'stale_capture');
  learningAssert(Number.isSafeInteger(selection.start) && Number.isSafeInteger(selection.end)
    && selection.start >= 0 && selection.start < lines[0].text.length
    && selection.end > 0 && selection.end <= lines.at(-1)!.text.length
    && (lines.length > 1 || selection.end > selection.start), 'stale_capture');
  const citations = lines.map((line, i) => ({ fromMs: Math.round(line.startSeconds * 1000), toMs: Math.round(line.endSeconds * 1000),
    text: line.text.slice(i === 0 ? selection.start : 0, i === lines.length - 1 ? selection.end : undefined) })).filter(line => line.text.trim());
  const body = citations.map(line => line.text).join('\n');
  learningAssert(body.trim() && body.length <= 4000, 'stale_capture');
  return { origin: 'subtitle', body, source: { kind: 'bilibili', hash: view.identity.sourceHash }, citations };
}
