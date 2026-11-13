// The plans harness owns policy validation and resolution. An unconnected app stays read-only.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function roleModelsView({ plansDir, runDir }, value) {
  const moduleFile = path.join(runDir, 'bin', 'round-models.mjs');
  if (!fs.existsSync(moduleFile)) {
    if (value !== undefined) throw new Error('Connect a plans harness with role-model support first');
    return { available: false, configured: false, roles: [], models: [], plans: [] };
  }
  const resolver = await import(pathToFileURL(moduleFile).href);
  if (!resolver.readPolicy || !resolver.writePolicy) throw new Error('Update the harness resolver to enable Roles');
  const file = path.join(runDir, 'role-models.json');
  if (value !== undefined) resolver.writePolicy(value, file);
  const policy = resolver.readPolicy(file);
  const plans = fs.readdirSync(plansDir, { withFileTypes: true })
    .filter((d) => /^\d\d-[a-z0-9-]+$/.test(d.name) && d.isDirectory() && fs.existsSync(path.join(plansDir, d.name, 'PLAN.md')))
    .map((d) => {
      const rm = resolver.read(path.join(plansDir, d.name));
      return { dir: d.name, roles: Object.fromEntries(resolver.ROLES.map(({ id }) => {
        const choices = resolver.choices(rm, id, { policy, strict: id === 'audit' });
        // Without a policy, retain the old Terra premium substitution in the display too.
        const spec = resolver.spec(rm, id, { policy, strict: id === 'audit' });
        return [id, { models: policy ? choices : choices.filter((m) => !resolver.PREMIUM_KEYS.has(id) || !/terra/.test(m)),
          codex: spec.codex, claude: spec.claude, legacy: !policy && !spec.set, note: spec.note }];
      })) };
    }).sort((a, b) => a.dir.localeCompare(b.dir));
  return { available: true, configured: !!policy, policy: policy || resolver.defaultPolicy(), roles: resolver.ROLES,
    models: resolver.MODELS.map((m) => ({ ...m, roles: resolver.ROLES.filter((r) => resolver.supported(r.id, m.id)).map((r) => r.id) })), plans };
}
