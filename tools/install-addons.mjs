// Explicit opt-in installer. Existing user commands/skills are preserved, never replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const index=process.argv.indexOf('--prefix'),prefix=index>=0 ? path.resolve(process.argv[index+1]) : path.join(os.homedir(),'.local');
const dry=process.argv.includes('--dry-run');
function link(source,destination) {
  try { if(fs.existsSync(destination) || fs.lstatSync(destination).isSymbolicLink()){console.log(`Preserved existing ${path.basename(destination)}`);return;} }catch{}
  console.log(`${dry ? 'Would install':'Install'} ${path.relative(root,source)} -> ${destination.replace(os.homedir(),'~')}`);
  if(dry)return;
  try {
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    if(process.platform==='win32') {
      if(fs.statSync(source).isDirectory())fs.cpSync(source,destination,{recursive:true});
      else { fs.copyFileSync(source,destination);fs.writeFileSync(destination+'.cmd',`@echo off\r\npython "${source}" %*\r\n`); }
    } else fs.symlinkSync(path.relative(path.dirname(destination),source),destination,fs.statSync(source).isDirectory() ? 'dir':'file');
  }catch(e){console.error(`Could not install ${path.basename(destination)} (${e.code}); bundled source remains available.`);process.exitCode=1;}
}
for(const [name,file] of [['jobs-track','jobs-track.py'],['jev-gate','jev-gate'],['agent-notify','agent-notify']])link(path.join(root,'tools/addons',file),path.join(prefix,'bin',name));
if(!process.argv.includes('--commands-only')) for(const harness of ['.claude','.agents'])for(const skill of JSON.parse(fs.readFileSync(path.join(root,'app/bundled-skills.json'),'utf8')))if(fs.existsSync(path.join(root,'skills',skill,'SKILL.md')))link(path.join(root,'skills',skill),path.join(root,harness,'skills',skill));
