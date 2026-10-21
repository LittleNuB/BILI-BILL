import type { AiConfig } from '../../shared/types/config.ts';
import { observeAiResponse, type AiResponseObservation } from '../../shared/ai-response-observation.ts';
import { CHAT_MAX_OUTPUT_CHARS, CHAT_OUTPUT_TOKENS, type LearningChatMessage } from '../../shared/learning-chat.ts';

export function disableDefaultThinking(config: AiConfig, boundedTask: boolean): boolean {
  const base = new URL(config.baseURL.trim());
  return boundedTask && base.origin === 'https://api.deepseek.com' && !base.username && !base.password && !base.search && !base.hash
    && ['', '/', '/v1', '/v1/'].includes(base.pathname)
    && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(config.chatModel);
}

export async function streamLearningChat(config: AiConfig, messages: LearningChatMessage[], options: {
  signal: AbortSignal; stream: boolean; onText: (text: string) => void; maxOutputTokens?: number;
  images?: string[];
  imageThinking?: 'low';
  imageAnswer?: 'bounded_explanation';
  intent?: 'subtitle_correction';
  onResponse?: (value: AiResponseObservation) => void;
}): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 90_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const lowImageThinking = options.imageThinking === 'low';
    if (options.imageThinking !== undefined && (!lowImageThinking || options.intent === 'subtitle_correction'
      || !options.images?.length || messages.at(-1)?.role !== 'user' || !disableDefaultThinking(config, true))) {
      throw new Error('CHAT_IMAGE_THINKING_UNSUPPORTED');
    }
    if (options.imageAnswer !== undefined && (options.imageAnswer !== 'bounded_explanation' || options.intent === 'subtitle_correction'
      || !options.images?.length || messages.at(-1)?.role !== 'user' || !disableDefaultThinking(config, true))) {
      throw new Error('CHAT_IMAGE_JSON_UNSUPPORTED');
    }
    const wireMessages = messages.map((message, i) => i === messages.length - 1 && options.images?.length && message.role === 'user'
      ? { ...message, content: [{ type: 'text', text: message.content }, ...options.images.map(url => ({ type: 'image_url', image_url: { url } }))] } : message);
    // Official Flash can spend the entire bounded correction/visual budget before returning a body.
    const quickAnswer = disableDefaultThinking(config, options.intent === 'subtitle_correction'
      || (Boolean(options.images?.length) && messages.at(-1)?.role === 'user'));
    const response = await fetch(`${config.baseURL.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.chatModel, messages: wireMessages,
        ...(options.imageAnswer ? { response_format: { type: 'json_object' } } : {}),
        ...(lowImageThinking ? { thinking: { type: 'enabled' }, reasoning_effort: 'low' } : { temperature: 0.3,
          ...(quickAnswer ? { thinking: { type: 'disabled' } } : {}) }), stream: options.stream,
        max_tokens: options.maxOutputTokens ?? CHAT_OUTPUT_TOKENS }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error('CHAT_AUTH');
      if (response.status === 402) throw new Error('CHAT_BALANCE');
      if (response.status === 404) throw new Error('CHAT_NOT_FOUND');
      if (response.status === 429) throw new Error('CHAT_RATE_LIMIT');
      if (response.status === 408 || response.status === 504) throw new Error('CHAT_TIMEOUT');
      if (response.status >= 500) throw new Error('CHAT_SERVICE');
      if (response.status === 413) throw new Error(options.images?.length ? 'CHAT_PAYLOAD_LIMIT' : 'CHAT_CONTEXT_LIMIT');
      if ([400, 415, 422].includes(response.status)) {
        const body = await response.json().catch(() => null);
        if (['context_length_exceeded', 'max_context_length', 'context_window_exceeded'].includes(body?.error?.code)) throw new Error('CHAT_CONTEXT_LIMIT');
        if (options.images?.length && (response.status === 415 || ['unsupported_image', 'invalid_image', 'invalid_image_format', 'image_not_supported'].includes(body?.error?.code))) throw new Error('CHAT_IMAGE_UNSUPPORTED');
        throw new Error('CHAT_BAD_REQUEST');
      }
      throw new Error('CHAT_REQUEST_FAILED');
    }
    let text = ''; let reasoningSeen = false;
    const outputLimit = () => { throw new Error(!text.trim() && reasoningSeen ? 'CHAT_REASONING_LIMIT' : 'CHAT_OUTPUT_LIMIT'); };
    const append = (chunk: unknown) => {
      if (typeof chunk !== 'string') return;
      if (text.length + chunk.length > CHAT_MAX_OUTPUT_CHARS) throw new Error('CHAT_OUTPUT_LIMIT');
      text += chunk; options.onText(text);
    };
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const json = await response.json().catch(() => { throw new Error('CHAT_RESPONSE_FORMAT'); });
      options.onResponse?.(observeAiResponse(json));
      reasoningSeen = typeof json?.choices?.[0]?.message?.reasoning_content === 'string' && !!json.choices[0].message.reasoning_content.trim();
      append(json?.choices?.[0]?.message?.content);
      if (json?.choices?.[0]?.finish_reason === 'length') outputLimit();
      if (!text.trim()) throw new Error('CHAT_EMPTY');
      return text;
    }
    if (!response.body) throw new Error('CHAT_EMPTY');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let finished = false;
    const event = (frame: string) => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) return;
      if (data.trim() === '[DONE]') { finished = true; return; }
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new Error('CHAT_RESPONSE_FORMAT'); }
      if (parsed?.error) throw new Error('CHAT_REQUEST_FAILED');
      options.onResponse?.(observeAiResponse(parsed));
      const choice = parsed?.choices?.[0];
      reasoningSeen ||= typeof choice?.delta?.reasoning_content === 'string' && !!choice.delta.reasoning_content.trim();
      append(choice?.delta?.content);
      if (choice?.finish_reason === 'length') outputLimit();
      if (choice?.finish_reason === 'stop') finished = true;
    };
    while (!finished) {
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 131072) throw new Error('CHAT_OUTPUT_LIMIT');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
        if (finished) break;
      }
      if (result.done) { if (buffer.trim()) event(buffer); break; }
    }
    if (!finished) throw new Error('CHAT_INTERRUPTED');
    if (!text.trim()) throw new Error('CHAT_EMPTY');
    return text;
  } catch (error) {
    if (timedOut && !options.signal.aborted) throw new Error('CHAT_TIMEOUT');
    if (!controller.signal.aborted && error instanceof TypeError) throw new Error('CHAT_NETWORK');
    throw error;
  } finally {
    await reader?.cancel().catch(() => {});
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
  }
}
