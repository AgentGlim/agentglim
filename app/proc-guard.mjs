// Linux process guard. No pattern kills; all actions revalidate pid + start ticks.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA, RUN, HOME } from './paths.mjs';
import { atomicJson, readJson } from './price-data.mjs';
import { readTracked } from './jobs.mjs';
import { loadSetup } from './setup.mjs';
const AGENT = /^(?:claude|codex|pi|opencode)(?:\.exe)?$/;
// dev servers the owner started (npm/pnpm/yarn/bun run dev|start|serve|preview, vite, next) and the harness's own
// long-lived loops (anything run from the plans _run/ folder: driver, hang-reaper.sh, mem-watch.sh, auditq-wait.sh, watch.sh,
// watcher bridges) are known processes, never "over 60 min without a tracked job"
const DEV_SERVER = /(?:^|\s)(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:dev|start|serve|preview)\b|(?:^|[\s/])(?:vite|next|nodemon|astro|nuxt)(?:\s|$)/;
export function harnessPaths(run=RUN) { const out=new Set([run]);try{out.add(fs.realpathSync(run));}catch{}out.add(String(run).replace(`${HOME}/projects/dev/`,`${HOME}/dev/projects/`));out.add(String(run).replace(`${HOME}/dev/projects/`,`${HOME}/projects/dev/`));return [...out].filter(Boolean).map(x=>x.replace(/\/+$/,'')); }
export function knownProcess(p,harness=harnessPaths()) {
  const cmd=(p.argv || []).join(' ');
  if(DEV_SERVER.test(cmd))return 'dev server';
  if(harness.some(h=>cmd.includes(h+'/') || p.cwd===h || String(p.cwd || '').startsWith(h+'/')) || /(?:^|[\s/])_run\/(?:bin\/|driver\.mjs)/.test(cmd))return 'harness process';
  return null;
}
const SERVER = /(?:^|[ /])(?:[\w.-]*server(?:\.[\w]+)?|driver\.mjs|systemd|sshd|Xorg|Xwayland|postgres|redis-server|nginx|tailscaled)(?:\s|$)|(?:--serve|http\.server|uvicorn|gunicorn|vite|webpack|next (?:dev|start))/i;
export function safeCommand(argv, secrets=[]) {
  const out=[];let hide=false;
  for(let i=0;i<argv.length;i++) {
    let word=argv[i];
    if(hide){out.push('[redacted]');hide=false;continue;}
    if(/^(?:-c|-e|--eval|--command)$/.test(word)){out.push(word,'[inline code]');i++;continue;}
    if(/(?:token|password|secret|api[-_]?key|authorization|credential)/i.test(word)){out.push(word.includes('=') ? word.split('=')[0]+'=[redacted]' : word);hide=!word.includes('=');continue;}
    const pathy=/^(?:~|\.{0,2})\/[\w.\/@+-]*$/.test(word) || /^[\w.@+-]+\/[\w.\/@+-]+\.\w{1,5}$/.test(word); // a file path stays readable
    if(pathy && HOME)word=word.split(HOME+'/').join('~/');
    word=(pathy ? word : word.replace(/\b[A-Za-z0-9_+\/-]{40,}={0,2}\b/g,'[opaque argument]')).replace(/(?:sk-|gh[pousr]_|eyJ)[A-Za-z0-9_.-]{10,}/g,'[redacted]').replace(/https?:\/\/\S+/g,'[url]');
    for(const secret of secrets)if(secret && secret.length>5)word=word.split(secret).join('[redacted]');
    out.push(word);
  }
  return out.join(' ').slice(0,180);
}
export function readProcess(pid,{root='/proc',now=Date.now(),uid=process.getuid?.(),ticks=100}={}) {
  try {
    const dir=path.join(root,String(pid)),status=fs.readFileSync(path.join(dir,'status'),'utf8');
    if(uid!=null && +status.match(/^Uid:\s+(\d+)/m)?.[1]!==uid)return null;
    const stat=fs.readFileSync(path.join(dir,'stat'),'utf8'),end=stat.lastIndexOf(')'),a=stat.slice(end+2).trim().split(/\s+/);
    const argv=fs.readFileSync(path.join(dir,'cmdline'),'utf8').split('\0').filter(Boolean);
    const env=fs.readFileSync(path.join(dir,'environ'),'utf8').split('\0').map(x=>x.split('=')[0]);
    const uptime=+fs.readFileSync(path.join(root,'uptime'),'utf8').split(' ')[0];
    let tty=+a[4]!==0, socket=false;
    const listeners=new Set();
    for(const net of ['tcp','tcp6','udp','udp6'])try{for(const line of fs.readFileSync(path.join(root,'net',net),'utf8').trim().split('\n').slice(1)){const x=line.trim().split(/\s+/);if(x[3]==='0A' || net.startsWith('udp') && x[2]?.endsWith(':0000'))listeners.add(x[9]);}}catch{}
    try {for(const fd of fs.readdirSync(path.join(dir,'fd'))){let link;try{link=fs.readlinkSync(path.join(dir,'fd',fd));}catch{continue;}if(/^\/dev\/(?:pts\/|tty)/.test(link))tty=true;const ino=/^socket:\[(\d+)\]$/.exec(link)?.[1];if(ino && listeners.has(ino))socket=true;}}catch{}
    let cwd=null;try{cwd=fs.readlinkSync(path.join(dir,'cwd'));}catch{}
    return {pid:+pid,ppid:+a[1],cwd,start:a[19],ageMs:Math.max(0,(uptime-(+a[19]/ticks))*1000),rss:(+status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0)*1024,tty,socket,argv,comm:stat.slice(stat.indexOf('(')+1,end),agentEnv:env.some(x=>/^(?:CLAUDE_CODE_|CODEX_|PI(?:_|$)|OPENCODE(?:_|$))/.test(x)),at:now};
  } catch{return null;}
}
export function evaluateProcesses(processes,{jobs=[],samples={},allowed={},now=Date.now(),self=process.pid,secrets=[],harness=harnessPaths()}={}) {
  const map=new Map(processes.map(p=>[p.pid,p])),tracked=new Set(jobs.flatMap(j=>[+j.pid,+j.childPid]).filter(Boolean));
  const ancestry=p=>{const chain=[],seen=new Set();while(p && !seen.has(p.pid)){chain.push(p);seen.add(p.pid);p=map.get(p.ppid);}return chain;};
  const own=new Set(ancestry(map.get(self)).map(p=>p.pid));
  // a process with a listening descendant (npm run dev -> vite) is a server too
  const kids=new Map();for(const p of processes){if(!kids.has(p.ppid))kids.set(p.ppid,[]);kids.get(p.ppid).push(p);}
  const serves=(p,d=0)=>d<6 && (kids.get(p.pid) || []).some(c=>c.socket || SERVER.test(c.argv.join(' ')) || serves(c,d+1));
  return processes.flatMap(p=>{
    const chain=ancestry(p),agent=chain.find((a,n)=>n>0 && (AGENT.test(a.comm) || AGENT.test(path.basename(a.argv[0] || '')) || a.argv.slice(0,3).some(x=>AGENT.test(path.basename(x)))));
    if(!(p.agentEnv || agent) || p.tty || own.has(p.pid) || AGENT.test(p.comm) || p.argv.slice(0,3).some(x=>AGENT.test(path.basename(x))) || chain.some(a=>tracked.has(a.pid) || a.socket || SERVER.test(a.argv.join(' ')) || knownProcess(a,harness)) || serves(p) || allowed[p.pid]===p.start)return [];
    const prev=samples[p.pid],growth=prev?.start===p.start ? p.rss-prev.minRss : 0;
    if(p.ageMs<=60*60e3 && growth<=500*1024**2)return [];
    return [{pid:p.pid,start:p.start,command:safeCommand(p.argv,secrets),startedBy:agent ? `${agent.comm} (pid ${agent.pid})` : 'AI agent tool environment',ageMs:p.ageMs,rss:p.rss,growth,reason:growth>500*1024**2 ? 'Grew over 500 MB' : 'Over 60 min without a tracked job',at:now}];
  });
}
export function createProcGuard({root='/proc',data=DATA,now=Date.now,signal=(pid,sig)=>process.kill(pid,sig),jobs=()=>readTracked(path.join(data,'tracked-jobs')),config=loadSetup,dev=process.env.AGENTGLIM_DEV==='1',ticks,uid=process.getuid?.(),delay=fn=>setTimeout(fn,10000).unref()}={}) {
  const file=path.join(data,'proc-guard.json');let state=readJson(file) || {samples:{},allowed:{},flagged:[]};
  if(!ticks)try{ticks=+execFileSync('getconf',['CLK_TCK'],{encoding:'utf8',timeout:1000});}catch{ticks=100;}
  const read=pid=>readProcess(pid,{root,now:now(),ticks,uid});
  const secretValues=()=>Object.entries(process.env).filter(([k])=>/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(k)).map(([,v])=>v);
  function scan() {
    if(dev)return {...state,disabled:'dev copy'};
    if(!fs.existsSync(root))return {flagged:[],unsupported:true};
    const processes=fs.readdirSync(root).filter(n=>/^\d+$/.test(n)).map(read).filter(Boolean);
    state.flagged=evaluateProcesses(processes,{jobs:jobs(),samples:state.samples,allowed:state.allowed,now:now(),secrets:secretValues()});
    const next={};for(const p of processes){const old=state.samples[p.pid];next[p.pid]={start:p.start,minRss:old?.start===p.start ? Math.min(old.minRss,p.rss):p.rss};}
    state.samples=next;state.at=now();atomicJson(file,state);
    const hours=config().guard?.autoStopHours || 0;
    if(hours>0)for(const item of state.flagged)if(item.ageMs>hours*3600e3)stop(item.pid,item.start,'auto').catch(()=>{});
    return view();
  }
  const log=record=>{fs.mkdirSync(data,{recursive:true});fs.appendFileSync(path.join(data,'proc-guard.ndjson'),JSON.stringify({at:now(),...record})+'\n',{mode:0o600});};
  function eligible(pid,start) {
    const p=read(pid);if(!p || p.start!==start)return null;
    let all=[];try{all=fs.readdirSync(root).filter(n=>/^\d+$/.test(n)).map(read).filter(Boolean);}catch{}
    return evaluateProcesses(all,{jobs:jobs(),samples:state.samples,allowed:state.allowed,now:now(),secrets:secretValues()}).find(x=>x.pid===pid && x.start===start);
  }
  async function stop(pid,start,source='manual') {
    if(dev)throw new Error('Disabled in dev copy');pid=+pid;
    if(!Number.isInteger(pid) || pid<=1 || !eligible(pid,start))throw new Error('Process changed or is protected; refresh the dashboard');
    log({action:'SIGTERM',pid,start,source});signal(pid,'SIGTERM');
    delay(()=>{if(eligible(pid,start)){try{log({action:'SIGKILL',pid,start,source});signal(pid,'SIGKILL');}catch{}}});
    return {ok:true};
  }
  function allow(pid,start) {
    if(dev)throw new Error('Disabled in dev copy');const p=read(+pid);if(!p || p.start!==start)throw new Error('Process changed');
    state.allowed[pid]=start;state.flagged=state.flagged.filter(x=>x.pid!==+pid);atomicJson(file,state);return {ok:true};
  }
  function view(){return {at:state.at,flagged:state.flagged || [],unsupported:process.platform!=='linux',disabled:dev ? 'dev copy' : null,autoStopHours:config().guard?.autoStopHours || 0};}
  return {scan,stop,allow,view,start(){if(dev || process.platform!=='linux')return;scan();return setInterval(()=>{try{scan();}catch{}},5*60e3).unref();}};
}
