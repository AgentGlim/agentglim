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
test('Linux /proc link evidence preserves terminal, socket and cwd protection on every host',t=>{
  const root=temp();proc(root,100);
  const fd=path.join(root,'100','fd');
  for(const n of ['0','4'])fs.writeFileSync(path.join(fd,n),'');
  fs.mkdirSync(path.join(root,'net'));
  fs.writeFileSync(path.join(root,'net','tcp'),'header\n0: 00000000:1234 00000000:0000 0A 0 0 0 0 0 456\n');
  const links=new Map([
    [path.join(fd,'0'),'/dev/pts/4'],
    [path.join(fd,'4'),'socket:[456]'],
    [path.join(root,'100','cwd'),'/srv/plans/_run'],
  ]);
  // Inject procfs link text; native Windows symlinks cannot represent this evidence.
  const readlink=fs.readlinkSync;
  t.mock.method(fs,'readlinkSync',(file,...args)=>links.has(file) ? links.get(file) : readlink(file,...args));
  const p=read(root,100);
  assert.equal(p.tty,true);assert.equal(p.socket,true);assert.equal(p.cwd,'/srv/plans/_run');
  assert.deepEqual(evaluateProcesses([p]),[]);
});
test('guard flags unattended hour-long tool process and records parent harness',()=>{
  const root=temp();proc(root,100,{ppid:99});proc(root,99,{comm:'codex',args:['codex'],env:[]});const flagged=evaluateProcesses([read(root,100),read(root,99)]);assert.equal(flagged.length,1);assert.equal(flagged[0].pid,100);assert.match(flagged[0].startedBy,/codex/);
});
test('guard protects tracked descendants, servers, terminals, driver, self, allowlist and other users',()=>{
  const root=temp();proc(root,100,{ppid:99});proc(root,99,{comm:'codex',args:['codex']});let list=[read(root,100),read(root,99)];
  assert.equal(evaluateProcesses(list,{jobs:[{pid:99,status:'running'}]}).length,0);assert.equal(evaluateProcesses(list,{allowed:{100:'100000'}}).length,0);assert.equal(evaluateProcesses(list,{self:100}).length,0);
  for(const args of [['node','server.mjs'],['node','driver.mjs','run'],['python3','-m','http.server']]){proc(root,100,{args});assert.equal(evaluateProcesses([read(root,100)]).length,0);}
  proc(root,100,{tty:1});assert.equal(evaluateProcesses([read(root,100)]).length,0);
  // Inject terminal evidence: Windows symlinks normalize /dev/pts targets and need privileges.
  proc(root,100,{tty:0});assert.equal(evaluateProcesses([{...read(root,100),tty:true}]).length,0);
});
test('listening socket excludes a server even with an unrecognized executable name',()=>{
  const root=temp();proc(root,100,{comm:'custom',args:['custom']});
  assert.equal(evaluateProcesses([{...read(root,100),socket:true}]).length,0);
});
test('memory growth compares same process identity, and PID reuse discards baseline',()=>{
  const root=temp();proc(root,100,{start:'899000',rss:700000});const p=read(root,100);assert.equal(evaluateProcesses([p],{samples:{100:{start:'899000',minRss:1000}}})[0].reason,'Grew over 500 MB');assert.equal(evaluateProcesses([p],{samples:{100:{start:'old',minRss:1000}}}).length,0);
});
// Explicit backend injection exercises Linux signals on every host; Windows uses Option B below.
test('Linux Stop sends exact PID SIGTERM; revalidated SIGKILL and every stop are logged',async()=>{
  const root=temp(),data=temp();proc(root,100);const calls=[];let delayed;
  const g=createProcGuard({platform:'linux',root,data,uid:1000,ticks:100,dev:false,jobs:()=>[],config:()=>({}),signal:(pid,s)=>calls.push([pid,s]),delay:fn=>{delayed=fn;}});g.scan();await g.stop(100,'100000');assert.deepEqual(calls,[[100,'SIGTERM']]);delayed();assert.deepEqual(calls[1],[100,'SIGKILL']);assert.equal(fs.readFileSync(path.join(data,'proc-guard.ndjson'),'utf8').trim().split('\n').length,2);
});
test('Linux Stop refuses changed PID, Allow is lifetime-specific, and dev mode cannot signal',async()=>{
  const root=temp(),data=temp();proc(root,100);let delayed;const calls=[];
  const opts={platform:'linux',root,data,uid:1000,ticks:100,jobs:()=>[],config:()=>({}),signal:(...args)=>calls.push(args),delay:fn=>{delayed=fn;},dev:false};const g=createProcGuard(opts);g.scan();await assert.rejects(g.stop(100,'wrong'),/changed|protected/);await g.stop(100,'100000');proc(root,100,{start:'100100'});delayed();assert.equal(calls.length,1);g.allow(100,'100100');assert.equal(g.scan().flagged.length,0);proc(root,100,{start:'100200'});assert.equal(g.scan().flagged.length,1);const dev=createProcGuard({...opts,dev:true});await assert.rejects(dev.stop(100,'100200'),/dev/);
});
test('commands redact secrets, URLs, inline scripts and opaque tokens before truncation',()=>{
  const cmd=safeCommand(['python3','-c','print("sensitive")','--api-key=fixture-secret','--token','private-token','https://example.com/?token=value','z'.repeat(60)]);assert.ok(!cmd.includes('sensitive'));assert.ok(!cmd.includes('fixture-secret'));assert.ok(!cmd.includes('private-token'));assert.ok(!cmd.includes('token=value'));assert.ok(!cmd.includes('z'.repeat(40)));assert.ok(cmd.length<=180);
});
test('harness loops, owner dev servers and their listening children are known, not flagged; paths stay readable',()=>{
  const root=temp(),run='/srv/plans/_run';
  const flag=(p,list)=>evaluateProcesses(list || [p],{harness:[run]});
  proc(root,100,{args:['bash','bin/hang-reaper.sh']});assert.equal(flag({...read(root,100),cwd:run}).length,0);
  proc(root,101,{args:['bash',`${run}/bin/mem-watch.sh`]});assert.equal(flag(read(root,101)).length,0);
  proc(root,102,{args:['npm','run','dev']});assert.equal(flag(read(root,102)).length,0);
  proc(root,103,{args:['node','worker.js']});proc(root,104,{ppid:103,args:['node','child.js']});
  assert.equal(flag(read(root,103),[read(root,103),{...read(root,104),socket:true}]).length,0);
  proc(root,105,{args:['python3','long_job.py']});assert.equal(flag(read(root,105)).length,1); // a real unattended tool process is still flagged
  assert.equal(safeCommand(['bash','/srv/plans/_run/bin/mem-watch.sh']),'bash /srv/plans/_run/bin/mem-watch.sh');
  assert.match(safeCommand(['tool','abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOP0123456789']),/opaque argument/);
});

