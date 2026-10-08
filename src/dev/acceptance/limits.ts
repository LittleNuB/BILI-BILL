// User-approved real-material acceptance budget, including the earlier synthetic run.
// The original prompt-evaluation tool retains its own 1,000,000-token limit.
export const TOTAL_TOKEN_BUDGET = 10_000_000;
export const TOKEN_RESERVATION = 100_000;
export const MAX_TOKEN_RESERVATION = 200_000;
// UTF-8 bytes deliberately overestimate text tokens; leave room for framing and the bounded frame.
export function reservationFor(inputBytes: number, outputTokens: number): number {
  return Math.max(TOKEN_RESERVATION, Math.ceil((inputBytes + outputTokens + 32_768) / 1000) * 1000);
}
export const LEGACY_TOKENS = 58_493;
