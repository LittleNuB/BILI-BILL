import { buildCurrentVideoFullTextRequestEnvelope } from '../../shared/current-video-primary-text.ts';
import { buildCurrentVideoSummaryHighlightsAiPayload, buildCurrentVideoSummaryHighlightsMessages, validateCurrentVideoSummaryHighlightsAiOutput } from '../../shared/current-video-summary-highlights.ts';
import { buildLearningChatMessages, type LearningChatMessage } from '../../shared/learning-chat.ts';
import { correctionBatches, parseCorrection, SUBTITLE_CORRECTION_PROMPT } from '../../shared/subtitle-correction.ts';
import { withPromptPreference, promptText, type PromptState } from '../../shared/ai-prompts.ts';
import { IMAGE_GROUNDING_PROMPT } from '../../shared/image-grounding-prompt.ts';
import type { CurrentVideoQaSessionRecord } from '../../shared/types/current-video-qa-session.ts';
import { requireValue, type Material, type Report, type Step } from './contract.ts';

export function envelope(material: Material, model: string, step: Step) {
  return buildCurrentVideoFullTextRequestEnvelope({ requestId: step.id, submittedAt: 0, operation: 'summary_highlights', model,
    video: { ...material.target, cid: material.cid, title: material.title }, source: material.source, sourceType: material.sourceType,
    sourceLabel: 'B站字幕', language: material.language, lines: material.lines });
}
export function subtitleBatch(material: Material, step: Step) {
  const batch = correctionBatches(material.lines.map(l => ({ id: String(l.lineNo), text: l.text })))[step.subtitleBatch ?? -1];
  requireValue(batch?.length, 'ACCEPTANCE_SUBTITLE_BATCH'); return batch;
}
export function prepare(report: Report, step: Step, model: string, prompts: PromptState, contextBudget?: number): LearningChatMessage[] {
  const material = report.materials[step.target]; requireValue(material, 'ACCEPTANCE_MATERIAL_REQUIRED');
  let messages: LearningChatMessage[];
  if (step.feature === 'overview') {
    messages = buildCurrentVideoSummaryHighlightsMessages(buildCurrentVideoSummaryHighlightsAiPayload(envelope(material, model, step)));
    messages[0].content = withPromptPreference(messages[0].content, promptText(prompts, 'overview'));
  } else if (step.feature === 'subtitles') messages = [
    { role: 'system', content: withPromptPreference(SUBTITLE_CORRECTION_PROMPT, promptText(prompts, 'subtitles')) },
    { role: 'user', content: JSON.stringify(subtitleBatch(material, step)) },
  ];
  else {
    const turns: Array<{ question: string; answer: string; status: 'invalid_output'; source: null }> = [];
    let prior = step.after;
    while (prior) {
      const row = report.rows.find(r => r.id === prior), previous = report.plan.steps.find(s => s.id === prior)!;
      requireValue(row?.state === 'complete' && !!row.text.trim(), 'ACCEPTANCE_HISTORY_REQUIRED');
      turns.unshift({ question: previous.question!, answer: row.text, status: 'invalid_output', source: null });
      prior = previous.after;
    }
    if (step.feature === 'image') requireValue(material.frame, 'ACCEPTANCE_FRAME_REQUIRED');
    const lines = step.feature === 'image' ? material.lines.filter(l => l.startSeconds <= material.frame!.timeMs / 1000 + 15 && l.endSeconds >= material.frame!.timeMs / 1000 - 15) : material.lines;
    messages = buildLearningChatMessages({ question: step.question!, session: { turns } as CurrentVideoQaSessionRecord,
      budget: report.plan.contextBytes ?? contextBudget,
      videoText: lines.map(l => l.text).join('\n'), videoTitle: `${material.title}（第${material.target.page}P，B站字幕）`,
      videoNotice: step.feature === 'image' ? `以下为实际截图 ${material.frame!.timeMs / 1000} 秒附近的讲解，不是画面事实：` : '以下为本次冻结的 B站字幕，可能有识别错误：',
      preference: promptText(prompts, 'chat'), imagePreference: step.feature === 'image' ? promptText(prompts, 'image') : undefined });
    if (step.feature === 'image') messages[0].content += IMAGE_GROUNDING_PROMPT;
  }
  requireValue(new TextEncoder().encode(JSON.stringify(messages)).length <= (report.plan.contextBytes ?? 64000), 'ACCEPTANCE_INPUT_BUDGET');
  return messages;
}
export function checkOutput(report: Report, step: Step, text: string, parsed: unknown, model: string) {
  const failures: string[] = [], material = report.materials[step.target];
  if (!text.trim()) failures.push('empty_output');
  try {
    if (step.feature === 'overview') {
      const json = JSON.parse(text), result = validateCurrentVideoSummaryHighlightsAiOutput(parsed ?? json, envelope(material, model, step));
      if (!result.ok) failures.push(result.reason);
      if (Object.keys(json).some(k => !['summarySentences', 'keyPoints', 'highlights'].includes(k))) failures.push('extra_root_field');
      const summaries = (json.summarySentences ?? []).map((s: { text: string }) => s.text);
      if ((json.highlights ?? []).some((h: { description: string }) => summaries.includes(h.description))) failures.push('verbatim_summary_highlight_duplicate');
    } else if (step.feature === 'subtitles') {
      const batch = subtitleBatch(material, step); parseCorrection(text, batch);
      const json = JSON.parse(text);
      if (Object.keys(json).join() !== 'lines' || json.lines.some((l: object) => Object.keys(l).some(k => !['id', 'text'].includes(k)))) failures.push('extra_fields');
    } else {
      if (/^\s*[{[]/.test(text) && (() => { try { JSON.parse(text); return true; } catch { return false; } })()) failures.push('json_in_prose');
      if (/^\s*```[\s\S]*```\s*$/.test(text) && text.match(/```/g)?.length === 2) failures.push('whole_answer_code_fence');
      if (/<(?:script|iframe|html)\b/i.test(text)) failures.push('html_output');
      if (/\[\d+\]/.test(text)) failures.push('unprovided_knowledge_reference');
      if (/\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(text)) failures.push('timestamp_requires_review');
    }
  } catch { failures.push('invalid_format'); }
  return { format: !failures.length, failures: [...new Set(failures)] };
}
