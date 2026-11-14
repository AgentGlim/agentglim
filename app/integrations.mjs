// Optional machine integrations. Private paths stay in user-local JSON, never in this repository.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA } from './paths.mjs';

const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' ? v.trim() : '';
const expand = (v, home) => v.replace(/^~(?=[\\/]|$)/, () => home);
const plan = (v) => /^[a-z0-9][a-z0-9-]*$/i.test(string(v)) ? string(v) : null;

export function skillsUrl(value) {
  const v = string(value);
  if (v.startsWith('/') && !v.startsWith('//') && !/[\\\s]/.test(v)) return v;
  try {
    const u = new URL(v);
    if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) return u.href;
  } catch {}
  return '/skills';
}

// First existing file wins; an explicit override is exclusive. Relative paths use its directory.
// A malformed file disables integrations rather than falling through to another machine config.
export function loadIntegrations({ env = process.env, home = os.homedir(), data = DATA } = {}) {
  const candidates = env.AGENTGLIM_INTEGRATIONS
    ? [expand(env.AGENTGLIM_INTEGRATIONS, home)]
    : [path.join(data, 'integrations.json'), path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'agentglim', 'integrations.json')];
  const file = candidates.find((f) => fs.existsSync(f)) || candidates[0];
  let config = {};
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (object(parsed)) config = parsed; } catch {}
  const localPath = (v) => string(v) ? path.resolve(path.dirname(file), expand(string(v), home)) : null;
  return {
    auditPlan: plan(config.auditPlan),
    remotePlan: plan(config.remotePlan),
    fleetSnapshot: localPath(config.fleetSnapshot),
    leadsPath: localPath(config.leadsPath),
    emailSequencePath: localPath(config.emailSequencePath),
    playwrightModule: localPath(config.playwrightModule),
    skillsUrl: skillsUrl(config.skillsUrl),
    // New-release check is on by default; an explicit false (or AGENTGLIM_NO_UPDATE_CHECK=1) turns it off.
    updateCheck: config.updateCheck !== false,
  };
}

// Restart the app after changing the file so all readers switch together.
export const integrations = loadIntegrations();
export const modelPricesFile = integrations.leadsPath ? path.join(integrations.leadsPath, 'model_prices.json') : null;

// Only the link and availability flags are sent to the dashboard, never filesystem paths.
export function integrationView() {
  return { leads: !!integrations.leadsPath, emailseq: !!integrations.emailSequencePath };
}

export function integrationPage(html) {
  const href = integrations.skillsUrl.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return html.replace('id="skillsLink" href="/skills"', () => `id="skillsLink" href="${href}"`);
}
