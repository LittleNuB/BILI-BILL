import { CASES, CASESET_VERSION, type EvalCase } from './cases.ts';
import { envelopeFor, prepareCase } from './prepare.ts';
import { validateCurrentVideoSummaryHighlightsAiOutput } from '../../shared/current-video-summary-highlights.ts';
import { parseCorrection } from '../../shared/subtitle-correction.ts';
import type { LearningChatMessage } from '../../shared/learning-chat.ts';
import type { AiResponseObservation } from '../../shared/ai-response-observation.ts';
import { OUTPUT_LIMITS, TOKEN_RESERVATION, measuredTokens, tokenBudget, type OutputLimit } from './budget.ts';

export type Variant = 'baseline' | 'candidate';
export interface Grade {
  scores: [number, number, number, number, number]; hardFactsPass: boolean; severe: boolean;
  cause: 'none' | 'prompt' | 'model' | 'transport' | 'parser'; notes: string; reviewer: string;
}
export interface Row {
  id: string; caseId: string; variant: Variant; retryOf?: string; reason?: string;
  state: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  attempted?: boolean; startedAt?: string; elapsedMs?: number; model?: string;
  messages?: LearningChatMessage[]; promptHash?: string; inputHash?: string;
  text?: string; parsed?: unknown; observation?: AiResponseObservation;
  sourceCommit?: string; buildHash?: string;
  error?: string; checks?: { format: boolean; failures: string[] }; grade?: Grade;
  parameters?: unknown; evaluationKind?: 'initial_comparison' | 'repair_regression'; tokenReservation?: number;
}
export interface Report {
  version: 1; dataset: string; sourceCommit: string; buildHash: string; datasetHash: string; baselineCommit: string;
  createdAt: string; syntheticMaterials: true; realModelAcceptance: 'not_completed' | 'review_required' | 'reviewed';
  configStamp?: string; parameters?: unknown; rows: Row[];
  builds?: Array<{ sourceCommit: string; buildHash: string }>;
  outputTokens?: OutputLimit;
}
export const MAX_CALLS = 48;
export function createReport(binding: Pick<Report, 'sourceCommit' | 'buildHash' | 'datasetHash' | 'baselineCommit'>): Report {
  return { ...binding, version: 1, dataset: CASESET_VERSION, createdAt: new Date().toISOString(), syntheticMaterials: true,
    realModelAcceptance: 'not_completed', builds: [{ sourceCommit: binding.sourceCommit, buildHash: binding.buildHash }], rows: CASES.flatMap((item, i) =>
      // Counterbalance order; baseline does not always get the first provider call.
      ((i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) as Variant[]).map(variant =>
        ({ id: `${item.id}:${variant}`, caseId: item.id, variant, state: 'queued' }))) };
}
export const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
  .map(n => n.toString(16).padStart(2, '0')).join('');
