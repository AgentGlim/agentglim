// Browser checks use an installed package, an explicit override, or a private integration path.
import { createRequire } from 'node:module';
import { integrations } from '../app/integrations.mjs';

const require = createRequire(import.meta.url);
export function loadPlaywright() {
  const configured = process.env.PLAYWRIGHT_MODULE || integrations.playwrightModule;
  return require(configured || 'playwright');
}
