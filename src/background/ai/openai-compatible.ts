import type { AiConfig, AiConnectionTestResult } from '../../shared/types/config.ts';

interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface ChatJsonOptions {
  signal?: AbortSignal;
  allowTextResponse?: boolean;
}

const AI_REQUEST_TIMEOUT_MS = 60_000;

export async function chatJson<T>(
  config: AiConfig,
  messages: ChatMessage[],
  options: ChatJsonOptions = {},
): Promise<T> {
  if (!config.apiKey.trim()) {
    throw new Error('AI_API_KEY_MISSING');
  }

  const endpoint = `${config.baseURL.trim().replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.chatModel,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`AI_REQUEST_FAILED_${response.status}`);
    }

    const json: ChatResponse = await response.json();
    const content = json.choices?.[0]?.message?.content ?? '';
    try {
      return parseJsonContent<T>(content);
    } catch (error) {
      if (options.allowTextResponse && content.trim()) return content as T;
      throw error;
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(options.signal?.aborted ? 'AI_REQUEST_ABORTED' : 'AI_REQUEST_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function testAiConnection(config: AiConfig): Promise<AiConnectionTestResult> {
  const baseURL = config.baseURL.trim();
  const chatModel = config.chatModel.trim();
  const apiKey = config.apiKey.trim();
  if (!baseURL) throw new Error('AI_BASE_URL_MISSING');
  if (!chatModel) throw new Error('AI_MODEL_MISSING');
  if (!apiKey) throw new Error('AI_API_KEY_MISSING');

  const startedAt = Date.now();
  await chatJson<{ ok?: unknown }>({ baseURL, chatModel, apiKey }, [
    {
      role: 'system',
      content: 'Return JSON only. The response schema is {"ok": true}.',
    },
    {
      role: 'user',
      content: '请返回 {"ok": true}，不要包含其他字段。',
    },
  ]);

  return {
    ok: true,
    model: chatModel,
    checkedAt: Date.now(),
    latencyMs: Date.now() - startedAt,
  };
}

function parseJsonContent<T>(content: string): T {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error('AI_RESPONSE_INVALID_JSON');
  }
}

