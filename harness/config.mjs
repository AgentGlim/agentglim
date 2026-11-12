// config.mjs: kept so the harness scripts here and the plans link _run/bin/harness-config.mjs keep working.
// The settings code moved to app/settings.mjs (defaults: app/settings.defaults.json) on 2026-11-06.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cli } from '../app/settings.mjs';
export * from '../app/settings.mjs';

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
