import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {keyNames,keyEntries} from '../env.mjs';
import {normalizeEntries,clean,setupView} from '../setup.mjs';
import {loadPrices,validPrices,parsePricing,checkPrices,atomicJson,subscriptionTotals} from '../price-data.mjs';
import {checkDeps,findBinary} from '../deps.mjs';
import {parseResets,resetView,checkClaudeResets,seedManualResets} from '../claude-resets.mjs';
import {codexWindows,createLimitsPoller,readSubscription,retryWait,intervalFor} from '../limits.mjs';
import {transcriptStatus,subagentStatus,IDLE_MS} from '../subagent-status.mjs';
import {liveStatus} from '../live-status.mjs';
import {scanSkills} from '../skills.mjs';
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'ag-portable-'));
const fixture=name=>fs.readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8');

test('numbered credential families allow sparse 2, 10 and aliases; reject unrelated names',()=>{
  const names=keyNames('TEST_API_KEY',['TEST_API_KEY_DATA'],{TEST_API_KEY_2:'x',TEST_API_KEY_10:'y',TEST_API_KEY_20:'z',TEST_API_KEY_01:'bad',TEST_API_KEY_X:'bad'});
  assert.deepEqual(names,['TEST_API_KEY','TEST_API_KEY_2','TEST_API_KEY_10','TEST_API_KEY_20','TEST_API_KEY_DATA']);
  process.env.AG_TEST_KEY='fixture-base';process.env.AG_TEST_KEY_2='fixture-second';assert.equal(keyEntries('AG_TEST_KEY').length,2);delete process.env.AG_TEST_KEY;delete process.env.AG_TEST_KEY_2;
});
test('subscription lists retain distinct tiers, prices and references; totals sum enabled entries',()=>{
  const cfg=clean({subs:{claude:{on:true,entries:[{tier:'max5',credential:'CLAUDE_CODE_OAUTH_TOKEN'},{tier:'max20',credential:'CLAUDE_CODE_OAUTH_TOKEN_2'}]},codex:{on:true,entries:[{tier:'pro100',credential:'CODEX_ACCESS_TOKEN'},{tier:'pro500',credential:'CODEX_ACCESS_TOKEN_2'}]},go:{on:false,keys:8}}});
  assert.equal(cfg.subs.go.entries.length,8);assert.deepEqual(subscriptionTotals(cfg),{claude:300,codex:600,go:0});assert.deepEqual(setupView(cfg).limitIds,['claude','claude2','codex','codex2']);
});
test('legacy subscription migration retains plan amount and Go ids; raw credentials rejected',()=>{
  assert.equal(normalizeEntries('codex',{plan:'Pro $200'})[0].price,200);
  assert.deepEqual(normalizeEntries('go',{keys:3}).map(x=>x.id),['go','go2','go3']);
  assert.equal(normalizeEntries('claude',{entries:[{credential:'a secret pasted by mistake'}]})[0].credential,'');
});
test('price loader validates private data and falls back on missing/malformed files',()=>{
  const file=path.join(tmp(),'prices.json');assert.ok(validPrices(loadPrices(file)));fs.writeFileSync(file,'{}');assert.ok(validPrices(loadPrices(file)));
  const data=structuredClone(loadPrices(file));data.providers.go.tiers[0].usd=12;atomicJson(file,data);assert.equal(loadPrices(file).providers.go.tiers[0].usd,12);assert.ok(!validPrices({...data,currency:'bad'}));
});
test('pricing parser prefers monthly recurring amounts to annual and promo prices, discovers tiers',()=>{
  const data=loadPrices(path.join(os.tmpdir(), 'nonexistent-price-fixture'));
  const claude=parsePricing('claude','<h3>Pro</h3><p>$17 per month annually. $20 if billed monthly.</p>',data.providers.claude);assert.equal(claude.tiers.find(t=>t.id==='pro').usd,20);
  const el=parsePricing('elevenlabs','<h3>Creator</h3><p>$11 first month. Then $22 per month</p>',data.providers.elevenlabs);assert.equal(el.tiers.find(t=>t.id==='creator').usd,22);
  const go=parsePricing('go','<h2>Go</h2><p>$12 per month</p><h2>Go Extra</h2><p>$80 per month</p>',data.providers.go);assert.equal(go.tiers.find(t=>t.label==='Go Extra').usd,80);assert.equal(go.tiers.find(t=>t.id==='go').usd,12);
  const descriptive=parsePricing('claude','<h3>Pro</h3><p>$20 per month</p><h3>Enterprise deployment for the Claude desktop app</h3><p>$500 per month</p>',data.providers.claude);assert.ok(!descriptive.tiers.some(t=>t.label.includes('deployment')));
  const comparison=parsePricing('claude','<h3>Pro</h3><p>$20 per month</p><h3>Single sign-on (SSO)</h3><p>No</p><p>No</p><p>No</p><p>No</p><p>$500 per month</p>',data.providers.claude);assert.ok(!comparison.tiers.some(t=>t.label.includes('sign-on')));
});
test('daily pricing check performs HTTP only, records changes/errors, skips dev and honors daily TTL',async()=>{
  const file=path.join(tmp(),'prices.json');let calls=0;const now=new Date('2026-11-12T00:00:00Z');
  const fetcher=async url=>{calls++;return new Response(url.includes('typesafe') ? 'Jev costs $0.042 per million input tokens. Output tokens are free.' : '<h3>Pro</h3><p>$21 per month</p><h2>Go</h2><p>$12 per month</p>',{status:200});};
  await checkPrices({file,fetcher,now,dev:true});assert.equal(calls,0);
  const result=await checkPrices({file,fetcher,now,dev:false});assert.ok(calls>=5);assert.ok(result.changes.length);const previous=calls;await checkPrices({file,fetcher,now,dev:false});assert.equal(calls,previous);
  const blocked=await checkPrices({file,fetcher:async()=>new Response('',{status:403}),force:true,now,dev:false});assert.ok(blocked.errors.length);assert.deepEqual(blocked.providers.go.tiers,result.providers.go.tiers);
});
test('dependency check reports absent features and detects binaries/bundled paths without running tools',()=>{
  const catalog={dependencies:[{id:'a',bins:['fixture-bin'],paths:[],missing:'No fixture feature'},{id:'b',bins:[],paths:['{root}/bundled']},{id:'c',bins:[],paths:[]}]};
  const list=checkDeps({catalog,binary:b=>b==='fixture-bin',exists:p=>path.normalize(p)===path.join(os.tmpdir(),'fixture','bundled'),root:path.join(os.tmpdir(),'fixture')});assert.equal(list[0].detected,true);assert.equal(list[1].bundled,true);assert.equal(list[2].detected,false);
});
test('dependency lookup handles Windows paths, PATHEXT and command wrappers on Linux',()=>{
  const root=String.raw`C:\fixture`;
  const catalog={dependencies:[{id:'bundled',paths:['{root}/bundled'],bins:[]}]};
  const [item]=checkDeps({catalog,root,binary:()=>null,exists:p=>path.win32.normalize(p)===path.win32.join(root,'bundled')});
  assert.equal(item.bundled,true);
  assert.equal(item.detected,true);
  for(const suffix of ['.EXE','.CMD','.BAT','.COM']) {
    const expected=path.win32.join(root,'bin','fixture'+suffix);
    assert.equal(findBinary('fixture',{platform:'win32',home:root,env:{Path:`C:\\absent;"${root}\\bin"`,PATHEXT:suffix},exists:p=>p===expected}),expected);
  }
  assert.equal(findBinary('missing',{platform:'win32',home:root,env:{PATH:root},exists:()=>false}),null);
});
test('Claude reset parser reads kinds, expiries and explanatory text without controls',()=>{
  const r=parseResets(fixture('claude-resets.html'),{now:new Date('2026-11-11T12:00:00Z')});assert.equal(r.available,2);assert.equal(r.resets[0].expires,'2026-12-10T22:00:00.000Z');assert.equal(r.resets[1].kind,'fable');assert.match(r.resets[1].note,/weekly limit/);assert.ok(!JSON.stringify(r).includes('Reset for free'));assert.equal(parseResets('Sign in'),null);assert.equal(parseResets('Limit resets\n0 available').available,0);
});
test('reset view warns under seven days and dev check never launches a browser',async()=>{
  const file=path.join(tmp(),'resets.json');atomicJson(file,{status:'ok',checkedAt:'2026-11-11',available:1,resets:[{kind:'full',expires:'2026-11-16T00:00:00Z'}]});assert.equal(resetView(file,Date.parse('2026-11-11')).resets[0].soon,true);assert.equal(resetView(file).manual,false);assert.deepEqual(await checkClaudeResets({dev:true,file,playwright:{}}),{skipped:'dev copy'});
  const loggedOut=await checkClaudeResets({dev:false,file,profile:path.join(tmp(),'missing-profile'),playwright:{}});assert.equal(loggedOut.status,'login needed');assert.equal(loggedOut.available,1);
});
test('Codex window labels use actual duration; Claude defaults to 15 minutes',()=>{
  assert.equal(codexWindows({primary_window:{limit_window_seconds:604800,used_percent:25}})[0].label,'7d');assert.equal(intervalFor('claude'),900000);assert.equal(intervalFor('go',{pollMs:{go:180000}}),180000);
});
test('429 backoff doubles or honors numeric/date Retry-After, capped at 30 min',()=>{
  assert.equal(retryWait(120000,null),240000);assert.equal(retryWait(120000,'600'),600000);assert.equal(retryWait(900000,'3600'),1800000);assert.equal(retryWait(60000,'2026-01-01T00:10:00Z',Date.parse('2026-01-01T00:00:00Z')),600000);
});
test('poller only polls enabled accounts, persists last good reads, marks stale at twice interval',async()=>{
  const data=tmp(),file=path.join(data,'usage.json');let now=1000000,calls=0;
  process.env.AG_GO_FIXTURE='fixture-go-value';
  const setup=()=>({subs:{go:{on:true,entries:[{tier:'go',credential:'AG_GO_FIXTURE'}]},claude:{on:false},codex:{on:false}}});
  const poller=createLimitsPoller({file,data,run:data,setup,now:()=>now,dev:false,fetcher:async()=>{calls++;return Response.json({usage:{rolling:{percent:25}}});}});
  await poller.tick();assert.equal(calls,1);assert.equal(poller.view()[0].windows[0].pct,25);assert.equal(poller.view()[0].stale,false);now+=240001;assert.equal(poller.view()[0].stale,true);delete process.env.AG_GO_FIXTURE;
  const saved=fs.readFileSync(file,'utf8');assert.ok(!saved.includes('fixture-go-value'));
});
test('429 preserves cache and never invokes Claude CLI fallback',async()=>{
  process.env.AG_CLAUDE_FIXTURE='fixture-claude-oauth';let cli=0;
  await assert.rejects(readSubscription('claude',{credential:'AG_CLAUDE_FIXTURE'},{fetcher:async()=>new Response('',{status:429,headers:{'Retry-After':'900'}}),cli:async()=>{cli++;return [];}}),/429/);assert.equal(cli,0);delete process.env.AG_CLAUDE_FIXTURE;
});
test('driver liveness and dev mode suppress every subscription network request',async()=>{
  const data=tmp();let called=0;for(const opts of [{dev:true},{dev:false,driverAlive:()=>true}]){const p=createLimitsPoller({file:path.join(data,'usage.json'),data,setup:()=>({subs:{go:{on:true,keys:1}}}),fetcher:async()=>{called++;},...opts});await p.tick();}assert.equal(called,0);
});
test('transcripts distinguish final handback, stale background wait and recent activity across harnesses',()=>{
  const mtime=Date.parse('2026-01-01T12:00:00Z'),now=mtime+IDLE_MS+1;
  assert.equal(transcriptStatus(fixture('subagent-final.jsonl'),{mtime,now}).activity,'finished');assert.equal(transcriptStatus(fixture('subagent-wait.jsonl'),{mtime,now}).activity,'idle');assert.equal(transcriptStatus(fixture('subagent-wait.jsonl'),{mtime,now:mtime+1000}).activity,'running');
  for(const type of ['task_complete','agent_end','turn.completed'])assert.equal(transcriptStatus([{type}],{mtime,now}).activity,'finished');
  assert.equal(transcriptStatus([{type:'response_item',payload:{role:'assistant',channel:'final'}}],{mtime,now}).activity,'finished');
});
test('finished and idle subagents do not back running progress; unknown transcripts stay explicit',()=>{
  for(const activity of ['idle','finished','unknown'])assert.equal(liveStatus([{title:'Build',status:'running'}],'demo',[{project:'demo',status:'running',activity}])[0].status,'in progress');
  const result=subagentStatus([{kind:'subagent',status:'running',id:'fixture'}],{home:tmp()});assert.equal(result.counts.unknown,1);assert.equal(result.counts.running,0);
});
for (const eol of ['\n', '\r\n']) test(`skill inventory (${JSON.stringify(eol)}) stays machine-local, follows links, deduplicates and tags bundled skills`, (t)=>{
  const home=tmp(),root=tmp();
  t.after(()=>{fs.rmSync(home,{recursive:true,force:true});fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(path.join(root,'skills','example'),{recursive:true});
  fs.mkdirSync(path.join(home,'.claude','skills'),{recursive:true});
  fs.writeFileSync(path.join(root,'skills','example','SKILL.md'),['---','name: example','description: Generic fixture','---',''].join(eol));
  fs.symlinkSync(path.join(root,'skills','example'),path.join(home,'.claude','skills','example'),process.platform==='win32'?'junction':'dir');
  const list=scanSkills({home,root});
  assert.equal(list.length,1);assert.equal(list[0].bundled,true);assert.ok(list[0].harness.includes('Claude'));
  assert.equal(list[0].name,'example');assert.equal(list[0].description,'Generic fixture');
});

test('saved Codex, Pi and OpenCode transcript fixtures recognize final handbacks',()=>{
  const mtime=Date.parse('2026-01-01T12:00:01Z');
  for(const name of ['subagent-codex.jsonl','subagent-pi.jsonl','subagent-opencode.jsonl'])assert.equal(transcriptStatus(fixture(name),{mtime,now:mtime+1000}).activity,'finished',name);
});

test('subagent transcript discovery matches Codex rollout suffix and prefers Claude child identity',()=>{
  const home=tmp(),dir=path.join(home,'.codex/sessions/2026/01/01');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'rollout-2026-01-01-child-session.jsonl'),fixture('subagent-codex.jsonl'));
  const cdir=path.join(home,'.claude/projects/demo/parent-session/subagents');fs.mkdirSync(cdir,{recursive:true});fs.writeFileSync(path.join(cdir,'agent-child-agent.jsonl'),fixture('subagent-final.jsonl'));fs.writeFileSync(path.join(home,'.claude/projects/demo/parent-session.jsonl'),fixture('subagent-wait.jsonl'));
  const result=subagentStatus([{kind:'subagent',status:'running',sessionId:'child-session'},{kind:'subagent',status:'running',harness:'claude',sessionId:'parent-session',agentId:'child-agent'}],{home});assert.equal(result.counts.finished,2);assert.equal(result.counts.running,0);
});

