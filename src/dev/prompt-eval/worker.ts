import baseline from '../../../tests/fixtures/prompt-eval/baseline.json';
import { CASES } from './cases.ts';
import { createReport, digest, EvalEngine, type Report } from './engine.ts';
import { chatJson } from '../../background/ai/openai-compatible.ts';
import { streamLearningChat } from '../../background/ai/learning-chat-transport.ts';
import { normalizeUserConfig } from '../../background/storage/config-store.ts';
import { visionSettings, VISION_SETTINGS_KEY } from '../../shared/chat-images.ts';
import type { LearningChatMessage } from '../../shared/learning-chat.ts';
import { parseSeed, reconcileSeed } from './seed.ts';

declare const __EVAL_BUILD__: Pick<Report, 'sourceCommit' | 'buildHash' | 'datasetHash' | 'baselineCommit'>;
declare const __EVAL_HAS_SEED__: boolean;
const STORAGE_KEY = 'developerPromptEvaluationV1';
const PORT = 'bili-bill-prompt-evaluation-v1';
const ports = new Set<chrome.runtime.Port>();
let owner: chrome.runtime.Port | null = null;
let engine: EvalEngine | null = null;
let initialization: Promise<EvalEngine> | null = null;
let configChanged = false;

async function configuration() {
  const stored = await chrome.storage.local.get(['userConfig', VISION_SETTINGS_KEY, 'learningChatStreaming']);
  const config = normalizeUserConfig(stored.userConfig), vision = visionSettings(stored[VISION_SETTINGS_KEY]);
  if (!config.ai.apiKey.trim() || !config.ai.chatModel.trim()) throw Error('EVAL_NOT_CONFIGURED');
  const endpoint = new URL(config.ai.baseURL);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('EVAL_ENDPOINT');
  const stream = stored.learningChatStreaming !== false;
  const stamp = await digest(JSON.stringify([config.ai.baseURL, config.ai.chatModel, vision, stream]));
  return { config, vision, stream, stamp };
}
const post = (port: chrome.runtime.Port, value: unknown) => { try { port.postMessage(value); } catch { /* The disconnect handler cancels the request. */ } };
const broadcast = (value: unknown) => { for (const port of ports) post(port, value); };
const safeError = (error: unknown) => error instanceof Error && /^EVAL_[A-Z_]+$/.test(error.message) ? error.message : 'EVAL_OPERATION_FAILED';

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['userConfig', VISION_SETTINGS_KEY, 'learningChatStreaming'].some(key => key in changes)) {
    configChanged = true; engine?.stop();
  }
});
function initialize(): Promise<EvalEngine> {
  if (initialization) return initialization;
  if (engine) return Promise.resolve(engine);
  initialization = (async () => {
    let existing = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as Report | undefined;
    if (__EVAL_HAS_SEED__) {
      const response = await fetch(chrome.runtime.getURL('prompt-eval/prior-report.json'));
      if (!response.ok) throw Error('EVAL_BUILD_CHANGED');
      existing = reconcileSeed(existing, await parseSeed(await response.text()));
    }
    if (existing && (existing.datasetHash !== __EVAL_BUILD__.datasetHash || existing.baselineCommit !== __EVAL_BUILD__.baselineCommit)) throw Error('EVAL_BUILD_CHANGED');
    if (existing) {
      existing.builds ??= [{ sourceCommit: existing.sourceCommit, buildHash: existing.buildHash }];
      if (!existing.builds.some(build => build.buildHash === __EVAL_BUILD__.buildHash)) existing.builds.push({ sourceCommit: __EVAL_BUILD__.sourceCommit, buildHash: __EVAL_BUILD__.buildHash });
    }
    const save = async (report: Report) => {
      await chrome.storage.local.set({ [STORAGE_KEY]: structuredClone(report) });
      broadcast({ report, running: engine?.running ?? false });
    };
    engine = new EvalEngine(existing ?? createReport(__EVAL_BUILD__), {
      baseline: baseline as Record<string, LearningChatMessage[]>, save, build: __EVAL_BUILD__,
      current: async () => {
        if (!owner || !ports.has(owner) || configChanged) throw Error('EVAL_CONFIG_CHANGED');
        const { config, vision, stream, stamp } = await configuration();
        const outputTokens = engine?.report.outputTokens ?? 8192;
        return { stamp, model: config.ai.chatModel, imageModel: vision.model, vision: vision.enabled && !!vision.model,
          parameters: { overview: { temperature: 0.2, response_format: 'json_object', timeoutMs: 60000, max_tokens: outputTokens },
            subtitles: { temperature: 0.3, max_tokens: 6000, stream: false, timeoutMs: 90000 },
            chatAndImage: { temperature: 0.3, max_tokens: outputTokens, stream, timeoutMs: 90000 },
            usagePolicy: 'Only provider-returned token counts; absent values stay null. Production image-provider options remain active.' } };
      },
      execute: async (item, messages, signal, onText, onResponse, row) => {
        const { config, vision, stream, stamp } = await configuration();
        if (!owner || !ports.has(owner) || configChanged || signal.aborted || stamp !== engine?.report.configStamp) throw Error('EVAL_CONFIG_CHANGED');
        const parameters = row.parameters as { chatAndImage: { max_tokens: number }; overview: { max_tokens: number } };
        if (item.feature === 'overview') return chatJson(config.ai, messages as { role: 'system' | 'user'; content: string }[],
          { signal, allowTextResponse: true, onText, onResponse, maxOutputTokens: parameters.overview.max_tokens });
        let images: string[] | undefined;
        if (item.image) {
          const response = await fetch(chrome.runtime.getURL(`prompt-eval/images/${item.image}`));
          if (!response.ok) throw Error('EVAL_IMAGE');
          const bytes = new Uint8Array(await response.arrayBuffer());
          let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
          images = [`data:image/png;base64,${btoa(binary)}`];
        }
        if (!owner || !ports.has(owner) || configChanged || signal.aborted) throw Error('EVAL_CONFIG_CHANGED');
        return streamLearningChat({ ...config.ai, chatModel: item.image ? vision.model : config.ai.chatModel }, messages,
          { signal, stream: item.feature === 'subtitles' ? false : stream, maxOutputTokens: item.feature === 'subtitles' ? 6000 : parameters.chatAndImage.max_tokens,
            images, onText, onResponse });
      },
    });
    try { await save(engine.report); } catch (error) { engine = null; throw error; }
    return engine;
  })().finally(() => { initialization = null; });
  return initialization;
}

