import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, RUN } from './paths.mjs';
import { loadSetup } from './setup.mjs';
import { sameAppRequest } from './open-url-rules.mjs';
import { checkDeps, startupCheck } from './deps.mjs';
import { scanSkills } from './skills.mjs';
import { createLimitsPoller } from './limits.mjs';
import { createProcGuard } from './proc-guard.mjs';
import { listProcesses } from './proc.mjs';
import { seedManualResets, resetView, RESETS_FILE, startResetChecks, checkClaudeResets } from './claude-resets.mjs';
import { atomicJson, loadPrices, startPriceChecks, readJson } from './price-data.mjs';
import { AGENTGLIM_ROOT } from './settings.mjs';
import { superagentBeat, HEARTBEAT_MS } from './watchers.mjs';
const dev=process.env.AGENTGLIM_DEV==='1';
export function driverActive() {
  try {
    const pid=+fs.readFileSync(path.join(RUN,'driver.pid'),'utf8');if(!Number.isInteger(pid) || pid<=1)return false;
    return listProcesses().some(p => p.pid === pid && p.args.some(arg => /driver\.mjs$/.test(arg)));
  } catch{return false;}
}
export const usagePoller=createLimitsPoller({driverAlive:driverActive});
export const procGuard=createProcGuard();
// a SuperAgent is around when any of its heartbeats is fresh (45 min): its private data heartbeat, the harness's
// heartbeats folder (auditq-wait, superagent-check, ...), the audit queue's .alive, or the Codex bridge health file.
// One source of truth with the dashboard's header dot: superagentBeat() in app/watchers.mjs.
export function watcherActive(now=Date.now(),{data=DATA,run=RUN}={}) {
  const at=superagentBeat({data,run});
  return !!at && now-at<HEARTBEAT_MS;
}
export function portableState() {
  const config=loadSetup(),limits=usagePoller.view(),watcher=watcherActive(),stale=limits.length>0 && limits.every(x=>x.stale) || driverActive() && Date.now()-(readJson(path.join(RUN,'budget.json'))?.at || Date.now())>15*60e3;
  // setupFilled (= setupFilled() in setup.mjs) is the only input that may open the "Your AI agent" popup; stale and
  // watcher only drive the small banner on a configured install (agent-notice.mjs). setupComplete: same value, older name.
  const filled=!!config.setupComplete;
  return {at:Date.now(),setupFilled:filled,setupComplete:filled,watcher,stale,limits,guard:procGuard.view(),claudeResets:config.subs.claude.on ? resetView() : null};
}
export function startPortable() {
  fs.mkdirSync(path.join(DATA,'flags'),{recursive:true});fs.mkdirSync(path.join(DATA,'heartbeats'),{recursive:true});startupCheck();
  usagePoller.start();startPriceChecks();startResetChecks(()=>loadSetup().subs.claude.on);
  try{procGuard.start();}catch(e){console.error('Process guard unavailable:',e.code || 'scan failed');}
}
let login=null;
export async function portableRoute(req,res,route) {
  const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));return true;};
  if(req.method==='GET') {
    if(route==='/api/addons')return send(200,{dependencies:checkDeps(),prices:loadPrices(),claudeResets:resetView()});
    if(route==='/api/skills')return send(200,{skills:scanSkills()});
    if(route==='/api/portable')return send(200,portableState());
    if(route==='/api/proc-guard')return send(200,procGuard.view());
    return false;
  }
  if(!['/api/proc-guard/stop','/api/proc-guard/allow','/api/claude-resets/login','/api/claude-resets/seed','/api/refresh'].includes(route))return false;
  if(req.method!=='POST')return send(405,{error:'POST only'});
  if(!sameAppRequest(req.headers) || req.headers.origin!==`http://${req.headers.host}` || req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'same-origin only'});
  if(dev)return send(403,{error:'Disabled in dev copy'});
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>8192)return send(413,{error:'Too large'});}let body;try{body=JSON.parse(raw || '{}');}catch{return send(400,{error:'Invalid JSON'});}
  try {
    if(route==='/api/proc-guard/stop')return send(200,await procGuard.stop(body.pid,String(body.start)));
    if(route==='/api/proc-guard/allow')return send(200,procGuard.allow(body.pid,String(body.start)));
    if(route==='/api/refresh'){await usagePoller.tick();return send(200,portableState());}
    if(route==='/api/claude-resets/seed') {
      // Explicit local owner evidence, never a packaged default or fresh-user sample.
      if(readJson(RESETS_FILE)?.checkedAt && !body.replace)return send(409,{error:'Existing reset evidence preserved'});
      if(!Number.isInteger(body.available) || !Array.isArray(body.resets))return send(422,{error:'Invalid reset evidence'});
      seedManualResets(body,{replace:!!body.replace});return send(200,{ok:true});
    }
    if(login)return send(202,{ok:true,status:'Sign-in window already open'});
    const child=spawn(process.execPath,[path.join(AGENTGLIM_ROOT,'app','claude-resets.mjs'),'--login'],{cwd:AGENTGLIM_ROOT,stdio:'ignore',env:process.env});
    login=child;child.on('error',()=>{login=null;});child.on('close',()=>{login=null;checkClaudeResets().catch(()=>{});});
    return send(202,{ok:true,status:'Sign in to claude.ai in the dedicated browser window, then close it.'});
  } catch(e) {return send(400,{error:/protected|changed|dev copy/.test(e.message) ? e.message : 'Action unavailable; refresh and check the add-on status.'});}
}