test('manual reset evidence is seeded privately and never overwrites an existing reading implicitly',()=>{
  const file=path.join(tmp(),'claude-resets.json'),data={checkedAt:'2026-01-01',available:1,resets:[{kind:'full',expires:'2026-02-01T00:00:00Z'}],source:'manual fixture'};
  const seeded=seedManualResets(data,{file});assert.equal(seeded.source,'manual fixture');assert.equal(seeded.status,'manual evidence');assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).available,1);assert.throws(()=>seedManualResets(data,{file}),/preserved/);
});
test('a configured install from before the setupComplete flag counts as set up; a SuperAgent heartbeat keeps the popup quiet',async()=>{
  const {legacyComplete}=await import('../setup.mjs');
  assert.equal(legacyComplete({version:1,harnesses:{claude:true},plans:{path:'~/plans'}}),true);
  assert.equal(legacyComplete({version:1,harnesses:{},plans:{path:''}}),false);
  assert.equal(legacyComplete({harnesses:{codex:true}}),false); // no version: a partial file, Setup still needed
  assert.equal(legacyComplete({version:2,setupComplete:false,harnesses:{claude:true}}),false);
  const {watcherActive}=await import('../portable.mjs');
  const data=tmp(),run=tmp();
  assert.equal(watcherActive(Date.now(),{data,run}),false);
  fs.mkdirSync(path.join(run,'heartbeats'));fs.writeFileSync(path.join(run,'heartbeats','superagent-check'),'');
  assert.equal(watcherActive(Date.now(),{data,run}),true);
  assert.equal(watcherActive(Date.now()+46*60e3,{data,run}),false);
  fs.mkdirSync(path.join(run,'flags'));fs.writeFileSync(path.join(run,'flags','watcher-bridge-health.json'),JSON.stringify({at:Date.now()/1000+46*60,error:null}));
  assert.equal(watcherActive(Date.now()+46*60e3,{data,run}),true); // the Codex bridge writes seconds
});
