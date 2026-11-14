// Inventory only. Never copy, execute or alter a machine's personal skills.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.mjs';
import { readJson } from './price-data.mjs';
const bundledNames=readJson(new URL('./bundled-skills.json',import.meta.url),[]);
import { AGENTGLIM_ROOT } from './settings.mjs';
// The one list of skill roots: the read-only inventory (scanSkills) and the Skill Editor both use it.
// AGENTGLIM_SKILL_ROOTS adds more folders (path-separator separated); nothing here is a project-specific path.
export function skillRoots({home=HOME,root=AGENTGLIM_ROOT,extra=[]}={}) {
  const roots=[['Claude',path.join(home,'.claude','skills')],['Agents',path.join(home,'.agents','skills')],['Codex',path.join(home,'.codex','skills')],['Claude project',path.join(root,'.claude','skills')],['Agents project',path.join(root,'.agents','skills')],['Codex project',path.join(root,'.codex','skills')],['Claude plugins',path.join(home,'.claude','plugins','cache')],['Codex plugins',path.join(home,'.codex','plugins','cache')],['Bundled',path.join(root,'skills')]];
  const more=(extra || []).length ? extra : String(process.env.AGENTGLIM_SKILL_ROOTS || '').split(path.delimiter).filter(Boolean);
  for(const dir of more){const p=String(dir).replace(/^~(?=[\\/]|$)/,home);if(!p)continue;roots.push([`Extra ${path.basename(p) || 'skills'}`,path.resolve(p)]);}
  return roots;
}
export function scanSkills({home=HOME,root=AGENTGLIM_ROOT,limit=10000,extra}={}) {
  const roots=skillRoots({home,root,extra});
  const found=new Map();let visited=0;
  let bundledRoot;try{bundledRoot=fs.realpathSync(path.join(root,'skills'));}catch{}
  function walk(dir,harness,depth,seen=new Set()) {
    if(depth<0 || visited++>limit)return;
    let real;try{real=fs.realpathSync(dir);if(seen.has(real))return;seen.add(real);}catch{return;}
    const file=path.join(dir,'SKILL.md');
    if(fs.existsSync(file))try {
      const size=fs.statSync(file).size;if(size>131072)return;
      const text=fs.readFileSync(file,'utf8'),front=/^---\s*\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
      const value=key=>{const match=front.match(new RegExp(`^${key}:\\s*(.+)$`,'m'));if(!match)return '';let v=match[1];if(/^[>|]-?$/.test(v))v=front.slice(match.index+match[0].length).split('\n').slice(1).filter(x=>/^\s+/.test(x)).map(x=>x.trim()).join(' ');return v.replace(/^['"]|['"]$/g,'');};
      const id=fs.realpathSync(file),old=found.get(id),bundled=Boolean(bundledRoot && real.startsWith(bundledRoot+path.sep) && (bundledNames.includes(path.basename(real)) || root!==AGENTGLIM_ROOT));
      found.set(id,{name:value('name') || path.basename(dir),description:value('description').slice(0,800),harness:[...new Set([...(old?.harness || []),harness])],path:dir.replace(home,'~'),bundled});return;
    }catch{}
    try{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name==='node_modules' || e.name.startsWith('.') || /bak|_archive/.test(e.name))continue;if(e.isDirectory() || e.isSymbolicLink())walk(path.join(dir,e.name),harness,depth-1,new Set(seen));}}catch{}
  }
  for(const [harness,dir] of roots)walk(dir,harness,8);
  return [...found.values()].sort((a,b)=>Number(b.bundled)-Number(a.bundled) || a.name.localeCompare(b.name));
}
