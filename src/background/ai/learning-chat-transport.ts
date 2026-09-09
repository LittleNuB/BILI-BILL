import type { AiConfig } from '../../shared/types/config.ts';
import { CHAT_MAX_OUTPUT_CHARS, CHAT_OUTPUT_TOKENS, type LearningChatMessage } from '../../shared/learning-chat.ts';

export async function streamLearningChat(config: AiConfig, messages: LearningChatMessage[], options: {
  signal: AbortSignal; stream: boolean; onText: (text: string) => void; maxOutputTokens?: number;
}): Promise<string> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  const timer = setTimeout(abort, 90_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${config.baseURL.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.chatModel, messages, temperature: 0.3, stream: options.stream, max_tokens: options.maxOutputTokens ?? CHAT_OUTPUT_TOKENS }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 413) throw new Error('CHAT_CONTEXT_LIMIT');
      if (response.status === 400) {
        const body = await response.json().catch(() => null);
        if (['context_length_exceeded', 'max_context_length', 'context_window_exceeded'].includes(body?.error?.code)) throw new Error('CHAT_CONTEXT_LIMIT');
      }
      throw new Error('CHAT_REQUEST_FAILED');
    }
    let text = '';
    const append = (chunk: unknown) => {
      if (typeof chunk !== 'string') return;
      if (text.length + chunk.length > CHAT_MAX_OUTPUT_CHARS) throw new Error('CHAT_OUTPUT_LIMIT');
      text += chunk; options.onText(text);
    };
    if (!response.headers.get('content-type')?.includes('text/event-stream')) {
      const json = await response.json();
      append(json.choices?.[0]?.message?.content);
      if (json.choices?.[0]?.finish_reason === 'length') throw new Error('CHAT_OUTPUT_LIMIT');
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
      const parsed = JSON.parse(data);
      if (parsed.error) throw new Error('CHAT_REQUEST_FAILED');
      const choice = parsed.choices?.[0];
      append(choice?.delta?.content);
      if (choice?.finish_reason === 'length') throw new Error('CHAT_OUTPUT_LIMIT');
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
  } finally {
    await reader?.cancel().catch(() => {});
    clearTimeout(timer); options.signal.removeEventListener('abort', abort);
  }
}
