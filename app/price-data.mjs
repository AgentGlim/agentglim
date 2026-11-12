// Subscription catalog. Runtime checks update private data; packaged defaults remain portable.
import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './paths.mjs';
export const DEFAULT_PRICES = new URL('./prices.json', import.meta.url);
export const PRICE_FILE = path.join(DATA, 'prices.json');
export const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
}
export function validPrices(d) {
  return d?.currency === 'USD' && ['claude', 'codex', 'go', 'jev', 'elevenlabs'].every(id => {
    const p = d.providers?.[id]; return /^https:\/\//.test(p?.url || '') && Array.isArray(p.tiers) && p.tiers.every(t => typeof t.id === 'string' && typeof t.label === 'string' && (t.usd === null || Number.isFinite(t.usd) && t.usd >= 0));
  });
}
export function loadPrices(file = PRICE_FILE) {
  const runtime = readJson(file);
  return validPrices(runtime) ? runtime : readJson(DEFAULT_PRICES);
}
export function planPrice(provider, id, data = loadPrices()) { return data.providers[provider]?.tiers.find(t => t.id === id)?.usd ?? null; }
export function subscriptionTotals(cfg, data = loadPrices()) {
  return Object.fromEntries(['claude', 'codex', 'go'].map(id => [id, cfg.subs?.[id]?.on ? (cfg.subs[id].entries || []).reduce((sum, entry) => sum + (Number.isFinite(entry.price) ? entry.price : planPrice(id, entry.tier, data) || 0), 0) : 0]));
}
export function pageText(html) {
  return String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, '\n').replace(/&(?:nbsp|amp|quot|#39|lt|gt);/g, x => ({'&nbsp;':' ', '&amp;':'&', '&quot;':'"', '&#39;':"'", '&lt;':'<','&gt;':'>'}[x])).split(/\n/).map(x => x.trim()).filter(Boolean).join('\n');
}
// Parse only priced cards, never unrelated dollar figures from a comparison table or promotion.
export function parsePricing(id, html, previous) {
  const text = pageText(html), tiers = [];
  const titles = id === 'claude' ? ['Free','Pro','Max','Max 5x','Max 20x','Ultra','Team','Standard seat','Premium seat','Enterprise'] : id === 'go' ? ['Go','Go Plus'] : id === 'elevenlabs' ? ['Free','Starter','Creator','Pro','Scale','Business','Enterprise'] : ['Free','Go','Plus','Pro','Pro 100','Pro 200','Pro 500','Business','Edu','Enterprise'];
  const knownTitles=new Set(titles);
  for (const m of String(html).matchAll(/<h[234][^>]*>([\s\S]*?)<\/h[234]>/gi)) {const name=pageText(m[1]);if(name && name.length<=32 && name.split(/\s+/).length<=3 && !/features|models|limits|usage|billing|pricing|credits|questions|deployment|compare|included|costs|^how\b|^what\b|\?/i.test(name) && !titles.includes(name))titles.push(name);}
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const title = lines[i]; if (!titles.includes(title)) continue;
    if(!knownTitles.has(title) && !lines.slice(i+1,i+4).some(line=>/^\$[\d,.]+(?:\s*(?:per month|\/\s*mo(?:nth)?)|$)/i.test(line)))continue;
    let tail = lines.slice(i + 1, i + 20).join(' ');
    const next = lines.slice(i + 1, i + 20).findIndex(x => titles.includes(x));
    if (next >= 0) tail = lines.slice(i + 1, i + 1 + next).join(' ');
    let m = /Then\s*\$([\d,.]+)\s*per month/i.exec(tail) || /\$([\d,.]+)\s*if billed monthly/i.exec(tail) || /\$([\d,.]+)\s*(?:per month|\/\s*(?:mo|month)|monthly)/i.exec(tail);
    if (!m && title === 'Free' && /\$0|free for everyone/i.test(tail)) m = ['$0','0'];
    // Claude's Free card has the amount followed by its description.
    if (!m && title === 'Free' && /^.{0,30}\$0\b/.test(tail)) m = ['$0','0'];
    if (!m && id==='codex') m=/^\$([\d,.]+)(?:\s|$)/.exec(tail);
    if (!m) continue;
    const label = id === 'claude' && title === 'Max' ? 'Max 5x' : id==='claude' && title==='Standard seat' ? 'Team' : id==='claude' && title==='Premium seat' ? 'Team Premium (per seat)' : id==='codex' && title==='Pro' ? `Pro ${Number(m[1].replace(/,/g,''))}` : title;
    const old = previous.tiers.find(t => t.label === label || t.label === title);
    const tier = { id: old?.id || title.toLowerCase().replace(/[^a-z0-9]+/g, '-'), label, usd: Number(m[1].replace(/,/g,'')) };
    if (!tiers.some(t => t.id === tier.id)) tiers.push(tier);
  }
  if (id === 'jev') {
    const m = /\$([\d.]+)\s*per million input tokens/i.exec(text);
    if (!m) throw new Error('Pricing format changed; retained last verified rates');
    return { ...previous, inputPerMillion: +m[1], outputPerMillion: /output tokens are free/i.test(text) ? 0 : previous.outputPerMillion };
  }
  // Pro amounts may be present only in rendered client data / official support copy.
  if (id === 'codex') for (const amount of [100,200,500]) {
    if (new RegExp(`Pro[ \\n]*${amount}\\b`).test(text)) {
      const old = previous.tiers.find(t => t.id === `pro${amount}`); if (old && !tiers.some(t => t.id === old.id)) tiers.push({ ...old });
    }
  }
  if (!tiers.length) throw new Error('Pricing not readable over HTTP; retained last verified tiers');
  return { ...previous, tiers: [...previous.tiers.filter(t => !tiers.some(n => n.id === t.id)), ...tiers] };
}
let busy;
export function checkPrices({ file = PRICE_FILE, fetcher = fetch, now = new Date(), force = false, dev = process.env.AGENTGLIM_DEV === '1' } = {}) {
  if (dev) return Promise.resolve({ skipped: 'dev copy' });
  if (busy) return busy;
  busy = (async () => {
    const data = structuredClone(loadPrices(file)), stamp = now.toISOString();
    if (!force && Date.parse(data.lastAttempt || '') > now.getTime() - 864e5) return data;
    const changes = [], errors = [];
    for (const [id, p] of Object.entries(data.providers)) {
      try {
        const sources = [p.url, ...(p.sources || [])], pages = [];
        for (const url of sources) {
          try { const r = await fetcher(url, { signal: AbortSignal.timeout(25000), headers: { 'user-agent':'AgentGlim pricing check' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); pages.push(await r.text()); }
          catch { errors.push(`${id}: source unavailable (${url})`); }
        }
        if (!pages.length) throw new Error('all sources unavailable');
        const next = parsePricing(id, pages.join('\n'), p);
        if (JSON.stringify([p.tiers,p.inputPerMillion,p.outputPerMillion]) !== JSON.stringify([next.tiers,next.inputPerMillion,next.outputPerMillion])) changes.push({ provider:id, at:stamp, before:p.tiers, after:next.tiers });
        data.providers[id] = { ...next, checkedAt:stamp };
      } catch (e) { errors.push(`${id}: ${e.message}`); }
    }
    data.lastAttempt = stamp; data.checkedAt = stamp; data.errors = errors;
    data.changes = [...(data.changes || []), ...changes].slice(-50);
    atomicJson(file, data); return data;
  })().finally(() => { busy = null; });
  return busy;
}
export function startPriceChecks() {
  if (process.env.AGENTGLIM_DEV === '1') return;
  const run = () => checkPrices().catch(() => {}); run(); return setInterval(run, 864e5).unref();
}
