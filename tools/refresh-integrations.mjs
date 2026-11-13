#!/usr/bin/env node
// refresh-integrations.mjs: the refresh half of `npm run update` (tools/update.mjs pulls main, then runs this) so copies
// made earlier do not linger: the global note and the agentglim-setup skill copies the agent-hints tool installed, and the
// run folder's tool links and note that scaffold-harness manages. Only existing hint/skill integrations are refreshed;
// scaffold may create missing tools and queues. Custom tools are kept, replaced skills backed up, goals and settings kept. Restart AgentGlim afterwards.
//   npm run update [-- --dry-run]         (pull + this step; the documented update path)
//   npm run refresh-integrations [-- --dry-run]   (this step alone)
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dry = process.argv.includes('--dry-run');
const { install } = await import('./install-agent-hints.mjs');
console.log('agent hints and skill copies:');
console.log(install({ root: path.resolve(HERE, '..'), dry, onlyExisting: true }).map((l) => `  ${l}`).join('\n'));
console.log('run folder:');
try { console.log(execFileSync(process.execPath, [path.join(HERE, 'scaffold-harness.mjs'), ...(dry ? ['--dry-run'] : [])], { env: process.env, encoding: 'utf8', timeout: 20000 }).trim().replace(/^/gm, '  ')); }
catch (e) { console.error(`  scaffold failed: ${String(e.stdout || e.message).trim()}`); process.exitCode = 1; }
console.log('Restart AgentGlim to run the new version. Your data folder was not changed.');
