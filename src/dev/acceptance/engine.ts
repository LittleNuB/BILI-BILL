import { measuredTokens } from '../prompt-eval/budget.ts';
import { MAX_TOKEN_RESERVATION, reservationFor } from './limits.ts';
import { chatBudget } from '../../shared/learning-chat.ts';
import { validateGrade, type Grade } from '../prompt-eval/engine.ts';
import type { PromptState } from '../../shared/ai-prompts.ts';
import type { AiResponseObservation } from '../../shared/ai-response-observation.ts';
import { budget, digest, requireValue, safeError, summary, type Attempt, type Build, type Material, type Report, type Step, type Target } from './contract.ts';
import { checkOutput, prepare } from './production.ts';
import { canonicalJson, materialHashMatches } from './identity.ts';
import { parseImageExplanation, renderImageExplanation } from './image-explanation.ts';

export interface Settings { stamp: string; model: string; imageModel: string; vision: boolean; prompts: PromptState; stream: boolean;
  contextBudget?: number; disableThinking?: { image: boolean; subtitles: boolean }; imageThinkingLow?: boolean; imageJsonOutput?: boolean }
interface Dependencies {
  build: Build; save: (report: Report) => Promise<void>; settings: () => Promise<Settings>;
  capture: (target: Target, frame: boolean, signal: AbortSignal) => Promise<Material>;
  execute: (row: Attempt, step: Step, material: Material, signal: AbortSignal, onText: (text: string) => void,
    onResponse: (observation: AiResponseObservation) => void) => Promise<unknown>;
}
export class AcceptanceEngine {
  readonly report: Report;
  private deps: Dependencies;
  private expires = 0;
  private controller: AbortController | null = null;
  private stamp: string | null = null;
  private revoked = true;
  constructor(report: Report, deps: Dependencies) {
    this.report = structuredClone(report); this.deps = deps;
    for (const row of this.report.rows) if (row.state === 'running') { row.state = 'interrupted'; row.error = 'ACCEPTANCE_INTERRUPTED'; this.report.pause = 'ACCEPTANCE_USAGE_UNKNOWN'; }
  }
  get busy() { return this.controller !== null; }
  get authorized() { return !this.revoked && Date.now() < this.expires; }
  async authorize(acknowledgeUnknown = false) {
    requireValue(!this.busy, 'ACCEPTANCE_BUSY');
    requireValue(!this.report.plan.retainedUnknown || acknowledgeUnknown === true, 'ACCEPTANCE_RETRY_ACKNOWLEDGEMENT');
    const settings = await this.deps.settings();
    this.stamp = settings.stamp; this.expires = Date.now() + 30 * 60 * 1000; this.revoked = false;
    return { expiresAt: new Date(this.expires).toISOString() };
  }
  stop() { this.controller?.abort(); }
  revoke() { this.revoked = true; this.stop(); }
  private check(signal?: AbortSignal) {
    requireValue(this.authorized && !signal?.aborted, 'ACCEPTANCE_REVOKED');
  }
  private async exclusive<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(); requireValue(!this.busy, 'ACCEPTANCE_BUSY');
    const controller = new AbortController(); this.controller = controller;
    const expiry = setTimeout(() => this.revoke(), Math.max(0, this.expires - Date.now()));
    try { return await run(controller.signal); } finally { clearTimeout(expiry); this.controller = null; }
  }
  async capture(id: string) {
    return this.exclusive(async signal => {
      const target = this.report.plan.targets.find(t => t.id === id); requireValue(target, 'ACCEPTANCE_TARGET');
      if (this.report.materials[id]) return summary(this.report);
      const material = await this.deps.capture(target, this.report.plan.steps.some(s => s.target === id && s.feature === 'image'), signal);
      this.check(signal);
      requireValue(canonicalJson(material.target) === canonicalJson(target) && Number.isSafeInteger(material.cid) && material.cid > 0, 'ACCEPTANCE_IDENTITY');
      requireValue(await materialHashMatches(material), 'ACCEPTANCE_MATERIAL_HASH');
      requireValue(material.lines.length > 0 && material.lines.length <= 20000 && new TextEncoder().encode(JSON.stringify(material.lines)).length <= 256000, 'ACCEPTANCE_MATERIAL_LIMIT');
      requireValue(material.lines.every((l, i) => l.lineNo === i + 1 && Number.isFinite(l.startSeconds) && l.startSeconds >= 0 && Number.isFinite(l.endSeconds)
        && l.endSeconds >= l.startSeconds && typeof l.text === 'string' && !!l.text.trim()), 'ACCEPTANCE_MATERIAL_INVALID');
      if (material.frame) requireValue(material.frame.sha256 === await digest(material.frame.data)
        && /^data:image\/(png|webp|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(material.frame.data) && material.frame.data.length <= 4000000
        && Number.isFinite(material.frame.timeMs) && material.frame.timeMs >= 0, 'ACCEPTANCE_FRAME_INVALID');
      this.report.materials[id] = structuredClone(material);
      this.report.evidence.mock ||= material.evidence === 'mock';
      await this.deps.save(this.report); return summary(this.report);
    });
  }
  async run(id: string) {
    return this.exclusive(async signal => {
      const step = this.report.plan.steps.find(s => s.id === id); requireValue(step, 'ACCEPTANCE_STEP');
      // A repeated command is a read of the existing attempt, never another charge.
      if (this.report.rows.some(row => row.id === id)) return summary(this.report);
      requireValue(!this.report.pause, this.report.pause ?? 'ACCEPTANCE_PAUSED');
      requireValue(budget(this.report).unknown === (this.report.plan.retainedUnknown?.length ?? 0), 'ACCEPTANCE_USAGE_UNKNOWN');
      const config = await this.deps.settings(); this.check(signal);
      requireValue(config.stamp === this.stamp, 'ACCEPTANCE_CONFIG_CHANGED');
      if (step.feature === 'image') requireValue(config.vision && config.imageModel, 'ACCEPTANCE_VISION_DISABLED');
      if (step.imageThinking) requireValue(config.imageThinkingLow, 'ACCEPTANCE_IMAGE_THINKING_UNSUPPORTED');
      if (step.imageAnswer) requireValue(config.imageJsonOutput, 'ACCEPTANCE_IMAGE_JSON_UNSUPPORTED');
      const model = step.feature === 'image' ? config.imageModel : config.model;
      const material = this.report.materials[step.target]; requireValue(material, 'ACCEPTANCE_MATERIAL_REQUIRED');
      requireValue(await materialHashMatches(material), 'ACCEPTANCE_MATERIAL_HASH');
      const messages = prepare(this.report, step, model, config.prompts, config.contextBudget);
      const inputBytes = new TextEncoder().encode(JSON.stringify(messages)).length;
      const maxOutputTokens = step.feature === 'subtitles' ? 6000 : this.report.plan.outputTokens;
      const reservation = reservationFor(inputBytes, maxOutputTokens);
      requireValue(reservation <= MAX_TOKEN_RESERVATION && budget(this.report).remaining >= reservation, 'ACCEPTANCE_TOKEN_BUDGET');
      const row: Attempt = { id, target: step.target, feature: step.feature, state: 'running', attempted: true, tokenReservation: reservation,
        startedAt: new Date().toISOString(), model, materialHash: material.hash, build: this.deps.build, messages,
        inputHash: await digest(canonicalJson({ messages, material: material.hash })), text: '',
        parameters: { temperature: step.imageThinking ? null : step.feature === 'overview' ? 0.2 : 0.3,
          max_tokens: maxOutputTokens, inputBytes,
          inputByteLimit: this.report.plan.contextBytes ?? 64000,
          contextBytes: ['chat', 'image'].includes(step.feature) ? this.report.plan.contextBytes ?? chatBudget(config.contextBudget) : null,
          contextSource: this.report.plan.contextBytes === undefined ? 'configured' : 'plan',
          thinking: step.imageThinking ? 'enabled' : (step.feature === 'image' || step.feature === 'subtitles') && config.disableThinking?.[step.feature] ? 'disabled' : 'provider_default',
          ...(step.imageThinking ? { reasoning_effort: step.imageThinking } : {}),
          ...(step.imageAnswer ? { imageAnswer: step.imageAnswer } : {}),
          stream: !['overview', 'subtitles'].includes(step.feature) && config.stream,
          response_format: step.feature === 'overview' || step.imageAnswer ? 'json_object' : null } };
      this.report.rows.push(row);
      // Durable reservation before invoking the provider. Save failure never sends a request.
      try { await this.deps.save(this.report); } catch { this.report.pause = 'ACCEPTANCE_STORAGE_FAILED'; throw Error('ACCEPTANCE_STORAGE_FAILED'); }
      const started = Date.now(); let checkpoint = Promise.resolve(), last = 0;
      try {
        this.check(signal);
        row.parsed = await this.deps.execute(row, step, material, signal, text => {
          row.text = text;
          if (Date.now() - last >= 1000) {
            last = Date.now(); const copy = structuredClone(this.report);
            checkpoint = checkpoint.then(() => this.deps.save(copy));
            void checkpoint.catch(() => this.stop());
          }
        }, next => {
          row.observation = { model: next.model ?? row.observation?.model ?? null, finishReason: next.finishReason ?? row.observation?.finishReason ?? null,
            usage: { totalTokens: next.usage.totalTokens ?? row.observation?.usage.totalTokens ?? null,
              promptTokens: next.usage.promptTokens ?? row.observation?.usage.promptTokens ?? null,
              completionTokens: next.usage.completionTokens ?? row.observation?.usage.completionTokens ?? null } };
        });
        row.state = signal.aborted ? 'cancelled' : 'complete';
        row.checks = checkOutput(this.report, step, row.text, row.parsed, model);
        if (step.imageAnswer && row.checks.format && row.state === 'complete') {
          const explanation = parseImageExplanation(row.text);
          if (explanation.ok) row.displayText = renderImageExplanation(explanation.value);
        }
        if (!row.text.trim()) { row.state = 'failed'; row.error = 'ACCEPTANCE_EMPTY_OUTPUT'; }
      } catch (error) { row.state = signal.aborted ? 'cancelled' : 'failed'; row.error = safeError(error); }
      row.elapsedMs = Date.now() - started;
      try { await checkpoint; } catch { this.report.pause = 'ACCEPTANCE_STORAGE_FAILED'; }
      const used = measuredTokens(row);
      if (used === null) this.report.pause = 'ACCEPTANCE_USAGE_UNKNOWN';
      if (used !== null && used > reservation) this.report.pause = 'ACCEPTANCE_USAGE_EXCEEDED';
      if (['CHAT_AUTH', 'CHAT_BALANCE', 'AI_REQUEST_FAILED_401', 'AI_REQUEST_FAILED_402', 'AI_REQUEST_FAILED_403'].includes(row.error ?? '')) this.report.pause = row.error!;
      this.report.evidence.realModel ||= material.evidence === 'real_material';
      await this.deps.save(this.report); return summary(this.report);
    });
  }
  async grade(id: string, input: Grade) {
    return this.exclusive(async () => {
      const row = this.report.rows.find(r => r.id === id); requireValue(row && row.state !== 'running', 'ACCEPTANCE_ROW');
      const grade = validateGrade(input);
      requireValue(!!row.text.trim() || (!grade.hardFactsPass && !grade.severe), 'ACCEPTANCE_GENERATION_FAILURE');
      row.grade = grade; this.report.reviews.push({ rowId: id, at: new Date().toISOString(), grade });
      await this.deps.save(this.report); return summary(this.report);
    });
  }
  async read(offset = 0, limit = 12000, expectedHash?: string) {
    requireValue(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 12000);
    const text = JSON.stringify(this.report), hash = await digest(text);
    requireValue(!expectedHash || hash === expectedHash, 'ACCEPTANCE_REPORT_CHANGED');
    return { hash, offset, total: text.length, text: text.slice(offset, offset + limit), nextOffset: offset + limit < text.length ? offset + limit : null };
  }
}
