import { startBridge } from './bridge.mjs';
import { createBillingGuard } from './billing.mjs';

// Browser supplies its origin after the launcher's fixed extension ID.
const [flag, extensionId, ledgerFlag, ledgerFile, origin] = process.argv.slice(2);
if (flag !== '--extension-id' || ledgerFlag !== '--ledger' || !ledgerFile || !/^[a-p]{32}$/.test(extensionId ?? '') || origin !== `chrome-extension://${extensionId}/`) {
  process.stderr.write('ACCEPTANCE_ORIGIN\n'); process.exitCode = 1;
} else {
  const bridge = startBridge({ input: process.stdin, output: process.stdout, extensionId, checkpoint: createBillingGuard(ledgerFile) });
  process.on('SIGINT', bridge.close); process.on('SIGTERM', bridge.close);
}
