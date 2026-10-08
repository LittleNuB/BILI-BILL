export const TOTAL_TOKEN_BUDGET = 1_000_000;
// Conservative admission allowance for these fixed, bounded synthetic inputs, not measured usage.
export const TOKEN_RESERVATION = 100_000;
export const OUTPUT_LIMITS = [2048, 8192, 16384] as const;
export type OutputLimit = typeof OUTPUT_LIMITS[number];
interface UsageRow {
  attempted?: boolean;
  state: string;
  tokenReservation?: number;
  observation?: { usage: { totalTokens: number | null; promptTokens: number | null; completionTokens: number | null } };
}
export function measuredTokens(row: UsageRow): number | null {
  const usage = row.observation?.usage;
  const valid = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
  if (valid(usage?.totalTokens)) return usage.totalTokens;
  if (valid(usage?.promptTokens) && valid(usage?.completionTokens)) return usage.promptTokens + usage.completionTokens;
  return null;
}
export function tokenBudget(rows: UsageRow[]) {
  let measured = 0, reserved = 0, unknown = 0;
  for (const row of rows.filter(row => row.attempted)) {
    const value = measuredTokens(row);
    if (row.state === 'running' || value === null) {
      reserved += Math.max(TOKEN_RESERVATION, row.tokenReservation ?? 0);
      unknown++;
    } else measured += value;
  }
  return { limit: TOTAL_TOKEN_BUDGET, measured, reserved, unknown, remaining: Math.max(0, TOTAL_TOKEN_BUDGET - measured - reserved) };
}