// OS evidence is injected: these Windows paths execute on Linux without real signals.
import { queryWindowsProcess, stopWindowsProcess, registeredWindowsProcesses } from '../windows-processes.mjs';
const winStart=ms=>(BigInt(ms)*10000n+116444736000000000n).toString();
function windowsFixture() {
  const data=temp(), calls=[], queries=[], table=new Map(), now=10_000_000;
  const identity={pid:451,start:winStart(now-7200e3),executable:'C:\\tools\\worker.exe'};
  const dir=path.join(data,'launched-processes');fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'451.json'),JSON.stringify(identity));
  table.set(451,{...identity,rss:30000});
  let timeout;
  const g=createProcGuard({platform:'win32',data,now:()=>now,dev:false,jobs:()=>[],config:()=>({}),
    windowsQuery:pid=>{queries.push(pid);return table.get(pid);},windowsStop:(pid,force)=>calls.push([pid,force]),delay:fn=>{timeout=fn;}});
  return {g,table,calls,queries,identity,data,timeout:()=>timeout()};
}
test('Windows only queries registered launch identities and leaves arbitrary user processes alone',async()=>{
  const f=windowsFixture();f.table.set(999,{...f.identity,pid:999});
  assert.deepEqual(f.g.scan().flagged.map(p=>p.pid),[451]);
  assert.equal(f.g.view().unsupported,false);
  assert.equal(f.g.view().scope,'registered launches');
  await assert.rejects(f.g.stop(999,f.identity.start),/protected/);
  assert.deepEqual(f.calls,[]);assert.ok(!f.queries.includes(999));
  assert.equal(registeredWindowsProcesses(f.data).length,1);
});
test('Windows rechecks PID creation and executable before graceful and forced taskkill',async()=>{
  const f=windowsFixture();f.g.scan();await f.g.stop(451,f.identity.start);
  assert.deepEqual(f.calls,[[451,false]]);f.timeout();assert.deepEqual(f.calls,[[451,false],[451,true]]);
  const log=fs.readFileSync(path.join(f.data,'proc-guard.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  assert.deepEqual(log.map(({action,pid,start})=>({action,pid,start})),[
    {action:'taskkill',pid:451,start:f.identity.start},
    {action:'taskkill /F',pid:451,start:f.identity.start},
  ]);
  const reused=windowsFixture();reused.g.scan();reused.table.get(451).start=winStart(9999999);
  await assert.rejects(reused.g.stop(451,reused.identity.start),/protected/);assert.deepEqual(reused.calls,[]);
  const changed=windowsFixture();changed.table.get(451).executable='C:\\user\\other.exe';
  assert.equal(changed.g.scan().flagged.length,0);
  await assert.rejects(changed.g.stop(451,changed.identity.start),/protected/);
});
test('Windows escalation leaves exited and reused PIDs alone and fails closed on unavailable evidence',async()=>{
  for(const replacement of [null,{start:winStart(9999999)}, {executable:'C:\\user.exe'}]) {
    const f=windowsFixture();await f.g.stop(451,f.identity.start);
    if(replacement)Object.assign(f.table.get(451),replacement);else f.table.delete(451);
    f.timeout();assert.deepEqual(f.calls,[[451,false]]);
  }
  const f=windowsFixture();f.table.get(451).start='bad';assert.deepEqual(f.g.scan().flagged,[]);
});
test('Windows taskkill requests graceful first, then /F, without a process-tree kill',()=>{
  const calls=[],run=(...args)=>{calls.push(args);return JSON.stringify({pid:451,start:'123',executable:'C:\\worker.exe'});};
  assert.equal(queryWindowsProcess(451,run).start,'123');
  assert.match(calls[0][1].at(-1),/Get-Process -Id 451/);
  const identity={pid:451,start:'123',executable:'C:\\worker.exe'};
  stopWindowsProcess(451,false,identity,run);stopWindowsProcess(451,true,identity,run);
  const graceful=calls[1][1].at(-1),forced=calls[2][1].at(-1);
  assert.match(graceful,/\$h=\$p.Handle/);assert.match(graceful,/StartTime.ToFileTimeUtc/);
  assert.match(graceful,/taskkill.exe \/PID 451;/);assert.ok(!graceful.includes('/F'));
  assert.match(forced,/taskkill.exe \/PID 451 \/F;/);assert.ok(!forced.includes('/T'));
  assert.match(forced,/finally.*Dispose/);
  assert.throws(()=>stopWindowsProcess(451,false,null,run),/identity/);
  assert.equal(queryWindowsProcess('451;bad',run),null);
});

