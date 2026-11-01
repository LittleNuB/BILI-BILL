import { main } from './server.mjs';
main().catch(error => { process.stderr.write((/^ACCEPTANCE_[A-Z_]+$/.test(error.message) ? error.message : 'ACCEPTANCE_OPERATION_FAILED') + '\n'); process.exitCode = 1; });
