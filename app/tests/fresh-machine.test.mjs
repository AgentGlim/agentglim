import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import net from 'node:net';
async function port(){const s=net.createServer();s.listen(0,'127.0.0.1');await once(s,'listening');const p=s.address().port;await new Promise(r=>s.close(r));return p;}
test('fresh HOME, WORK unset, no plans: Setup, popups, skills and latest-reading fallback work',async t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'ag-fresh-')),p=await port(),data=path.join(home,'.agentglim');
  fs.writeFileSync(path.join(home,'env'),'');fs.mkdirSync(path.join(data,'flags'),{recursive:true});
  fs.writeFileSync(path.join(data,'setup.json'),JSON.stringify({harnesses:{codex:true},subs:{codex:{on:true,entries:[{tier:'pro100',credential:'~/.codex/auth.json'}]},claude:{on:false},go:{on:false}}}));
  fs.writeFileSync(path.join(data,'flags/codex-usage.json'),JSON.stringify({at:Date.now(),windows:[{label:'7d',pct:37}]}));
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:home,USERPROFILE:home,AGENTGLIM_ENV_FILE:path.join(home,'env'),AGENTGLIM_DEV:'1'};
  assert.equal(env.AGENTGLIM_WORK,undefined);
  const srv=spawn(process.execPath,['app/server.mjs',String(p)],{cwd:path.resolve(import.meta.dirname,'../..'),env,stdio:'ignore'});
  t.after(async()=>{srv.kill();if(srv.exitCode===null)await once(srv,'exit');});
  const base=`http://127.0.0.1:${p}`;let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(base+'/api/setup')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready);
  const setup=await(await fetch(base+'/api/setup')).json();assert.equal(setup.config.setupComplete,false);assert.equal(setup.config.file,'~/.agentglim/setup.json');assert.equal(setup.detected.plans.found,false);assert.equal(setup.detected.plans.path,'~/.agentglim/plans');
  assert.equal((await fetch(base+'/setup')).status,200);assert.equal((await fetch(base+'/skills')).status,200);
  const html=await(await fetch(base+'/')).text();assert.match(html,/id="skillsLink" href="\/skills"/);
  const snap=await(await fetch(base+'/api/snapshot')).json();assert.equal(snap.limits.length,1);assert.equal(snap.limits[0].windows[0].pct,37);assert.equal(snap.limits[0].stale,false);assert.equal(snap.portable.claudeResets,null);
  assert.deepEqual(snap.integrations,{leads:false,emailseq:false});assert.equal(snap.leads,null);assert.equal(snap.emailSeq,null);assert.equal(snap.fleet,null);
  const fleet=await(await fetch(base+'/api/fleet')).json();assert.equal(fleet.state,'not_set_up');assert.equal(fleet.fleet,null);
  const script=await(await fetch(base+'/portable-ui.js')).text();assert.match(script,/your AI agent/);assert.match(script,/agentNotice/);assert.match(script,/SuperAgent/);
  assert.match(await(await fetch(base+'/agent-notice.mjs')).text(),/setupFilled/);assert.equal((await(await fetch(base+'/api/portable')).json()).setupFilled,false); // partial file: the popup stays
  const origin={origin:base,'content-type':'application/json'};
  for(const route of ['/api/claude-resets/login','/api/proc-guard/stop','/api/proc-guard/allow','/api/refresh'])assert.equal((await fetch(base+route,{method:'POST',headers:origin,body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/setup',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{}'})).status,403);
  const saved=await fetch(base+'/api/setup',{method:'POST',headers:origin,body:JSON.stringify({...setup.config,budget:{apiDailyUsd:3}})});assert.equal(saved.status,200);assert.ok(fs.existsSync(path.join(data,'setup-complete')));assert.ok(fs.existsSync(path.join(data,'budget.json')));assert.equal(JSON.parse(fs.readFileSync(path.join(data,'budget.json'),'utf8')).apiDailyUsd,3);assert.ok(fs.existsSync(path.join(data,'flags')));
  const skills=await(await fetch(base+'/api/skills')).json();assert.equal(skills.skills.filter(s=>s.bundled).length,6);
  assert.equal(fs.existsSync(path.join(home,'dev/projects/plans')),false);
});
