import fs from 'node:fs';
import path from 'node:path';
import { HOME, RUN, PROJECTS, DATA } from './paths.mjs';
import { AGENTGLIM_ROOT } from './settings.mjs';
import { keyNames, keySource } from './env.mjs';
import { readJson } from './price-data.mjs';
export const manifest=readJson(new URL('./deps.json',import.meta.url),{dependencies:[]});
export function findBinary(bin,{env=process.env,home=HOME,platform=process.platform,exists=f=>{try{return fs.statSync(f).isFile() && (fs.accessSync(f,fs.constants.X_OK),true);}catch{return false;}}}={}) {
  const paths=platform==='win32' ? path.win32 : path.posix;
  const dirs=[...(env.PATH || env.Path || '').split(paths.delimiter),...['.local/bin','.npm-global/bin','.bun/bin','.opencode/bin','.cargo/bin'].map(d=>paths.join(home,d)),'/usr/local/bin','/opt/homebrew/bin'];
  const suffixes=platform==='win32' ? ['',...(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  for(const dir of dirs.filter(Boolean))for(const suffix of suffixes){const f=paths.join(dir.replace(/^"(.*)"$/, '$1'),bin+suffix);if(exists(f))return f;}return null;
}
export function checkDeps({catalog=manifest,exists=fs.existsSync,binary=findBinary,home=HOME,root=AGENTGLIM_ROOT,run=RUN,projects=PROJECTS}={}) {
  const expand=p=>p.replace(/^~(?=\/|$)/,home).replace('{root}',root).replace('{run}',run).replace('{projects}',projects).replace('{data}',DATA).replace('{programfiles}',process.env.PROGRAMFILES || '/nonexistent');
  return catalog.dependencies.map(item=>{const keyFound=(item.env || []).some(base=>keyNames(base).some(n=>!!keySource(n)));const binaryFound=(item.bins || []).some(b=>!!binary(b));const bundled=(item.paths || []).some(p=>p.includes('{root}') && exists(expand(p)));const pathFound=(item.paths || []).some(p=>exists(expand(p)));return {...item,detected:binaryFound || pathFound || keyFound,bundled,status:binaryFound || pathFound || keyFound ? 'detected':'not detected'};});
}
export function startupCheck(){const items=checkDeps();for(const d of items)if(d.required && !d.detected)console.error(`AgentGlim dependency missing: ${d.name}. ${d.missing}`);return items;}
