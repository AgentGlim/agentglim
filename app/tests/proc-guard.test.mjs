import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readProcess,evaluateProcesses,createProcGuard,safeCommand} from '../proc-guard.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ag-proc-'));
function proc(root,pid,{ppid=1,start='100000',comm='python3',args=['python3','-'],rss=30000,tty=0,env=['CODEX_FIXTURE=1'],uid=1000}={}) {
  const dir=path.join(root,String(pid));fs.mkdirSync(path.join(dir,'fd'),{recursive:true});
  const a=Array(50).fill('0');a[0]='S';a[1]=String(ppid);a[4]=String(tty);a[19]=start;
  fs.writeFileSync(path.join(dir,'stat'),`${pid} (${comm}) ${a.join(' ')}`);fs.writeFileSync(path.join(dir,'status'),`Uid:\t${uid}\t${uid}\t${uid}\t${uid}\nVmRSS:\t${rss} kB\n`);fs.writeFileSync(path.join(dir,'cmdline'),args.join('\0')+'\0');fs.writeFileSync(path.join(dir,'environ'),env.join('\0')+'\0');fs.writeFileSync(path.join(root,'uptime'),'9000 1000');
}
const read=(root,pid)=>readProcess(pid,{root,uid:1000,ticks:100,now:1000});
test('fake /proc parser handles comm spaces, RSS, start time, uid and agent environment',()=>{
  const root=temp();proc(root,100,{comm:'python (fixture)'});const p=read(root,100);assert.equal(p.start,'100000');assert.equal(p.ageMs,8000000);assert.equal(p.rss,30000*1024);assert.equal(p.agentEnv,true);assert.equal(readProcess(100,{root,uid:2000}),null);
});
test('guard flags unattended hour-long tool process and records parent harness',()=>{
  const root=temp();proc(root,100,{ppid:99});proc(root,99,{comm:'codex',args:['codex'],env:[]});const flagged=evaluateProcesses([read(root,100),read(root,99)]);assert.equal(flagged.length,1);assert.equal(flagged[0].pid,100);assert.match(flagged[0].startedBy,/codex/);
});
test('guard protects tracked descendants, servers, terminals, driver, self, allowlist and other users',()=>{
  const root=temp();proc(root,100,{ppid:99});proc(root,99,{comm:'codex',args:['codex']});let list=[read(root,100),read(root,99)];
  assert.equal(evaluateProcesses(list,{jobs:[{pid:99,status:'running'}]}).length,0);assert.equal(evaluateProcesses(list,{allowed:{100:'100000'}}).length,0);assert.equal(evaluateProcesses(list,{self:100}).length,0);
  for(const args of [['node','server.mjs'],['node','driver.mjs','run'],['python3','-m','http.server']]){proc(root,100,{args});assert.equal(evaluateProcesses([read(root,100)]).length,0);}
  proc(root,100,{tty:1});assert.equal(evaluateProcesses([read(root,100)]).length,0);
  proc(root,100,{tty:0});fs.symlinkSync('/dev/pts/4',path.join(root,'100/fd/0'));assert.equal(evaluateProcesses([read(root,100)]).length,0);
});
test('listening socket excludes a server even with an unrecognized executable name',()=>{
  const root=temp();proc(root,100,{comm:'custom',args:['custom']});fs.mkdirSync(path.join(root,'net'));fs.writeFileSync(path.join(root,'net/tcp'),'header\n0: 00000000:1234 00000000:0000 0A 0 0 0 0 0 456\n');fs.symlinkSync('socket:[456]',path.join(root,'100/fd/4'));assert.equal(evaluateProcesses([read(root,100)]).length,0);
});
test('memory growth compares same process identity, and PID reuse discards baseline',()=>{
  const root=temp();proc(root,100,{start:'899000',rss:700000});const p=read(root,100);assert.equal(evaluateProcesses([p],{samples:{100:{start:'899000',minRss:1000}}})[0].reason,'Grew over 500 MB');assert.equal(evaluateProcesses([p],{samples:{100:{start:'old',minRss:1000}}}).length,0);
});
test('Stop sends exact PID SIGTERM; revalidated SIGKILL and every stop are logged',async()=>{
  const root=temp(),data=temp();proc(root,100);const calls=[];let delayed;
  const g=createProcGuard({root,data,uid:1000,ticks:100,dev:false,jobs:()=>[],config:()=>({}),signal:(pid,s)=>calls.push([pid,s]),delay:fn=>{delayed=fn;}});g.scan();await g.stop(100,'100000');assert.deepEqual(calls,[[100,'SIGTERM']]);delayed();assert.deepEqual(calls[1],[100,'SIGKILL']);assert.equal(fs.readFileSync(path.join(data,'proc-guard.ndjson'),'utf8').trim().split('\n').length,2);
});
test('Stop refuses changed PID, Allow is lifetime-specific, and dev mode cannot signal',async()=>{
  const root=temp(),data=temp();proc(root,100);let delayed;const calls=[];
  const opts={root,data,uid:1000,ticks:100,jobs:()=>[],config:()=>({}),signal:(...args)=>calls.push(args),delay:fn=>{delayed=fn;},dev:false};const g=createProcGuard(opts);g.scan();await assert.rejects(g.stop(100,'wrong'),/changed|protected/);await g.stop(100,'100000');proc(root,100,{start:'100100'});delayed();assert.equal(calls.length,1);g.allow(100,'100100');assert.equal(g.scan().flagged.length,0);proc(root,100,{start:'100200'});assert.equal(g.scan().flagged.length,1);const dev=createProcGuard({...opts,dev:true});await assert.rejects(dev.stop(100,'100200'),/dev/);
});
test('commands redact secrets, URLs, inline scripts and opaque tokens before truncation',()=>{
  const cmd=safeCommand(['python3','-c','print("sensitive")','--api-key=fixture-secret','--token','private-token','https://example.com/?token=value','z'.repeat(60)]);assert.ok(!cmd.includes('sensitive'));assert.ok(!cmd.includes('fixture-secret'));assert.ok(!cmd.includes('private-token'));assert.ok(!cmd.includes('token=value'));assert.ok(!cmd.includes('z'.repeat(40)));assert.ok(cmd.length<=180);
});
test('harness loops, owner dev servers and their listening children are known, not flagged; paths stay readable',()=>{
  const root=temp(),run='/srv/plans/_run';
  const flag=(p,list)=>evaluateProcesses(list || [p],{harness:[run]});
  proc(root,100,{args:['bash','bin/hang-reaper.sh']});fs.symlinkSync(run,path.join(root,'100/cwd'));assert.equal(flag(read(root,100)).length,0);
  proc(root,101,{args:['bash',`${run}/bin/mem-watch.sh`]});assert.equal(flag(read(root,101)).length,0);
  proc(root,102,{args:['npm','run','dev']});assert.equal(flag(read(root,102)).length,0);
  proc(root,103,{args:['node','worker.js']});proc(root,104,{ppid:103,args:['node','child.js']});fs.mkdirSync(path.join(root,'net'),{recursive:true});fs.writeFileSync(path.join(root,'net/tcp'),'header\n0: 00000000:1234 00000000:0000 0A 0 0 0 0 0 789\n');fs.symlinkSync('socket:[789]',path.join(root,'104/fd/5'));
  assert.equal(flag(read(root,103),[read(root,103),read(root,104)]).length,0);
  proc(root,105,{args:['python3','long_job.py']});assert.equal(flag(read(root,105)).length,1); // a real unattended tool process is still flagged
  assert.equal(safeCommand(['bash','/srv/plans/_run/bin/mem-watch.sh']),'bash /srv/plans/_run/bin/mem-watch.sh');
  assert.match(safeCommand(['tool','abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789']),/opaque argument/);
});
