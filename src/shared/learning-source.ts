import { learningAssert, type LearningSnapshot, type LearningSourceRequest } from "./learning.ts";
import { normalizeTextLines } from "./current-video-primary-text.ts";
import type { CurrentVideoTranscriptSegment } from "./types/current-video-transcript.ts";
import type { CurrentVideoSummaryHighlightsResult } from "./types/current-video-summary.ts";
import type { CurrentVideoQaSessionTurn } from "./types/current-video-qa-session.ts";

export function buildLearningSnapshot(request: LearningSourceRequest, source: LearningSnapshot["source"], segments: CurrentVideoTranscriptSegment[], result?: CurrentVideoSummaryHighlightsResult | CurrentVideoQaSessionTurn): LearningSnapshot {
  learningAssert(segments.length > 0 && segments.every(segment => !segment.stale && segment.sourceIdentityKey === request.sourceIdentityKey), "stale_capture");
  let body: string;
  let selected: { startSeconds: number; endSeconds: number; text: string }[];
  if (request.origin === "subtitle") {
    learningAssert(Array.isArray(request.segmentIds) && request.segmentIds.length > 0 && request.segmentIds.length <= 4096 && new Set(request.segmentIds).size === request.segmentIds.length, "citation");
    selected = request.segmentIds.map(id => {
      const segment = segments.find(row => row.segmentId === id);
      learningAssert(segment && segment.endSeconds > segment.startSeconds && segment.text.length > 0, "stale_capture");
      return segment;
    }).sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
    body = selected.map(line => line.text).join("\n");
  } else {
    learningAssert(result && result.status === "ready", "unvalidated_answer");
    let references: number[];
    if (request.origin === "answer") {
      learningAssert("answer" in result && result.turnId === request.turnId && result.requestId === request.requestId
        && result.source?.sourceIdentityKey === request.sourceIdentityKey && result.ai.status === "generated", "stale_capture");
      body = result.answer;
      references = result.citations.flatMap(citation => citation.evidenceLineNumbers);
    } else {
      learningAssert("summarySentences" in result && result.current && result.cacheKey === request.cacheKey && result.generatedAt === request.generatedAt && result.ai.status === "generated", "stale_capture");
      if (request.origin === "summary") {
        const items = [...result.summarySentences, ...result.keyPoints];
        learningAssert(items.every(item => item.evidenceLineNumbers.length > 0), "citation");
        body = [...result.summarySentences.map(item => item.text), ...result.keyPoints.map(item => item.text)].join("\n");
        references = items.flatMap(item => item.evidenceLineNumbers);
      } else {
        learningAssert(request.origin === "highlights" && result.highlights.every(item => item.evidenceLineNumbers.length > 0), "citation");
        body = result.highlights.map(item => `${item.title}\n${item.description}`).join("\n\n");
        references = result.highlights.flatMap(item => item.evidenceLineNumbers);
      }
    }
    const lines = normalizeTextLines(segments);
    learningAssert(references.length > 0, "citation");
    selected = [...new Set(references)].sort((a, b) => a - b).map(number => {
      const line = lines.find(item => item.lineNo === number);
      learningAssert(line, "citation");
      return line;
    });
  }
  learningAssert(body.length > 0, "body");
  return { origin: request.origin, body, source, citations: selected.map(line => ({ fromMs: Math.round(line.startSeconds * 1000), toMs: Math.round(line.endSeconds * 1000), text: line.text })) };
}
