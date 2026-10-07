import { connectSession } from './client.mjs';
import { checkOutputRoot, saveReport } from './report.mjs';

export async function runPlan(client) {
  const report = await client.report();
  for (const target of report.plan.targets) await client.request('capture', { target: target.id });
  for (const step of report.plan.steps) {
    const status = await client.request('run', { step: step.id });
    if (status.pause || status.rows.some(r => r.state === 'cancelled' || r.state === 'interrupted')) break;
  }
  return client.report();
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    process.stdout.write('Bili-Bill acceptance\nnode cli.mjs <status|renew|run-plan|report|stop|revoke> --extension-id <id> --code <page pairing code> [--output <explicit report directory>]\nAn approved 24-hour task renews its 30-minute session before commands. Renewal never runs or retries a step.\n'); return;
  }
  const [action, ...rest] = args, options = {};
  if (!['status', 'renew', 'run-plan', 'report', 'stop', 'revoke'].includes(action) || rest.length % 2) throw Error('ACCEPTANCE_INPUT');
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--extension-id', '--code', '--output'].includes(rest[i]) || rest[i] in options) throw Error('ACCEPTANCE_INPUT');
    options[rest[i]] = rest[i + 1];
  }
  if (['run-plan', 'report'].includes(action) && !options['--output']) throw Error('ACCEPTANCE_OUTPUT_REQUIRED');
  if (['run-plan', 'report'].includes(action)) await checkOutputRoot(options['--output']);
  const client = await connectSession({ extensionId: options['--extension-id'], code: options['--code'] });
  try {
    let result;
    if (action === 'report') result = await saveReport(await client.report(), options['--output']);
    else if (action === 'run-plan') {
      let failure;
      try { await runPlan(client); } catch (error) { failure = error; }
      try { result = await saveReport(await client.report(), options['--output']); }
      catch (error) { if (!failure) throw error; process.stderr.write('ACCEPTANCE_REPORT_EXPORT_FAILED\n'); }
      if (failure) { if (result) process.stdout.write(JSON.stringify(result) + '\n'); throw failure; }
    } else result = await client.request(action);
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { client.close(); }
}