export function checkOutput(item: EvalCase, text: string, parsed?: unknown): Row['checks'] {
  const failures: string[] = [];
  if (!text.trim()) failures.push('empty_output');
  try {
    if (item.feature === 'overview') {
      const json = JSON.parse(text);
      const validation = validateCurrentVideoSummaryHighlightsAiOutput(parsed ?? json, envelopeFor(item));
      if (!validation.ok) failures.push(validation.reason);
      for (const key of Object.keys(json)) if (!['summarySentences', 'keyPoints', 'highlights'].includes(key)) failures.push('extra_root_field');
      for (const [group, allowed] of [['summarySentences', ['text', 'evidenceLineNumbers']], ['keyPoints', ['text', 'evidenceLineNumbers']], ['highlights', ['title', 'description', 'evidenceLineNumbers']]] as const) {
        for (const entry of Array.isArray(json[group]) ? json[group] : []) if (Object.keys(entry).some(key => !allowed.includes(key as never))) failures.push('extra_item_field');
      }
      const summaries = (json.summarySentences ?? []).map((r: any) => r.text);
      if ((json.highlights ?? []).some((r: any) => summaries.includes(r.description))) failures.push('verbatim_summary_highlight_duplicate');
    } else if (item.feature === 'subtitles') {
      const lines = item.text.map((text, i) => ({ id: String(i + 1), text }));
      parseCorrection(text, lines);
      const json = JSON.parse(text);
      if (Object.keys(json).join() !== 'lines' || json.lines.some((line: any, i: number) => line.id !== lines[i]?.id || Object.keys(line).some(key => !['id', 'text'].includes(key)))) failures.push('line_order_or_extra_fields');
    } else {
      if (/^\s*[{[]/.test(text) && (() => { try { JSON.parse(text); return true; } catch { return false; } })()) failures.push('json_in_prose');
      if (/^\s*```[\s\S]*```\s*$/.test(text) && text.match(/```/g)?.length === 2) failures.push('whole_answer_code_fence');
      if (/<(?:script|iframe|html)\b/i.test(text)) failures.push('html_output');
      if (item.knowledge) {
        const refs = [...text.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
        if (!refs.includes(1)) failures.push('missing_knowledge_reference');
        if (refs.some(n => n !== 1)) failures.push('unknown_knowledge_reference');
      }
    }
  } catch { failures.push('invalid_format'); }
  return { format: failures.length === 0, failures: [...new Set(failures)] };
}
export function validateGrade(value: Grade): Grade {
  if (!value || !Array.isArray(value.scores) || value.scores.length !== 5 || value.scores.some(n => ![0, 1, 2].includes(n))
    || typeof value.severe !== 'boolean' || typeof value.hardFactsPass !== 'boolean'
    || !['none', 'prompt', 'model', 'transport', 'parser'].includes(value.cause)
    || typeof value.notes !== 'string' || !value.notes.trim() || value.notes.length > 4000
    || typeof value.reviewer !== 'string' || !value.reviewer.trim() || value.reviewer.length > 80) throw Error('EVAL_GRADE');
  return { scores: [...value.scores], hardFactsPass: value.hardFactsPass, severe: value.severe, cause: value.cause, notes: value.notes.trim(), reviewer: value.reviewer.trim() };
}
export function verdict(row: Row): 'pass' | 'fail' | 'unreviewed' {
  if (!row.grade) return 'unreviewed';
  return row.state === 'complete' && row.checks?.format && row.grade.hardFactsPass && !row.grade.severe
    && row.grade.scores.reduce((a, b) => a + b, 0) >= 8 ? 'pass' : 'fail';
}
export function recoverReport(report: Report): Report {
  for (const row of report.rows) if (row.attempted && row.parameters === undefined) row.parameters = structuredClone(report.parameters);
  for (const row of report.rows) if (row.state === 'running') { row.state = 'interrupted'; row.error = 'EVAL_INTERRUPTED'; }
  return report;
}
export interface Executor {
  (item: EvalCase, messages: LearningChatMessage[], signal: AbortSignal, onText: (text: string) => void,
    onResponse: (value: AiResponseObservation) => void, row: Row): Promise<unknown>;
}
export class EvalEngine {
  report: Report; private active: AbortController | null = null; private busy = false;
  constructor(report: Report, privateDeps: {
    baseline: Record<string, LearningChatMessage[]>; save: (report: Report) => Promise<void>; execute: Executor;
    build?: { sourceCommit: string; buildHash: string };
    current: () => Promise<{ stamp: string; model: string; imageModel: string; vision: boolean; parameters: unknown }>;
  }) { this.report = recoverReport(report); this.deps = privateDeps; }
  private deps: {
    baseline: Record<string, LearningChatMessage[]>; save: (report: Report) => Promise<void>; execute: Executor;
    build?: { sourceCommit: string; buildHash: string };
    current: () => Promise<{ stamp: string; model: string; imageModel: string; vision: boolean; parameters: unknown }>;
  };
  stop() { this.active?.abort(); }
  get running() { return this.busy; }
  async setOutputTokens(value: number) {
    if (this.busy) throw Error('EVAL_BUSY');
    if (!OUTPUT_LIMITS.includes(value as OutputLimit)) throw Error('EVAL_INPUT');
    if (this.report.rows.slice(0, 32).some(row => row.attempted) && this.report.rows.slice(0, 32).some(row => !row.attempted)) throw Error('EVAL_CONFIG_CHANGED');
    this.report.outputTokens = value as OutputLimit;
    await this.deps.save(this.report);
  }
  async grade(id: string, grade: Grade) {
    if (this.busy) throw Error('EVAL_BUSY');
    const row = this.report.rows.find(row => row.id === id);
    if (!row || !row.attempted || row.state === 'running') throw Error('EVAL_ROW');
    row.grade = validateGrade(grade);
    this.report.realModelAcceptance = this.report.rows.slice(0, 32).every(row => row.attempted && row.grade) ? 'reviewed' : 'review_required';
    await this.deps.save(this.report);
  }
  async retry(id: string, reason: string) {
    if (this.busy) throw Error('EVAL_BUSY');
    if (this.report.rows.length >= MAX_CALLS || typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw Error('EVAL_LIMIT');
    const prior = this.report.rows.find(row => row.id === id);
    if (!prior?.attempted || prior.state === 'running' || this.report.rows.some(row => row.state === 'queued')) throw Error('EVAL_ROW');
    const next: Row = { id: `${prior.caseId}:${prior.variant}:${this.report.rows.length + 1}`, caseId: prior.caseId, variant: prior.variant,
      retryOf: prior.id, reason, state: 'queued' };
    this.report.rows.push(next); await this.deps.save(this.report); await this.run();
  }
  async run() {
    if (this.busy) throw Error('EVAL_BUSY');
    this.busy = true; const controller = new AbortController(); this.active = controller;
    try {
      for (const row of this.report.rows) {
        if (controller.signal.aborted) break;
        if (row.state !== 'queued') continue;
        const item = CASES.find(item => item.id === row.caseId)!;
        const config = await this.deps.current();
        if (this.report.configStamp && config.stamp !== this.report.configStamp) throw Error('EVAL_CONFIG_CHANGED');
        if (!config.vision) throw Error('EVAL_VISION_DISABLED');
        if (controller.signal.aborted) break;
        if (tokenBudget(this.report.rows).remaining < TOKEN_RESERVATION) throw Error('EVAL_TOKEN_BUDGET');
        if (!row.retryOf && this.report.rows.some(previous => previous.attempted)
          && JSON.stringify(this.report.parameters) !== JSON.stringify(config.parameters)) throw Error('EVAL_CONFIG_CHANGED');
        this.report.configStamp = config.stamp; this.report.parameters ??= structuredClone(config.parameters);
        if (this.report.rows.filter(row => row.attempted).length >= MAX_CALLS) throw Error('EVAL_LIMIT');
        const messages = structuredClone(row.variant === 'baseline' ? this.deps.baseline[item.id] : prepareCase(item));
        row.model = item.image ? config.imageModel : config.model;
        if (item.feature === 'overview') { const payload = JSON.parse(messages[1].content); payload.request.model = row.model; messages[1].content = JSON.stringify(payload); }
        row.messages = messages; row.promptHash = await digest(messages[0].content);
        if (new TextEncoder().encode(JSON.stringify(messages)).length > 64000) throw Error('EVAL_INPUT_BUDGET');
        row.parameters = structuredClone(config.parameters);
        row.evaluationKind = row.retryOf ? 'repair_regression' : 'initial_comparison';
        row.tokenReservation = TOKEN_RESERVATION;
        row.sourceCommit = this.deps.build?.sourceCommit ?? this.report.sourceCommit;
        row.buildHash = this.deps.build?.buildHash ?? this.report.buildHash;
        row.inputHash = await digest(JSON.stringify({ messages: messages.slice(1), image: item.image ?? null }));
        row.state = 'running'; row.attempted = true; row.startedAt = new Date().toISOString(); row.text = '';
        // Reserve the call before sending: a worker restart cannot accidentally resend it.
        await this.deps.save(this.report);
        if (controller.signal.aborted) { row.state = 'cancelled'; await this.deps.save(this.report); break; }
        const started = Date.now(); let lastCheckpoint = 0; let checkpoint = Promise.resolve();
        try {
          row.parsed = await this.deps.execute(item, messages, controller.signal, text => {
            row.text = text;
            if (Date.now() - lastCheckpoint >= 1000) {
              lastCheckpoint = Date.now();
              checkpoint = checkpoint.then(() => this.deps.save(this.report));
              // Retain completed chunks without letting a persistence failure leak an unhandled rejection.
              void checkpoint.catch(() => controller.abort());
            }
          }, observation => {
            row.observation = { model: observation.model ?? row.observation?.model ?? null,
              finishReason: observation.finishReason ?? row.observation?.finishReason ?? null,
              usage: { promptTokens: observation.usage.promptTokens ?? row.observation?.usage.promptTokens ?? null,
                completionTokens: observation.usage.completionTokens ?? row.observation?.usage.completionTokens ?? null,
                totalTokens: observation.usage.totalTokens ?? row.observation?.usage.totalTokens ?? null } };
          }, row);
          row.state = controller.signal.aborted ? 'cancelled' : 'complete';
          row.checks = checkOutput(item, row.text ?? '', row.parsed);
        } catch (error) {
          row.state = controller.signal.aborted ? 'cancelled' : 'failed';
          const code = error instanceof Error ? error.message : '';
          row.error = /^(CHAT_[A-Z_]+|AI_[A-Z_]+(?:_\d{3})?|EVAL_[A-Z_]+)$/.test(code) ? code : 'EVAL_REQUEST_FAILED';
        }
        row.elapsedMs = Date.now() - started;
        await checkpoint;
        this.report.realModelAcceptance = 'review_required';
        await this.deps.save(this.report);
        if (controller.signal.aborted || ['CHAT_AUTH', 'CHAT_BALANCE', 'AI_REQUEST_FAILED_401', 'AI_REQUEST_FAILED_402', 'AI_REQUEST_FAILED_403'].includes(row.error ?? '')) break;
        const used = measuredTokens(row);
        if (used === null) throw Error('EVAL_USAGE_UNKNOWN');
        if (used > TOKEN_RESERVATION) throw Error('EVAL_USAGE_EXCEEDED');
      }
    } finally { this.busy = false; this.active = null; }
  }
}
