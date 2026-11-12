// Built-in subscription poller, ported from the optional driver. Credentials are read-only.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { HOME, DATA, RUN } from './paths.mjs';
import { key } from './env.mjs';
import { loadSetup, normalizeEntries } from './setup.mjs';
import { atomicJson, readJson } from './price-data.mjs';
export const INTERVALS = { claude:15*60e3, codex:120e3, go:120e3 };
const FILE = path.join(DATA,'usage-limits.json');
const MAX_BACKOFF = 30*60e3;
const exp = p => String(p || '').replace(/^~(?=\/|$)/,HOME);
export function retryWait(previous, retryAfter, now = Date.now()) {
  const seconds = Number(retryAfter), wait = Number.isFinite(seconds) ? seconds*1000 : Math.max(0,Date.parse(retryAfter)-now) || 0;
  return Math.min(MAX_BACKOFF,Math.max(wait, previous*2));
}
export function intervalFor(id, config = {}) {
  const value = +(config.pollMs?.[id] ?? config.intervals?.[id]);
  return Number.isFinite(value) && value >= 60000 ? Math.min(30*60e3,value) : INTERVALS[id];
}
const win = (label,pct,resetsAt) => ({label,pct:pct == null ? null : Math.round(pct),resetsAt:resetsAt || null});
export function codexWindows(rl) {
  return [rl?.primary_window,rl?.secondary_window].filter(Boolean).map((w,n) => win(w.limit_window_seconds ? w.limit_window_seconds <= 6*3600 ? '5h' : w.limit_window_seconds <= 8*86400 ? '7d' : '1mo' : n ? '7d' : '5h',w.used_percent,w.reset_at*1000));
}
export function parseClaudeUsage(text) {
  return [[/Current session:?\s*(\d+)% used/i,'5h'],[/Current week \(all models\):?\s*(\d+)% used/i,'7d']].flatMap(([re,label]) => {const m=re.exec(text);return m ? [win(label,+m[1])] : [];});
}
function cliUsage(run = execFile) {
  return new Promise(resolve => {
    const child = run('claude',['-p','/usage'],{ timeout:60000, maxBuffer:1<<20, windowsHide:true },(err,out) => resolve(parseClaudeUsage(err ? '' : out)));
    child.stdin?.end();
  });
}
async function getJson(url, headers, fetcher) {
  const r = await fetcher(url,{headers,signal:AbortSignal.timeout(15000)});
  if (!r.ok) { const e=new Error(`HTTP ${r.status}`);e.limited=r.status===429;e.retryAfter=r.headers.get('retry-after');throw e; }
  return r.json();
}
export async function readSubscription(id, entry, {fetcher=fetch, cli=cliUsage, defaultAccount=true}={}) {
  const ref=entry.credential, env=/^[A-Z][A-Z0-9_]*$/.test(ref || '');
  const auth=env ? null : readJson(exp(ref));
  if (id==='go') {
    const token=env && key(ref);if(!token) throw new Error('Key not set');
    const u=(await getJson('https://opencode.ai/zen/go/v1/usage',{authorization:`Bearer ${token}`},fetcher)).usage || {};
    return {windows:[['5h',u.rolling],['7d',u.weekly],['1mo',u.monthly]].map(([label,w])=>({...win(label,w?.percent,w?.resetsAt && Date.parse(w.resetsAt)),limited:w?.status && w.status!=='ok'})),source:'usage endpoint'};
  }
  if (id==='codex') {
    const t=auth?.tokens || {},token=env ? key(ref) : t.access_token;if(!token) throw new Error('Login needed');
    const headers={authorization:`Bearer ${token}`,...(t.account_id ? {'chatgpt-account-id':t.account_id} : {})};
    const d=await getJson('https://chatgpt.com/backend-api/wham/usage',headers,fetcher);
    let resetList=null;
    // Read only. Never request /consume or any reset action.
    if (d.rate_limit_reset_credits?.available_count) {
      try { const r=await getJson('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',headers,fetcher);resetList=(r.credits || []).filter(x=>x.status==='available').map(x=>({title:x.title,expiresAt:Date.parse(x.expires_at)})); } catch {}
    }
    return {windows:codexWindows(d.rate_limit),plan:d.plan_type,resetCredits:d.rate_limit_reset_credits?.available_count ?? null,resetList,source:'usage endpoint'};
  }
  try {
    const token=env ? key(ref) : auth?.claudeAiOauth?.accessToken;if(!token) throw new Error('Login needed');
    const d=await getJson('https://api.anthropic.com/api/oauth/usage',{authorization:`Bearer ${token}`,'anthropic-beta':'oauth-2025-04-20'},fetcher);
    const windows=[['5h',d.five_hour],['7d',d.seven_day]].filter(([,x])=>x).map(([l,x])=>win(l,x.utilization,Date.parse(x.resets_at)));
    if(!windows.length)throw new Error('No usage windows');return {windows,source:'usage endpoint'};
  } catch(e) {
    if(e.limited)throw e; // Respect rate limiting; do not bypass it with the CLI.
    if(defaultAccount) { const windows=await cli();if(windows.length)return {windows,source:'claude -p /usage'}; }
    throw e;
  }
}
export function createLimitsPoller({file=FILE, setup=loadSetup, driverAlive=()=>false, fetcher=fetch, cli=cliUsage, now=Date.now, dev=process.env.AGENTGLIM_DEV==='1', data=DATA, run=RUN}={}) {
  const state=new Map((readJson(file)?.limits || []).map(x=>[x.id,x]));let busy=false;
  function sources() { const cfg=setup();return ['claude','codex','go'].flatMap(id=>cfg.subs?.[id]?.on ? normalizeEntries(id,cfg.subs[id]).map((e,n)=>({id,entry:e,n})) : []); }
  function view() {
    const config={...(readJson(path.join(run,'config.json')) || {}),...(readJson(path.join(data,'budget.json')) || {})};
    return sources().map(({id,entry,n}) => {
      const readings=[state.get(entry.id),readJson(path.join(data,'flags',`${entry.id}-usage.json`)),readJson(path.join(run,'flags',`${entry.id}-usage.json`)),readJson(path.join(run,'budget.json'))?.limits?.find(l=>l.id===entry.id)].filter(Boolean);
      const current=readings.sort((a,b)=>(b.at || 0)-(a.at || 0))[0] || {};
      const interval=intervalFor(id,config);
      return {...current,id:entry.id,name:`${id==='go' ? 'OpenCode Go' : id==='codex' ? 'Codex' : 'Claude'}${n ? ` ${n+1}`:''}`,provider:{claude:'anthropic',codex:'codex',go:'opencode-go'}[id],tier:entry.tier,price:entry.price,windows:current.windows || [],intervalMs:interval,stale:!current.at || now()-current.at>2*interval};
    });
  }
  async function tick() {
    if(dev || busy || driverAlive())return;
    busy=true;
    try {
      const cfg={...(readJson(path.join(run,'config.json')) || {}),...(readJson(path.join(data,'budget.json')) || {})};
      await Promise.allSettled(sources().map(async ({id,entry,n}) => {
        const current=state.get(entry.id) || view().find(x=>x.id===entry.id) || {id:entry.id,windows:[],at:null};
        if(current.nextAt>now())return;
        const base=intervalFor(id,cfg);let wait=base;
        try {
          const reading=await readSubscription(id,entry,{fetcher,cli,defaultAccount:n===0 && (!entry.credential || exp(entry.credential)===path.join(HOME,'.claude/.credentials.json'))});
          Object.assign(current,reading,{at:now(),error:null});
          fs.mkdirSync(path.join(data,'flags'),{recursive:true});
          atomicJson(path.join(data,'flags',`${entry.id}-usage.json`),{at:current.at,windows:current.windows,source:current.source});
        } catch(e) { current.error=e.limited ? 'Rate limited; backing off' : /^(HTTP \d+|Login needed|Key not set|No usage windows)$/.test(e.message) ? e.message : 'Usage unavailable';if(e.limited)wait=retryWait(current.wait || base,e.retryAfter,now()); }
        current.nextAt=now()+wait;current.wait=wait;state.set(entry.id,current);
      }));
      atomicJson(file,{at:now(),limits:[...state.values()]});
    } finally {busy=false;}
  }
  return {view,tick,start(){if(dev)return;tick().catch(()=>{});return setInterval(()=>tick().catch(()=>{}),30000).unref();}};
}
