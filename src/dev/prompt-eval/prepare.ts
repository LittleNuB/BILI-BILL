import { CASES, type EvalCase } from './cases.ts';
import { DEFAULT_PROMPTS, withPromptPreference } from '../../shared/ai-prompts.ts';
import { buildLearningChatMessages, type LearningChatMessage } from '../../shared/learning-chat.ts';
import { buildCurrentVideoFullTextRequestEnvelope } from '../../shared/current-video-primary-text.ts';
import { buildCurrentVideoSummaryHighlightsAiPayload, buildCurrentVideoSummaryHighlightsMessages } from '../../shared/current-video-summary-highlights.ts';
import { SUBTITLE_CORRECTION_PROMPT } from '../../shared/subtitle-correction.ts';
import { attachKnowledge } from '../../shared/knowledge-chat.ts';
import { IMAGE_GROUNDING_PROMPT } from '../../shared/image-grounding-prompt.ts';
import type { CurrentVideoQaSessionRecord } from '../../shared/types/current-video-qa-session.ts';

export function envelopeFor(item: EvalCase) {
  return buildCurrentVideoFullTextRequestEnvelope({
    requestId: item.id, operation: 'summary_highlights', submittedAt: 0, model: 'evaluation-model',
    video: { bvid: 'BV1Eval000001', cid: 1, page: 1, title: item.title, durationSeconds: item.text.length * 6 },
    source: 'local_transcript', sourceType: 'local_transcript', sourceLabel: '本地转录', language: 'zh-CN',
    lines: item.text.map((text, i) => ({ lineNo: i + 1, startSeconds: i * 6, endSeconds: (i + 1) * 6, text })),
  });
}
export function prepareCase(item: EvalCase): LearningChatMessage[] {
  if (item.feature === 'overview') {
    const messages = buildCurrentVideoSummaryHighlightsMessages(buildCurrentVideoSummaryHighlightsAiPayload(envelopeFor(item)));
    messages[0].content = withPromptPreference(messages[0].content, DEFAULT_PROMPTS.overview);
    return messages;
  }
  if (item.feature === 'subtitles') return [
    { role: 'system', content: withPromptPreference(SUBTITLE_CORRECTION_PROMPT, DEFAULT_PROMPTS.subtitles) },
    { role: 'user', content: JSON.stringify(item.text.map((text, i) => ({ id: String(i + 1), text }))) },
  ];
  // No persistence: fixed completed turns exercise the same production history builder.
  const session = item.history ? { turns: item.history.map(turn => ({ ...turn, status: 'invalid_output', source: null })) } as CurrentVideoQaSessionRecord : null;
  let messages = buildLearningChatMessages({ question: item.question, session, videoText: item.text.join('\n'),
    videoTitle: item.title, preference: DEFAULT_PROMPTS.chat,
    imagePreference: item.image ? DEFAULT_PROMPTS.image : undefined });
  if (item.knowledge) messages = attachKnowledge(messages, [{ number: 1, id: 'synthetic-note', title: '缓存顺序草稿',
    videoTitle: '', bvid: '', page: null, label: '个人笔记', excerpt: item.knowledge, digest: 'synthetic' }]).messages;
  if (item.image) messages[0].content += IMAGE_GROUNDING_PROMPT;
  return messages;
}
export function prepareAll() { return Object.fromEntries(CASES.map(item => [item.id, prepareCase(item)])); }
