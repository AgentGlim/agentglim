import fs from 'node:fs';
import path from 'node:path';
import { DATA, PLANS } from '../../app/paths.mjs';
import { approvals } from '../../app/approvals.mjs';
import { inject } from '../design-all/scroll-perf.mjs';
export const GEN_META='<meta name="generator" content="agentglim project status">';
export function sourcesMtime(root,dir){return Math.max(0,...['PLAN.md','index.html','VERIFY.md','_build/DEFERRED.md'].map(f=>{try{return fs.statSync(path.join(root,dir,f)).mtimeMs;}catch{return 0;}}));}
const esc=s=>String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function build(dir,{root=PLANS}={}) {
  if(!/^[\w.-]+$/.test(dir) || dir.startsWith('.'))throw new Error('Invalid project directory');
  const folder=path.join(root,dir),out=path.join(folder,'approvals.html');if(!fs.statSync(folder).isDirectory())throw new Error('Project not found');
  const old=fs.existsSync(out) ? fs.readFileSync(out,'utf8') : '';if(old && !old.includes(GEN_META))return {skipped:'Hand-authored page preserved'};
  const items=(approvals().items || []).filter(i=>i.project===dir),css=fs.readFileSync(new URL('../theme/theme.css',import.meta.url),'utf8');
  const html=inject(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${GEN_META}<title>${esc(dir)} · Project status</title><style>${css}</style></head><body><main><a href="index.html">Project home</a><h1>Approvals and next steps</h1><p>Updated ${new Date().toISOString()}. Status comes from local project evidence.</p>${items.filter(i=>!i.done).map(i=>`<section><h2>${esc(i.title)}</h2><p>${esc(i.detail || '')}</p>${i.cmd ? `<code>${esc(i.cmd)}</code>`:''}</section>`).join('') || '<p>No pending approval items.</p>'}<details><summary>Completed items</summary>${items.filter(i=>i.done).map(i=>`<p>${esc(i.title)}</p>`).join('') || '<p>No completed items recorded.</p>'}</details></main></body></html>`);
  if(old)fs.copyFileSync(out,`${out}.bak-${new Date().toISOString().slice(0,10).replaceAll('-','')}-status`);fs.writeFileSync(out,html);
  const index=path.join(folder,'index.html');if(fs.existsSync(index)){let text=fs.readFileSync(index,'utf8');if(!text.includes('href="approvals.html"')){fs.copyFileSync(index,index+'.bak-'+new Date().toISOString().slice(0,10).replaceAll('-','')+'-status');text=text.replace('</body>','<p><a href="approvals.html">Approvals and next steps</a></p></body>');fs.writeFileSync(index,text);}}
  return {wrote:'approvals.html',items:items.length};
}
