import { spawn } from 'node:child_process';
import { publishLaunchHealth } from '/source/agent-node/src/runtime/opencode-copresence/launcher-health.ts';

const serve = spawn('sleep', ['60'], { stdio: 'ignore' });
await new Promise<void>((resolve, reject) => { serve.once('spawn', resolve); serve.once('error', reject); });
const cleanup = publishLaunchHealth(process.argv[2], 'ses_window894', serve.pid!);
process.on('SIGTERM', () => { cleanup(); serve.kill(); process.exit(0); });
setInterval(() => {}, 1000);
