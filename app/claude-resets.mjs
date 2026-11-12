// Read-only Claude usage inspection. This module never clicks or calls a reset action.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HOME, DATA } from './paths.mjs';
import { atomicJson, readJson } from './price-data.mjs';
export const PROFILE = process.env.AGENTGLIM_CLAUDE_PROFILE || path.join(HOME,'.config','agentglim-claude-profile');
export const RESETS_FILE = path.join(DATA,'claude-resets.json');
export const USAGE_URL = 'https://claude.ai/settings/usage';
export function parseResets(text,{now=new Date()}={}) {
  text=String(text).replace(/<[^>]*>/g,'\n').replace(/&nbsp;/g,' ');
  const panel=text.slice(text.search(/Limit resets/i));
  if(!/Limit resets/i.test(text) || !/\d+\s+available/i.test(panel))return null;
  const available=+(panel.match(/(\d+)\s+available/i)?.[1] || 0),resets=[];
  const re=/([A-Za-z][A-Za-z -]*?)\s+reset\s*[,\n:]\s*Expires\s+([A-Z][a-z]+\s+\d{1,2}(?:,\s*\d{4})?,\s*\d{1,2}:\d{2}\s*[AP]M\s*(?:GMT|UTC))([^]*?)(?=(?:[A-Z][A-Za-z -]*?\s+reset\s*[,\n:]\s*Expires)|$)/gi;
  for(const m of panel.matchAll(re)) {
    const raw=m[2].trim(),hasYear=/\b20\d\d\b/.test(raw),dated=hasYear ? raw : raw.replace(/([A-Za-z]+\s+\d+)/,`$1, ${now.getUTCFullYear()}`);
    let at=Date.parse(dated);if(!hasYear && at<now.getTime()-864e5)at=Date.parse(raw.replace(/([A-Za-z]+\s+\d+)/,`$1, ${now.getUTCFullYear()+1}`));
    resets.push({kind:m[1].trim().toLowerCase(),expires:Number.isFinite(at) ? new Date(at).toISOString() : raw,note:m[3].replace(/\[?Reset for free\]?/gi,'').replace(/^\s*[:;,-]\s*/,'').trim().slice(0,800)});
  }
  return {available,resets};
}
export function chromiumPath() {
  const candidates=[process.env.AGENTGLIM_CHROMIUM,'/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  return candidates.find(f=>fs.existsSync(f)) || null;
}
export function seedManualResets(input,{file=RESETS_FILE,replace=false}={}) {
  const previous=readJson(file);if(previous && (Number.isInteger(previous.available) || previous.checkedAt) && !replace)throw new Error('Existing reset evidence preserved');
  if(!input || !Number.isInteger(input.available) || input.available<0 || input.available>100 || !Array.isArray(input.resets))throw new Error('Invalid reset evidence');
  const resets=input.resets.slice(0,100).map(x=>{if(!Number.isFinite(Date.parse(x.expires)))throw new Error('Invalid expiry');return {kind:String(x.kind || 'unknown').slice(0,40),expires:new Date(x.expires).toISOString(),note:String(x.note || '').slice(0,800)};});
  const data={checkedAt:Number.isFinite(Date.parse(input.checkedAt)) ? input.checkedAt : new Date().toISOString(),available:input.available,resets,source:String(input.source || 'local manual evidence').slice(0,120),status:'manual evidence'};
  atomicJson(file,data);return data;
}
export function resetView(file=RESETS_FILE,now=Date.now()) {
  const d=readJson(file) || {status:'login needed',available:null,resets:[]};
  return {...d,resets:(d.resets || []).map(r=>({...r,soon:Date.parse(r.expires)>now && Date.parse(r.expires)-now<7*864e5,expired:Date.parse(r.expires)<=now})),manual:d.status!=='ok',note:d.status==='ok' ? `Last checked ${d.checkedAt}` : 'Check resets manually each day, or sign in once for the daily check.'};
}
export async function checkClaudeResets({login=false,file=RESETS_FILE,profile=PROFILE,dev=process.env.AGENTGLIM_DEV==='1',debug=false,now=new Date(),playwright}={}) {
  if(dev)return {skipped:'dev copy'};
  const old=readJson(file) || {},checkedAt=now.toISOString();let context;
  const save=(status,extra={})=>{const d={...old,...extra,status,lastAttempt:checkedAt,...(status==='ok' ? {checkedAt,source:'claude.ai Settings Usage (read only)'} : {})};atomicJson(file,d);return d;};
  if(!login && !fs.existsSync(profile))return save('login needed');
  const executablePath=chromiumPath();if(!executablePath)return save('Chromium not detected');
  try {
    let engine=playwright; if(!engine)try{engine=await import('playwright');}catch{engine=createRequire(path.join(DATA,'package.json'))('playwright');}
    const {chromium}=engine;
    context=await chromium.launchPersistentContext(profile,{executablePath,headless:!login,viewport:{width:1280,height:900}});
    const page=context.pages()[0] || await context.newPage();await page.goto(USAGE_URL,{waitUntil:'domcontentloaded',timeout:45000});
    if(login) {
      // Human interaction only. No login automation, reset clicks, or background reset requests.
      await new Promise(resolve=>context.on('close',resolve));context=null;return {status:'Sign-in window closed; daily check will verify login'};
    }
    const heading=page.getByText('Limit resets',{exact:true}).first();
    try{await heading.waitFor({timeout:20000});}catch{return save('login needed');}
    const text=await heading.evaluate(el=>{let p=el;for(let n=0;p && n<8;n++,p=p.parentElement){const t=p.innerText || '';if(/\d+\s+available/i.test(t) && (/Expires/i.test(t) || /0\s+available/i.test(t)))return t;}return '';});
    const parsed=parseResets(text,{now});if(!parsed)return save('Panel format changed; check manually');
    return save('ok',parsed);
  } catch(e) {
    if(debug && context)try{await context.pages()[0]?.screenshot({path:path.join(DATA,'claude-resets-debug.png')});}catch{}
    return save(['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(e.code) ? 'Playwright not detected' : 'Check unavailable; check manually');
  } finally {await context?.close().catch(()=>{});}
}
export function startResetChecks(enabled=()=>true) {
  if(process.env.AGENTGLIM_DEV==='1')return;
  let busy=false;
  const run=async()=>{if(busy || !enabled())return;const last=readJson(RESETS_FILE);if(Date.now()-Date.parse(last?.lastAttempt || last?.checkedAt || '')<864e5)return;busy=true;try{await checkClaudeResets();}finally{busy=false;}};
  run().catch(()=>{});return setInterval(()=>run().catch(()=>{}),3600e3).unref();
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const index=process.argv.indexOf('--seed');
  const result=index>=0 ? seedManualResets(readJson(process.argv[index+1]),{replace:process.argv.includes('--replace')}) : await checkClaudeResets({login:process.argv.includes('--login'),debug:process.argv.includes('--debug')});console.log(JSON.stringify(result));
}
