import { AcceptanceEngine } from './engine.ts';
import { createReport, digest, HOST, inheritHistory, LEGACY, PORT, requireValue, safeError, STORAGE, summary, validatePlan, type Build, type Plan, type Report } from './contract.ts';
import { canonicalJson, planHashMatches } from './identity.ts';
import { captureTarget } from './capture.ts';
import { AI_PROMPTS_KEY, normalizePromptState } from '../../shared/ai-prompts.ts';
import { normalizeUserConfig } from '../../background/storage/config-store.ts';
import { visionSettings, VISION_SETTINGS_KEY } from '../../shared/chat-images.ts';
import { chatJson } from '../../background/ai/openai-compatible.ts';
import { disableDefaultThinking, streamLearningChat } from '../../background/ai/learning-chat-transport.ts';
import { chatBudget } from '../../shared/learning-chat.ts';
import { measuredTokens } from '../prompt-eval/budget.ts';

declare const __ACCEPTANCE_BUILD__: Build;
declare const __ACCEPTANCE_PLAN__: Plan;
const readers = new Set<chrome.runtime.Port>();
let owner: chrome.runtime.Port | null = null, native: chrome.runtime.Port | null = null;
let initializing: Promise<AcceptanceEngine> | null = null, engine: AcceptanceEngine | null = null;
let pairing: { code: string; pipe: string; expiresAt: string } | null = null;
let nativeTimeout: ReturnType<typeof setTimeout> | null = null;
let ledgerId = '', reports: Report[] = [];
const checkpoints = new Map<string, { resolve: () => void; reject: () => void }>();
const charges = () => reports.flatMap(r => r.rows.map(row => ({ id: `${r.planHash}:${row.id}`, running: row.state === 'running', tokens: measuredTokens(row), reservation: row.tokenReservation })));
async function checkpoint() {
  requireValue(native && pairing, 'ACCEPTANCE_HOST_DISCONNECTED');
  const id = crypto.randomUUID();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { checkpoints.delete(id); reject(Error('ACCEPTANCE_LEDGER_TIMEOUT')); }, 10000);
    checkpoints.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: () => { clearTimeout(timer); reject(Error('ACCEPTANCE_LEDGER_CONFLICT')); } });
    post(native!, { checkpoint: 1, id, charges: charges() });
  });
}
const post = (port: chrome.runtime.Port, data: unknown) => { try { port.postMessage(data); } catch { /* Disconnect revokes owned work. */ } };
const broadcast = () => { if (engine) for (const port of readers) post(port, { summary: summary(engine.report), busy: engine.busy, authorized: engine.authorized, pairing: owner === port ? pairing : null }); };
async function configuration() {
  const stored = await chrome.storage.local.get(['userConfig', VISION_SETTINGS_KEY, 'learningChatStreaming', 'learningChatBudget', AI_PROMPTS_KEY, 'developerPromptEvaluationV1']);
  const old = stored.developerPromptEvaluationV1 as { rows?: any[] } | undefined;
  // A different or later legacy ledger must be reconciled explicitly, never silently reset to the known floor.
  if (old?.rows?.some((r: { attempted?: boolean }) => r.attempted)) {
    const attempts = old.rows.filter((r: { attempted?: boolean }) => r.attempted);
    requireValue(attempts.length === LEGACY.calls && attempts.every((r: { state: string }) => r.state !== 'running')
      && attempts.every((r: any) => measuredTokens(r) !== null) && attempts.reduce((n: number, r: any) => n + measuredTokens(r)!, 0) === LEGACY.tokens, 'ACCEPTANCE_LEGACY_CHANGED');
  }
  const config = normalizeUserConfig(stored.userConfig), vision = visionSettings(stored[VISION_SETTINGS_KEY]);
  const prompts = normalizePromptState(stored[AI_PROMPTS_KEY]), stream = stored.learningChatStreaming !== false;
  requireValue(config.ai.apiKey.trim() && config.ai.chatModel.trim(), 'ACCEPTANCE_NOT_CONFIGURED');
  const endpoint = new URL(config.ai.baseURL);
  requireValue(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash, 'ACCEPTANCE_ENDPOINT');
  // Stamp is ephemeral and includes key changes; neither this stamp nor the configuration is exported.
  const contextBudget = chatBudget(stored.learningChatBudget);
  const stamp = await digest(JSON.stringify([config.ai, vision, prompts, stream, contextBudget]));
  return { config, vision, prompts, stream, stamp, contextBudget, model: config.ai.chatModel, imageModel: vision.model,
    disableThinking: { subtitles: disableDefaultThinking(config.ai, true), image: disableDefaultThinking({ ...config.ai, chatModel: vision.model }, true) } };
}
function initialize(): Promise<AcceptanceEngine> {
  if (engine) return Promise.resolve(engine);
  if (initializing) return initializing;
  initializing = (async () => {
    const fresh = await createReport(__ACCEPTANCE_PLAN__);
    const stored = (await chrome.storage.local.get(STORAGE))[STORAGE] as { version: 1; ledgerId: string; reports: Report[] } | undefined;
    requireValue(!stored || (stored.version === 1 && /^[a-f0-9-]{36}$/.test(stored.ledgerId) && Array.isArray(stored.reports)), 'ACCEPTANCE_LEDGER_INVALID');
    ledgerId = stored?.ledgerId ?? crypto.randomUUID(); reports = stored?.reports ?? [];
    for (const report of reports) {
      requireValue(report.version === 1 && await planHashMatches(validatePlan(report.plan), report.planHash) && Array.isArray(report.priorCharges), 'ACCEPTANCE_LEDGER_INVALID');
      for (const row of report.rows) if (row.state === 'running') { row.state = 'interrupted'; row.error = 'ACCEPTANCE_INTERRUPTED'; report.pause = 'ACCEPTANCE_USAGE_UNKNOWN'; }
      requireValue(!(report.plan.id === fresh.plan.id && canonicalJson(report.plan) !== canonicalJson(fresh.plan)), 'ACCEPTANCE_PLAN_VERSION');
    }
    let report = reports.find(r => r.plan.id === fresh.plan.id);
    if (!report) {
      inheritHistory(fresh, reports);
      report = fresh; reports.push(report);
    } else requireValue(reports.at(-1) === report, 'ACCEPTANCE_OLD_PLAN_READ_ONLY');
    const save = async (value: Report) => {
      const index = reports.findIndex(r => r.planHash === value.planHash); reports[index] = structuredClone(value);
      await chrome.storage.local.set({ [STORAGE]: { version: 1, ledgerId, reports } });
      if (native && pairing) await checkpoint();
      broadcast();
    };
    engine = new AcceptanceEngine(report, { build: __ACCEPTANCE_BUILD__, save,
      settings: async () => { const c = await configuration(); return { ...c, vision: c.vision.enabled && !!c.vision.model }; },
      capture: (target, frame, signal) => captureTarget(target, frame, signal, __ACCEPTANCE_BUILD__),
      execute: async (row, step, material, signal, onText, onResponse) => {
        const c = await configuration(); requireValue(engine?.authorized && !signal.aborted && !!native && !!owner, 'ACCEPTANCE_REVOKED');
        const maxOutputTokens = (row.parameters as { max_tokens: number }).max_tokens;
        if (step.feature === 'overview') return chatJson(c.config.ai, row.messages as { role: 'system' | 'user'; content: string }[],
          { signal, allowTextResponse: true, maxOutputTokens, onText, onResponse });
        return streamLearningChat({ ...c.config.ai, chatModel: row.model }, row.messages, { signal,
          stream: (row.parameters as { stream: boolean }).stream, maxOutputTokens, onText, onResponse,
          intent: step.feature === 'subtitles' ? 'subtitle_correction' : undefined,
          images: step.feature === 'image' ? [material.frame!.data] : undefined });
      },
    });
    await save(engine.report); return engine;
  })().catch(error => { engine = null; throw error; }).finally(() => { initializing = null; });
  return initializing;
}
function revoke() {
  if (nativeTimeout) clearTimeout(nativeTimeout); nativeTimeout = null;
  engine?.revoke(); owner = null; pairing = null;
  const connection = native; native = null; connection?.disconnect(); broadcast();
  for (const pending of checkpoints.values()) pending.reject(); checkpoints.clear();
}
async function command(message: any) {
  requireValue(engine && message && typeof message === 'object');
  const allowed: Record<string, string[]> = { status: [], capture: ['target'], run: ['step'], stop: [], revoke: [], report: ['offset', 'limit', 'hash'], grade: ['row', 'grade'] };
  requireValue(allowed[message.action] && Object.keys(message).every(k => ['id', 'action', ...allowed[message.action]].includes(k)));
  if (message.action === 'status') return summary(engine.report);
  if (message.action === 'report') return engine.read(message.offset ?? 0, message.limit ?? 12000, message.hash);
  if (message.action === 'stop') { engine.stop(); return { stopped: true }; }
  if (message.action === 'revoke') { revoke(); return { revoked: true }; }
  if (message.action === 'capture') return engine.capture(message.target);
  if (message.action === 'run') return engine.run(message.step);
  return engine.grade(message.row, message.grade);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['userConfig', VISION_SETTINGS_KEY, 'learningChatStreaming', 'learningChatBudget', AI_PROMPTS_KEY, 'developerPromptEvaluationV1'].some(k => k in changes)) revoke();
});
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PORT || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL('acceptance/index.html')) return;
  readers.add(port);
  port.onDisconnect.addListener(() => { readers.delete(port); if (owner === port) revoke(); });
  const ready = initialize();
  void ready.then(async e => { post(port, { plan: e.report.plan, build: __ACCEPTANCE_BUILD__ }); broadcast();
    try { const c = await configuration(); post(port, { settings: { model: c.model, imageModel: c.vision.enabled ? c.imageModel : '' } }); }
    catch (error) { post(port, { settings: { error: safeError(error) } }); }
  }).catch(error => post(port, { error: safeError(error) }));
  port.onMessage.addListener(message => {
    if (message?.action === 'ping') { post(port, { pong: true }); return; }
    if (message?.action === 'stop') { engine?.stop(); return; }
    if (message?.action === 'revoke') { revoke(); return; }
    void ready.then(async e => {
      if (message?.action !== 'authorize') throw Error('ACCEPTANCE_INPUT');
      requireValue(readers.has(port) && !owner && !e.busy && message.planHash === e.report.planHash, 'ACCEPTANCE_BUSY');
      owner = port;
      try {
        const grant = await e.authorize();
        requireValue(owner === port && readers.has(port), 'ACCEPTANCE_REVOKED');
        const bytes = crypto.getRandomValues(new Uint8Array(24)), code = Array.from(bytes).map(n => n.toString(16).padStart(2, '0')).join('');
        const connection = chrome.runtime.connectNative(HOST); native = connection;
        nativeTimeout = setTimeout(() => { if (native === connection && !pairing) { revoke(); post(port, { error: 'ACCEPTANCE_HOST_TIMEOUT' }); } }, 12000);
        connection.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          if (native === connection) { revoke(); post(port, { error: 'ACCEPTANCE_HOST_DISCONNECTED' }); }
        });
        connection.onMessage.addListener(msg => {
          if (connection !== native) return;
          if (typeof msg?.checkpointAck === 'string') { const pending = checkpoints.get(msg.checkpointAck); checkpoints.delete(msg.checkpointAck); if (msg.error) pending?.reject(); else pending?.resolve(); return; }
          if (msg?.ready === true) { if (nativeTimeout) clearTimeout(nativeTimeout); nativeTimeout = null; pairing = { code, pipe: `bili-bill-acceptance-${chrome.runtime.id}`, ...grant }; broadcast(); return; }
          void command(msg).then(result => post(connection, { id: msg.id, result }))
            .catch(error => post(connection, { id: msg.id, error: safeError(error) })).finally(broadcast);
        });
        post(connection, { hello: 1, code, extensionId: chrome.runtime.id, planHash: e.report.planHash, ledgerId, charges: charges(), ...grant });
      } catch (error) { revoke(); throw error; }
    }).catch(error => post(port, { error: safeError(error) }));
  });
});