test('Windows protects active registered jobs and escalates after a failed graceful request',async()=>{
  const f=windowsFixture();
  const protectedGuard=createProcGuard({platform:'win32',data:f.data,now:()=>10_000_000,dev:false,
    jobs:()=>[{pid:450,childPid:451,status:'running'}],config:()=>({}),windowsQuery:pid=>f.table.get(pid)});
  assert.deepEqual(protectedGuard.scan().flagged,[]);
  await assert.rejects(protectedGuard.stop(451,f.identity.start),/protected/);
  let delayed;const calls=[];
  const g=createProcGuard({platform:'win32',data:f.data,now:()=>10_000_000,dev:false,jobs:()=>[],config:()=>({}),
    windowsQuery:pid=>f.table.get(pid),windowsStop:(pid,force)=>{calls.push(force);if(!force)throw new Error('no window');},delay:fn=>{delayed=fn;}});
  await g.stop(451,f.identity.start);delayed();assert.deepEqual(calls,[false,true]);
});

test('Windows Allow is registration-lifetime-specific and dev mode cannot stop or allow',async()=>{
  const f=windowsFixture();
  await assert.rejects(f.g.stop(451,'wrong'),/changed|protected/);
  assert.throws(()=>f.g.allow(451,'wrong'),/changed/);
  f.g.allow(451,f.identity.start);assert.deepEqual(f.g.scan().flagged,[]);
  // A new launch with the same PID must not inherit the old Allow entry.
  const replacement={...f.identity,start:winStart(10_000_000-7100e3)};
  f.table.set(451,{...replacement,rss:30000});
  fs.writeFileSync(path.join(f.data,'launched-processes','451.json'),JSON.stringify(replacement));
  assert.deepEqual(f.g.scan().flagged.map(p=>p.start),[replacement.start]);
  const dev=createProcGuard({platform:'win32',data:f.data,dev:true,
    windowsQuery:()=>{throw new Error('dev must not query');},
    windowsStop:()=>{throw new Error('dev must not stop');}});
  assert.equal(dev.scan().disabled,'dev copy');
  await assert.rejects(dev.stop(451,replacement.start),/dev/);
  assert.throws(()=>dev.allow(451,replacement.start),/dev/);
  assert.deepEqual(f.calls,[]);
});
