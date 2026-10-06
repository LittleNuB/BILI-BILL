import { existsSync, lstatSync, openSync, readFileSync, writeFileSync, fsyncSync, closeSync, renameSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LEGACY_TOKENS, MAX_TOKEN_RESERVATION, TOKEN_RESERVATION, TOTAL_TOKEN_BUDGET } from '../../src/dev/acceptance/limits.ts';

const reservation = charge => charge.reservation ?? TOKEN_RESERVATION;

// A second durable ledger prevents a fresh browser profile or downgraded extension
// snapshot from presenting the same 58,493-token floor as a new paid allowance.
export function createBillingGuard(file) {
  const root = path.dirname(path.resolve(file));
  if (realpathSync(root).toLowerCase() !== root.toLowerCase()) throw Error('ACCEPTANCE_LEDGER_SCOPE');
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || lstatSync(file).nlink !== 1 || lstatSync(file).size > 4 * 1024 * 1024)) throw Error('ACCEPTANCE_LEDGER_SCOPE');
  let stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  return (ledgerId, charges) => {
    if (!/^[a-f0-9-]{36}$/.test(ledgerId ?? '') || !Array.isArray(charges) || charges.length > 1000) throw Error('ACCEPTANCE_LEDGER_INVALID');
    const ids = new Set();
    for (const c of charges) {
      if (!c || Object.keys(c).some(k => !['id', 'tokens', 'running', 'reservation'].includes(k)) || !/^[a-f0-9]{64}:[a-z][a-z0-9-]{0,63}$/.test(c.id)
        || ids.has(c.id) || typeof c.running !== 'boolean' || !(c.tokens === null || (Number.isSafeInteger(c.tokens) && c.tokens >= 0))
        || !Number.isSafeInteger(reservation(c)) || reservation(c) < TOKEN_RESERVATION || reservation(c) > MAX_TOKEN_RESERVATION) throw Error('ACCEPTANCE_LEDGER_INVALID');
      ids.add(c.id);
    }
    if (stored) {
      if (stored.ledgerId !== ledgerId) throw Error('ACCEPTANCE_LEDGER_PROFILE');
      for (const prior of stored.charges) {
        const next = charges.find(c => c.id === prior.id);
        if (!next || reservation(next) !== reservation(prior) || (!prior.running && (next.running || next.tokens !== prior.tokens))) throw Error('ACCEPTANCE_LEDGER_ROLLBACK');
      }
      const added = charges.filter(c => !stored.charges.some(p => p.id === c.id));
      const committed = LEGACY_TOKENS + stored.charges.reduce((n, c) => n + (c.running || c.tokens === null ? reservation(c) : c.tokens), 0);
      if (added.length && (added.length !== 1 || stored.charges.some(c => c.running || c.tokens === null)
        || committed + reservation(added[0]) > TOTAL_TOKEN_BUDGET || !added[0].running || added[0].tokens !== null)) throw Error('ACCEPTANCE_LEDGER_BUDGET');
    }
    const next = { version: 1, ledgerId, legacyTokens: LEGACY_TOKENS, tokenLimit: TOTAL_TOKEN_BUDGET, charges };
    const temporary = `${file}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx');
    try { writeFileSync(fd, JSON.stringify(next)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file); stored = structuredClone(next);
  };
}
