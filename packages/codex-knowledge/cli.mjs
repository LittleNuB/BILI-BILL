import { main } from './server.mjs';
main().catch(() => { process.stderr.write('Bili-Bill: configuration or library connection failed. No page was changed.\n'); process.exitCode = 1; });
