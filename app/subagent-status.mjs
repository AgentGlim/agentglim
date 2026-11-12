// Transcript activity is independent of the parent CLI's panel. No transcript text reaches the UI.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.mjs';
export const IDLE_MS=20*60e3;
export function transcriptStatus(records,{mtime=Date.now(),now=Date.now()}={}) {
  const parsed=typeof records==='string' ? records.split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}}) : records;
  let activity=null,lastAt=mtime;
  for(const r of parsed) {
    const p=r.payload || r.properties || r,m=r.message || p.message || p.info || r.info || p;
    const type=p.type || r.type,stamp=typeof m.time?.completed==='number' ? m.time.completed : Date.parse(r.timestamp || r.time || m.timestamp || '');if(Number.isFinite(stamp))lastAt=stamp;
    if(['task_complete','task_completed','agent_end','turn.completed','session.idle','subagent_stop'].includes(type) || ['completed','finished'].includes(p.status))activity='final';
    if(type==='task_started' || type==='turn.started' || type==='agent_start')activity='active';
    const blocks=Array.isArray(m.content) ? m.content : [];
    const tool=type==='function_call' || type==='toolCall' || type==='tool_use' || blocks.some(b=>['tool_use','toolCall'].includes(b.type));
    if(tool) {
      const name=p.name || m.name || blocks.find(b=>['tool_use','toolCall'].includes(b.type))?.name || '';
      activity=/wait|sleep|TaskOutput|write_stdin|poll|background/i.test(name) || /run_in_background|yield_time_ms|\b(?:sleep|wait)\b/.test(JSON.stringify(p)) ? 'wait' : 'tool';
    } else if(m.role==='assistant' || r.type==='assistant' || type==='assistant') {
      activity=m.stop_reason==='end_turn' || m.channel==='final' || p.channel==='final' || m.finish_reason==='stop' || m.stopReason==='stop' || m.finish==='stop' ? 'final' : 'ended';
    } else if(['tool_result','function_call_output','toolResult','tool_execution_end'].includes(type) || m.role==='toolResult' || blocks.some(b=>b.type==='tool_result')) {
      if(activity!=='wait')activity='ended';
    }
  }
  const idle=now-Math.max(lastAt,mtime)>IDLE_MS;
  if(activity==='final' || idle && activity==='ended')return {activity:'finished',lastActivity:Math.max(lastAt,mtime)};
  if(idle && activity==='wait')return {activity:'idle',lastActivity:Math.max(lastAt,mtime)};
  return {activity:'running',lastActivity:Math.max(lastAt,mtime)};
}
function walk(root,depth=5,out=[],max=10000) {
  if(depth<0 || out.length>=max)return out;
  try{for(const e of fs.readdirSync(root,{withFileTypes:true})){if(out.length>=max)break;const p=path.join(root,e.name);if(e.isDirectory())walk(p,depth-1,out,max);else if(/\.(jsonl|json|log)$/.test(e.name))out.push(p);}}catch{}return out;
}
const tails=new Map();
function tail(file) {
  const st=fs.statSync(file),cached=tails.get(file);if(cached?.mtime===st.mtimeMs && cached?.size===st.size)return cached;
  const fd=fs.openSync(file,'r'),size=Math.min(st.size,1<<20),buf=Buffer.alloc(size);try{fs.readSync(fd,buf,0,size,st.size-size);}finally{fs.closeSync(fd);}
  const result={text:buf.toString('utf8'),mtime:st.mtimeMs,size:st.size};tails.set(file,result);return result;
}
let index={at:0,home:null,files:[]};
export function subagentStatus(jobs,{home=HOME,now=Date.now()}={}) {
  const agents=jobs.filter(j=>j.kind==='subagent' && j.status==='running' && !j.pid); // pid-backed jobs: jobs.mjs liveJobs() reads the process instead
  if(agents.length && (index.home!==home || now-index.at>60000))index={at:now,home,files:[...walk(path.join(home,'.claude','projects')), ...walk(path.join(home,'.codex','sessions')), ...walk(path.join(home,'.pi','agent','sessions')), ...walk(path.join(home,'.local','share','opencode','storage')), ...walk(path.join(home,'.local','share','opencode','log'))]};
  const list=jobs.map(j=>{
    if(!agents.includes(j))return j;
    const refs=[j.transcript,j.transcriptPath,j.outputFile,j.report,j.outdir].filter(x=>typeof x==='string');
    // Exact session/agent identity only: never associate a random recent transcript.
    const ids=(j.agentId ? [j.agentId] : [j.sessionId,j.session_id]).filter(x=>typeof x==='string' && /^[a-zA-Z0-9_-]{2,}$/.test(x));
    const matches=index.files.filter(f=>ids.some(id=>path.basename(f).replace(/\.(jsonl|json|log)$/,'')===id || path.basename(f)===`agent-${id}.jsonl` || path.basename(f).endsWith(`-${id}.jsonl`) || path.basename(f).endsWith(`_${id}.jsonl`) || f.split(path.sep).includes(id)));
    const files=[...refs,...matches].filter(f=>{try{return fs.statSync(f).isFile();}catch{return false;}});
    if(!files.length)return {...j,activity:'unknown',activityHint:'Transcript not located; activity unknown'};
    try {
      const chunks=files.map(f=>tail(f)).sort((a,b)=>a.mtime-b.mtime);
      const status=transcriptStatus(chunks.map(x=>x.text).join('\n'),{mtime:chunks.at(-1).mtime,now});
      return {...j,...status,activityHint:status.activity==='finished' ? 'Finished but still listed by the parent agent' : status.activity==='idle' ? 'Waiting on background work; no new records for 20 minutes' : null};
    } catch{return {...j,activity:'unknown'};}
  });
  return {jobs:list,counts:{running:list.filter(j=>j.kind==='subagent' && j.status==='running' && j.activity==='running').length,idle:list.filter(j=>j.kind==='subagent' && j.status==='running' && j.activity==='idle').length,finished:list.filter(j=>j.kind==='subagent' && j.status==='running' && j.activity==='finished').length,unknown:list.filter(j=>j.kind==='subagent' && j.status==='running' && j.activity==='unknown').length},hint:'Finished-but-listed agents are harmless; ask your agent to stop them (TaskStop) to tidy the panel.'};
}
