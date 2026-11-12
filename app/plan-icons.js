// Plan icons, shared by the dashboard (index.html, <script src="/plan-icons.js">) and server.mjs (side-effect import),
// like model-icons.js. A classic script that sets globalThis.PlanIcons.
//   HAND  hand-picked glyphs by plan number (owner picks, plans 01-68), 24x24 stroke paths
//   POOL  more glyphs in the same style, each with keywords, for plans that have no hand pick yet
//   pick(plans, saved)  plans: [{dir, title}], saved: {dir: poolKey} (data/plan-icons.json). Every plan folder gets an
//         icon (a new plan never shows a blank or the default "i"): its hand pick, else its saved
//         pick, else the unused pool glyph whose keywords best match the folder name and PLAN.md title, else the
//         first unused glyph by a stable hash. Picks are saved, so a plan keeps its icon when others come and go.
(() => {
  const HAND = { '55': 'M7 2h10v20H7zM11 18h2', '56': 'M3 8h14l4-3v6h-4l-3 4H8L5 11H3zM9 15v5M15 15v5M6 20h12', '57': 'M4 18a8 8 0 1116 0M12 18l4-6M2 18h20', '58': 'M3 21V10l5 3V10l5 3V10l5 3V4h3v17zM7 17h2M12 17h2M17 17h2', '59': 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z', '60': 'M14 4h6v6L9 21l-3-3zM5 15l4 4M3 21l3-3', '61': 'M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z', '62': 'M12 3a8 8 0 00-8 8v4l2 2v3h12v-3l2-2v-4a8 8 0 00-8-8zM9 12h.01M15 12h.01M10 17h4', '63': 'M12 2l9 5v10l-9 5-9-5V7zM12 12l9-5M12 12L3 7M12 12v10', '64': 'M12 22c4 0 7-3 7-7 0-5-5-7-5-12-3 2-4 5-4 8-2-1-2-3-2-4-2 2-3 5-3 8 0 4 3 7 7 7z', '65': 'M4 8h13l-3-3M20 16H7l3 3', '66': 'M12 22a8 8 0 100-16 8 8 0 000 16zM12 10v4l3 2M9 2h6', '67': 'M13 2L4 14h7l-1 8 9-12h-7z', '68': 'M3 14l14-6 2 4-14 6zM10 15l-2 7M12 14l3 8M17 8l2-1 2 4-2 1', '01': 'M4 20V10M10 20V4M16 20v-7M21 20H3', '02': 'M3 9h18v11H3zM3 9l3-5h4l-3 5M10 4h4l-3 5M14 4h4l-3 5', '03': 'M12 21H5V3h9l4 4v5M15 15m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M17.2 17.2L21 21', '04': 'M4 9a7 7 0 0 1 13-3l2-2v6h-6l2-2a5 5 0 0 0-9 1M20 15a7 7 0 0 1-13 3l-2 2v-6h6l-2 2a5 5 0 0 0 9-1',
  '05': 'M3 8h4l2-3h6l2 3h4v12H3zM12 14m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0', '06': 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16', '07': 'M3 11l18-8-7 18-3-8zM11 13l10-10', '08': 'M3 4h18l-7 8v7l-4 2v-9z', '09': 'M12 3v18M6 21h12M4 7h16M5 7l-3 6h6zM19 7l-3 6h6z', '10': 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5l8 4.5 8-4.5M12 12v9',
  '11': 'M3 4h18v16H3zM9 4v16M15 4v16M5 7h2M11 7h2M11 10h2M17 7h2', '12': 'M4 6h16v14H4zM4 10h16M8 3v5M16 3v5M9 15l2 2 4-4', '13': 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z', '14': 'M6 3h9l4 4v14H6zM9 12h7M9 16c1-2 2 1 3-1s2 1 4 0', '15': 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  '16': 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3', '17': 'M4 4h7a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-5a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h5z', '18': 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M10 8l6 4-6 4z', '19': 'M3 7h16v13H3zM3 7l12-4v4M15 12h6v4h-6z', '20': 'M3 12h6l4-6h5M9 12l4 6h5M16 3l3 3-3 3M16 15l3 3-3 3',
  '21': 'M3 20h18M9 20V9h6v11M3 20v-6h6M15 20v-8h6v8', '22': 'M3 18l6-6 4 4 8-8M15 8h6v6', '23': 'M5 3h14v18H5zM8 6h8v3H8zM8 13h1M12 13h1M16 13h1M8 17h1M12 17h1M16 17h1', '24': 'M5 21V10a7 7 0 0 1 14 0v11l-2.5-2-2.5 2-2-2-2 2-2.5-2zM9.5 10h.01M14.5 10h.01', '25': 'M10 6h11M10 12h11M10 18h11M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17',
  '26': 'M18 2l4 4M20 4l-6 6M14 6l4 4-9 9H5v-4zM8 12l1.5 1.5M11 9l1.5 1.5M3 21l2-2', '27': 'M7.5 15.5m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M10.5 12.5L20 3M16 7l3 3M18 5l2 2', '28': 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3', '29': 'M3 13l3-9h12l3 9v7H3zM3 13h5l1 3h6l1-3h5', '30': 'M12 5a3 3 0 0 0-6 1 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 2zM12 5a3 3 0 0 1 6 1 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 2z',
  '31': 'M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-1-2 0-3 3 0 4-1 3-2 3-4c0-4.5-4-8-9-8zM7.5 11h.01M10 7h.01M15 7h.01', '32': 'M5 21V3h11v18M16 5h3v16M3 21h18M12.5 12h.01', '33': 'M3 5h18v13H3zM8 21h8M10 8.5l5 3-5 3z', '34': 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', '35': 'M11 4v9h9a9 9 0 1 1-9-9zM14 2a8 8 0 0 1 8 8h-8z',
  '36': 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 15h10', '37': 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18', '38': 'M12 10v11M8 21h8M12 10m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 5a7 7 0 0 0 0 10M17 5a7 7 0 0 1 0 10', '39': 'M3 19c3-12 6-12 9 0c2-7 4-7 6 0M19 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0', '40': 'M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7',
  '41': 'M3 7h7l2-3h9v16H3zM12 10v6M9 13l3 3 3-3', '42': 'M4 4l4 5h8l4-5v9l-8 8-8-8zM9 13h.01M15 13h.01', '43': 'M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 6h8M7 8l4 8M17 8l-4 8', '44': 'M12 3l8 8h-5v9H9v-9H4z', '45': 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4M12 15v2',
  '46': 'M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M2 12c0 2.5 4.5 4 10 4s10-1.5 10-4-4.5-4-10-4-10 1.5-10 4', '47': 'M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.5H9A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4zM7 11v3M5.5 12.5h3M16 12h.01M18 14h.01', '48': 'M12 5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12 7.5V15M4 15h16v5H4z', '49': 'M3 3h8l10 10-8 8L3 11zM7.5 7.5h.01M14 11v4M12 13h4', '50': 'M3 7h16v10H3zM21 10v4M6 10v4',
  '51': 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M12 12l6-6', '52': 'M8 4c1.5 0 2 2 2 4s-1 3-2 3-2-1-2-3 .5-4 2-4zM7 13h3v2a1.5 1.5 0 0 1-3 0zM16 9c1.5 0 2 2 2 4s-1 3-2 3-2-1-2-3 .5-4 2-4zM15 18h3v1a1.5 1.5 0 0 1-3 0z', '53': 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2', '54': 'M12 9m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M8.5 14L7 22l5-3 5 3-1.5-8' };
  const POOL = {
    magnet: ['M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4', 'leads lead prospect prospects outreach sales pipeline acquisition attract funnel'],
    dashboard: ['M3 4h18v16H3zM3 9h18M9 9v11M12.5 13h5M12.5 16.5h3', 'dashboard dashboards product analytics metrics panel console portal'],
    crosshair: ['M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 2v4M12 18v4M2 12h4M18 12h4', 'pentest security attack redteam red team target exploit hardening audit'],
    bug: ['M8 9a4 4 0 0 1 8 0v5a4 4 0 0 1-8 0zM12 9v9M4 11h4M16 11h4M4 16h4M16 16h4M9 4l1.5 2M15 4l-1.5 2', 'bug bugs test tests qa quality debug fuzz'],
    rocket: ['M5 15c-1 2-1 4-1 5 1 0 3 0 5-1M9 15l-3-3c2-6 7-9 14-9 0 7-3 12-9 14zM15 9m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', 'launch growth startup release ship go-live scale'],
    mail: ['M3 5h18v14H3zM3 5l9 8 9-8', 'email mail newsletter sequence inbox outreach drip'],
    users: ['M9 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 20c0-3 3-5 6-5s6 2 6 5M17 6a3 3 0 0 1 0 6M21 20c0-2-1.5-4-4-4.5', 'team client clients customers crm people users community onboarding'],
    cart: ['M3 4h3l2 11h11l2-8H7M10 20m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0M17 20m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'shop store ecommerce shopify cart checkout orders commerce'],
    music: ['M9 18V5l11-2v13M9 18m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M20 16m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'music audio podcast sound voice song'],
    terminal: ['M3 4h18v16H3zM7 9l3 3-3 3M12 15h5', 'cli terminal tool tools script dev shell command harness'],
    cloud: ['M7 18a5 5 0 0 1-.5-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z', 'cloud deploy hosting sync remote server saas'],
    pin: ['M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11zM12 10m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0', 'map location local geo places maps seo'],
    calendar: ['M4 5h16v15H4zM4 9h16M8 3v4M16 3v4M12 13v3l2 1', 'schedule calendar cron timer daily weekly monthly booking'],
    link: ['M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1', 'integration integrations connect connector link api plugin webhook'],
    flag: ['M5 21V4M5 4h11l-2 4 2 4H5', 'goal goals milestone roadmap plan strategy okr'],
    coin: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M15 9c-.5-1-1.5-1.5-3-1.5-2 0-3 1-3 2.2 0 3 6 1.6 6 4.6 0 1.2-1 2.2-3 2.2-1.5 0-2.5-.6-3-1.6M12 6v1.5M12 16.5V18', 'pricing billing money revenue invoice finance cost spend budget profit'],
    chat: ['M4 5h16v11H9l-5 4z', 'chat support message assistant bot conversation reply'],
    layers: ['M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5', 'platform stack engine infra infrastructure layer framework'],
    film: ['M4 3h16v18H4zM8 3v18M16 3v18M4 8h4M4 13h4M4 18h4M16 8h4M16 13h4M16 18h4', 'film video videos youtube motion animation movie clip channel'],
    sparkle: ['M12 3l2 5 5 2-5 2-2 5-2-5-5-2 5-2zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z', 'ai magic generate generative model llm prompt agent'],
    trophy: ['M8 4h8v5a4 4 0 0 1-8 0zM8 6H4a3 3 0 0 0 4 4M16 6h4a3 3 0 0 1-4 4M12 13v4M8 21h8M10 17h4', 'benchmark score contest leaderboard ranking win compare'],
    compass: ['M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M15.5 8.5l-2 5-5 2 2-5z', 'research explore discovery strategy direction study'],
    leaf: ['M5 19c0-8 5-14 15-15-1 10-7 15-15 15zM5 19l8-8', 'green eco health wellness garden organic nature'],
    box: ['M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10M7.5 5l9 4', 'package product bundle offer kit inventory warehouse'],
  };
  const words = (s) => String(s || '').toLowerCase().replace(/^\d\d-/, '').split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  function poolPick(dir, title, used) {
    const ws = [...words(dir), ...words(title)], keys = Object.keys(POOL), free = keys.filter((k) => !used.has(k));
    const score = (k) => { const kw = POOL[k][1].split(' '); return ws.reduce((n, w, i) => n + (kw.includes(w) ? (i < words(dir).length ? 3 : 1) : 0), 0); };
    const ranked = (list) => list.map((k) => [k, score(k)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || keys.indexOf(a[0]) - keys.indexOf(b[0]));
    const best = ranked(free)[0] || null;
    if (best) return best[0];
    const list = free.length ? free : keys;
    return list[hash(dir) % list.length];
  }
  // plans: [{dir, title}] -> { icons: {dir: {key, path, auto}}, saved: {dir: key} (the picks to persist) }
  function pick(plans, saved = {}) {
    const icons = {}, out = { ...saved }, used = new Set(Object.values(saved).filter((k) => POOL[k]));
    const list = [...plans].sort((a, b) => String(a.dir).localeCompare(String(b.dir)));
    for (const p of list) {
      const nn = String(p.dir).slice(0, 2);
      if (HAND[nn]) { icons[p.dir] = { key: `hand:${nn}`, path: HAND[nn], auto: false }; continue; }
      let k = POOL[saved[p.dir]] ? saved[p.dir] : null;
      if (!k) { k = poolPick(p.dir, p.title, used); out[p.dir] = k; used.add(k); }
      icons[p.dir] = { key: k, path: POOL[k][0], auto: true };
    }
    return { icons, saved: out };
  }
  const api = { HAND, POOL, pick, poolPick };
  (typeof globalThis !== 'undefined' ? globalThis : window).PlanIcons = api;
})();
