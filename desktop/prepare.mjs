// Stage only public server code. Never copy .env, runtime data or local configuration.
import { mkdir, readdir, copyFile, rename, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const bundledSkills=JSON.parse(await readFile(path.join(root,'app/bundled-skills.json'),'utf8'));
const resources = path.join(desktop, 'resources');
await mkdir(path.join(desktop, '_archive'), { recursive: true });
try {
  await rename(resources, path.join(desktop, '_archive', `resources-${Date.now()}`));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const allowed = new Set(['.mjs', '.js', '.html', '.css', '.json', '.svg', '.png', '.webmanifest', '.md', '.sh', '.patch', '.py']);
async function copyTree(relative) {
  const source = path.join(root, relative);
  const destination = path.join(resources, relative);
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || /\.bak(?:-|\.|$)/.test(entry.name) || entry.name === 'integrations.json' || entry.name === '__pycache__' || ['tests', 'node_modules', 'data', '_archive'].includes(entry.name)) continue;
    if(relative === 'app' && entry.name === 'dev-skills.mjs') continue;
    if(relative === 'harness' && !['config.mjs','bin'].includes(entry.name)) continue;
    // the router and the two modules it imports; nothing else from the harness ships
    if(relative === 'harness/bin' && !['jev-route.mjs','free-models.mjs','model-cooldown.mjs'].includes(entry.name)) continue;
    if(relative === 'skills' && !bundledSkills.includes(entry.name)) continue;
    const rel = path.join(relative, entry.name);
    // Jev routes are machine-specific; user configuration remains external.
    if (relative === 'harness' && entry.name.startsWith('jev-routes.')) continue;
    if (entry.isDirectory()) await copyTree(rel);
    else if (entry.isFile() && (allowed.has(path.extname(entry.name)) || relative === 'tools/addons' && ['agent-notify','jev-gate'].includes(entry.name))) {
      await copyFile(path.join(root, rel), path.join(resources, rel));
    }
  }
}
for (const folder of ['app', 'assets', 'harness', 'schemas', 'examples', 'skills']) await copyTree(folder);
for (const file of ['package.json', 'SETUP.md', 'integrations.example.json', '.env.example', 'LICENSE']) {
  await copyFile(path.join(root, file), path.join(resources, file));
}
await mkdir(path.join(resources,'docs'),{recursive:true});
await copyFile(path.join(root,'docs/dependencies.html'),path.join(resources,'docs/dependencies.html'));
await copyTree('tools/addons');
await copyFile(path.join(root,'tools/install-addons.mjs'),path.join(resources,'tools/install-addons.mjs'));
console.log('Staged AgentGlim server resources (no Node runtime or private data).');
