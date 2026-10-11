export interface AiResponseObservation {
  model: string | null;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
}
// Export only allowlisted response metadata, never headers, configuration or reasoning traces.
export function observeAiResponse(value: unknown): AiResponseObservation {
  const row = value as any;
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const name = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:/-]{1,200}$/.test(v) ? v : null;
  return { model: name(row?.model), finishReason: name(row?.choices?.[0]?.finish_reason), usage: {
    promptTokens: count(row?.usage?.prompt_tokens), completionTokens: count(row?.usage?.completion_tokens), totalTokens: count(row?.usage?.total_tokens),
  } };
}
