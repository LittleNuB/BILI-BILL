import { budget, inheritHistory, LEGACY, requireValue, validatePlan, type Plan, type Report } from './contract.ts';
import { canonicalJson, digest, materialHashMatches, planHashMatches } from './identity.ts';
import { measuredTokens } from '../prompt-eval/budget.ts';

export interface RecoveryBook { version: 1; ledgerId: string; reports: Report[] }
export interface RecoveryDescriptor { sha256: string; planId: string; measured: number; calls: number }

// Only a package-bound backup, reconciled with the unchanged native ledger by
// the packager, is eligible. Loading/restore never grants a model session.
export async function validateRecovery(raw: string, expectedHash: string, plan: Plan): Promise<RecoveryBook> {
  requireValue(raw.length <= 4 * 1024 * 1024 && await digest(raw) === expectedHash, 'ACCEPTANCE_RECOVERY_INVALID');
  const book = JSON.parse(raw) as RecoveryBook;
  requireValue(book.version === 1 && /^[a-f0-9-]{36}$/.test(book.ledgerId) && Array.isArray(book.reports)
    && book.reports.length > 0 && book.reports.length <= 64 && book.reports.at(-1)?.planHash === plan.reuseFrom, 'ACCEPTANCE_RECOVERY_INVALID');
  const previous: Report[] = [], plans = new Set<string>();
  for (const report of book.reports) {
    requireValue(report.version === 1 && !plans.has(report.plan.id) && await planHashMatches(validatePlan(report.plan), report.planHash)
      && canonicalJson(report.legacy) === canonicalJson(LEGACY)
      && canonicalJson(report.plan.targets) === canonicalJson(plan.targets), 'ACCEPTANCE_RECOVERY_INVALID');
    const inherited: Report = { ...report, materials: {} };
    try { inheritHistory(inherited, previous); } catch { throw Error('ACCEPTANCE_RECOVERY_INVALID'); }
    requireValue(canonicalJson(inherited.priorCharges) === canonicalJson(report.priorCharges), 'ACCEPTANCE_RECOVERY_INVALID');
    for (const target of plan.targets) {
      const material = report.materials[target.id];
      requireValue(material && canonicalJson(material.target) === canonicalJson(target) && await materialHashMatches(material), 'ACCEPTANCE_RECOVERY_INVALID');
      if (report.plan.reuseFrom) requireValue(canonicalJson(material) === canonicalJson(inherited.materials[target.id]), 'ACCEPTANCE_RECOVERY_INVALID');
      if (material.frame) requireValue(await digest(material.frame.data) === material.frame.sha256, 'ACCEPTANCE_RECOVERY_INVALID');
    }
    const ids = new Set<string>();
    for (const row of report.rows) {
      const step = report.plan.steps.find(s => s.id === row.id);
      requireValue(step && step.target === row.target && step.feature === row.feature && !ids.has(row.id) && row.attempted === true
        && row.state !== 'running' && measuredTokens(row) !== null && row.materialHash === report.materials[row.target]?.hash
        && /^[a-f0-9]{64}$/.test(row.inputHash), 'ACCEPTANCE_RECOVERY_INVALID');
      ids.add(row.id);
    }
    requireValue(budget(report).unknown === 0, 'ACCEPTANCE_RECOVERY_INVALID');
    plans.add(report.plan.id); previous.push(report);
  }
  return book;
}

// An exact older prefix may only be extended. Any different grade, output,
// charge, ledger identity or unknown state is a conflict, never overwritten.
export function recoveryCanAppend(stored: unknown, backup: RecoveryBook): boolean {
  if (recoveryDestinationEmpty(stored)) return true;
  const current = stored as RecoveryBook | null;
  return !!current && current.version === 1 && current.ledgerId === backup.ledgerId && Array.isArray(current.reports)
    && current.reports.length > 0 && current.reports.length < backup.reports.length
    && current.reports.every((report, index) => canonicalJson(report) === canonicalJson(backup.reports[index]));
}

export function recoveryDestinationEmpty(stored: unknown): boolean {
  // Never replace an existing ledger, even an unfamiliar or incomplete one.
  return stored === undefined;
}