chrome.runtime.onConnect.addListener(port => {
  // Readers share the engine; only one page may own a generation. No website bridge.
  if (port.name !== PORT || port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL('prompt-eval/index.html')) return;
  ports.add(port);
  port.onDisconnect.addListener(() => { ports.delete(port); if (owner === port) engine?.stop(); });
  const ready = initialize();
  void ready.then(async engine => {
    if (!ports.has(port)) return;
    post(port, { report: engine.report, running: engine.running });
    let settings: unknown;
    try { const { config, vision, stream } = await configuration(); settings = { model: config.ai.chatModel, imageModel: vision.model, vision: vision.enabled, stream }; }
    catch (error) { settings = { error: safeError(error) }; }
    if (ports.has(port)) post(port, { settings, cases: CASES });
  }).catch(error => { if (ports.has(port)) post(port, { error: safeError(error) }); });
  port.onMessage.addListener(message => {
    if (message?.action === 'ping') { post(port, { pong: true }); return; }
    if (message?.action === 'stop') { engine?.stop(); return; }
    void ready.then(async engine => {
      if (!ports.has(port)) throw Error('EVAL_DISCONNECTED');
      if (owner || engine.running) throw Error('EVAL_BUSY');
      owner = port;
      try {
        if (message?.action === 'run') { configChanged = false; await engine.run(); }
        else if (message?.action === 'retry' && typeof message.id === 'string') { configChanged = false; await engine.retry(message.id, message.reason); }
        else if (message?.action === 'grade' && typeof message.id === 'string') await engine.grade(message.id, message.grade);
        else if (message?.action === 'outputTokens' && typeof message.value === 'number') await engine.setOutputTokens(message.value);
        else throw Error('EVAL_INPUT');
      } finally { owner = null; }
    }).catch(error => post(port, { error: safeError(error) }))
      .finally(() => { if (engine) broadcast({ report: engine.report, running: engine.running }); });
  });
});
