import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitForServerReady } from './helpers/server-ready.mjs';
const resolver = new URL('./fixtures/harness/round-models.mjs', import.meta.url); // frozen fixture, not the owner's harness
const supported = true;
async function server(t, writes) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ag-roles-')),run=path.join(tmp,'plans/_run');
  fs.mkdirSync(path.join(run,'bin'),{recursive:true});
  if(supported)fs.copyFileSync(resolver,path.join(run,'bin/round-models.mjs'));
  fs.mkdirSync(path.join(tmp,'plans/01-fixture'));fs.writeFileSync(path.join(tmp,'plans/01-fixture/PLAN.md'),'# Fixture');
  fs.writeFileSync(path.join(tmp,'plans/01-fixture/ROUND_MODELS'),JSON.stringify({rounds:'codex-astra',workers:'codex-terra',premium:'opus'}));
  fs.writeFileSync(path.join(tmp,'env'),'');fs.writeFileSync(path.join(tmp,'config.json'),'{}');
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,HOME:tmp,USERPROFILE:tmp,AGENTGLIM_ENV_FILE:path.join(tmp,'env'),AGENTGLIM_CONFIG:path.join(tmp,'config.json'),AGENTGLIM_WORK:tmp,AGENTGLIM_PLANS:path.join(tmp,'plans'),AGENTGLIM_PROJECTS:tmp,AGENTGLIM_DEV:'1',AGENTGLIM_DEV_WRITES:writes?'1':'0'};
  const child=spawn(process.execPath,['app/server.mjs','0'],{cwd:path.resolve(import.meta.dirname,'../..'),env,stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit')}});
  const port=await waitForServerReady(child),base=`http://127.0.0.1:${port}`;
  return {base,run,headers:{origin:base,'content-type':'application/json'}};
}

test('Roles route works without a harness and dev protection covers writes',async t=>{
  const {base,run,headers}=await server(t,false);
  if(supported)fs.renameSync(path.join(run,'bin/round-models.mjs'),path.join(run,'bin/round-models.mjs.archived'));
  const page=await(await fetch(base+'/roles')).text();
  assert.match(page,/Who can do what/);assert.match(page,/\/theme.js/);assert.match(page,/id="themeToggle"/);
  assert.equal((await(await fetch(base+'/api/role-models')).json()).available,false);
  assert.equal((await fetch(base+'/api/role-models',{method:'POST',headers,body:'{}'})).status,403);
  const index=await(await fetch(base+'/')).text();assert.match(index,/href="\/roles"/);assert.match(index,/Effective models by role/);
});
test('Roles API applies a validated grid immediately and reports effective plan choices',{skip:!supported},async t=>{
  const {base,run,headers}=await server(t,true);
  const get=()=>fetch(base+'/api/role-models');
  const initial=await(await get()).json();assert.equal(initial.configured,false);
  assert.deepEqual(initial.policy.roles.rounds,['codex-sol','codex-terra','codex-luna','sonnet','opus','opus48']);
  const policy=initial.policy;policy.roles.rounds=['opus','codex-terra'];policy.roles.workers=['sonnet'];policy.roles.focus=['codex-sol'];
  const save=body=>fetch(base+'/api/role-models',{method:'POST',headers,body:JSON.stringify(body)});
  let result=await save(policy);assert.equal(result.status,200);
  const saved=await result.json();assert.equal(saved.configured,true);
  assert.deepEqual(saved.plans[0].roles.rounds.models,['codex-terra','opus']);
  assert.deepEqual(saved.plans[0].roles.workers.models,['sonnet']);
  assert.equal(saved.plans[0].roles.focus.codex,'gpt-6.1-sol');assert.equal(saved.plans[0].roles.focus.claude,null);
  const disk=fs.readFileSync(path.join(run,'role-models.json'),'utf8');
  assert.deepEqual(JSON.parse(disk),saved.policy);assert.equal(fs.existsSync(path.join(run,'mode_queue')),false);
  assert.deepEqual((await(await get()).json()).policy,saved.policy);
  for(const bad of [{},null,{...policy,roles:{...policy.roles,audit:[]}},{...policy,roles:{...policy.roles,verify:['codex-terra']}},{...policy,roles:{...policy.roles,rounds:['unknown']}}]){
    assert.equal((await save(bad)).status,422);assert.equal(fs.readFileSync(path.join(run,'role-models.json'),'utf8'),disk);
  }
  for(const origin of ['https://evil.example',null])assert.equal((await fetch(base+'/api/role-models',{method:'POST',headers:origin?{...headers,origin}:{'content-type':'application/json'},body:JSON.stringify(policy)})).status,403);
  assert.equal((await fetch(base+'/api/role-models',{method:'POST',headers,body:'{'})).status,422);
  assert.equal((await fetch(base+'/api/role-models',{method:'POST',headers,body:' '.repeat(16385)})).status,413);
  assert.equal((await fetch(base+'/api/role-models',{method:'PUT',headers,body:'{}'})).status,405);
  assert.equal((await get()).headers.get('cache-control'),'no-store');
});
