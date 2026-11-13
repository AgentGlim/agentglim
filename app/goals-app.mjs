// goals-app.mjs: the Goals sub-app browser app. Reads /api/goals/* (app/goals-report.mjs) and
// renders from JSON only. No HTML is generated in the goals folder.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const app = $('#app');
const asksMenu = $('#asksMenu');
const asksMenuList = $('#asksMenuList');
const params = new URLSearchParams(location.search);
let demo = params.get('demo') === '1';

const state = {
  demo,
  overview: null,
  asks: new Map(),
  week: null,
  rules: null,
  planPagesUrl: null,
  error: null,
  busy: false,
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (value) => value == null || !Number.isFinite(Number(value)) ? '?' : `${Math.round(Number(value))}%`;
const num = (value) => value == null || !Number.isFinite(Number(value)) ? '?' : `${Math.round(Number(value))}`;
const minutes = (value) => {
  if (value == null || !Number.isFinite(Number(value))) return '?';
  const n = Math.max(0, Math.round(Number(value)));
  return n >= 60 ? `${Math.floor(n / 60)} h ${n % 60 ? `${n % 60} min` : ''}`.trim() : `${n} min`;
};
const ago = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const clock = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'not scheduled';
const dateOnly = (iso) => iso ? String(iso).slice(0, 10) : null;
const shortDate = (iso) => iso ? String(iso).slice(5).replace('-', '/') : '';

function apiPath(route, extra = '') {
  const query = new URLSearchParams();
  if (state.demo || demo) query.set('demo', '1');
  if (extra) for (const [k, v] of new URLSearchParams(extra)) query.set(k, v);
  const qs = query.toString();
  return `/api/goals/${route}${qs ? `?${qs}` : ''}`;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const detail = body?.error;
    const message = typeof detail === 'string' ? detail : detail?.message || `HTTP ${response.status}`;
    throw new Error(message);
  }
  if (body?.error) {
    const error = new Error(typeof body.error === 'string' ? body.error : body.error.message || 'The goals file could not be read.');
    error.detail = typeof body.error === 'string' ? { message: body.error } : body.error;
    throw error;
  }
  return body;
}

function toast(text, bad = false) {
  const el = $('#toast');
  el.textContent = text;
  el.style.borderColor = bad ? 'var(--bad)' : 'var(--line)';
  el.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('on'), bad ? 6000 : 3500);
}

function setFresh(ov) {
  const f = ov?.freshness || {};
  const bits = [`Updated ${ago(f.updatedAt)}`];
  if (f.nextRefreshAt) bits.push(`next refresh ${clock(f.nextRefreshAt)}`);
  else bits.push('refresh not scheduled');
  $('#fresh').textContent = bits.join(' · ');
  $('#fresh').title = f.lastRefreshAt ? `Last refresh ${new Date(f.lastRefreshAt).toLocaleString()}` : 'No refresh recorded yet';
  const chip = $('#errChip');
  if (f.error) { chip.hidden = false; chip.textContent = `Refresh failed: ${f.error}`; chip.title = f.error; }
  else { chip.hidden = true; chip.textContent = ''; chip.title = ''; }
}

async function loadOverview({ silent = false } = {}) {
  try {
    state.error = null;
    const data = await getJson(apiPath('overview'));
    state.overview = data;
    state.demo = !!data.demo;
    demo = state.demo;
    state.planPagesUrl = data.planPagesUrl || null;
    if (!silent) renderAsksMenu();
    setFresh(data);
    $('#demoNote').hidden = !data.demo;
    return data;
  } catch (error) {
    state.error = error.detail || { message: String(error.message || error) };
    renderError(state.error);
    setFresh(null);
    return null;
  }
}

async function loadAsks(goalId) {
  if (state.asks.has(goalId)) return state.asks.get(goalId);
  const promise = getJson(apiPath('asks', `goal=${encodeURIComponent(goalId)}`)).then((data) => {
    state.asks.set(goalId, data);
    return data;
  }).catch((error) => {
    const row = { error: error.detail || { message: String(error.message || error) }, goal: { id: goalId, title: goalId } };
    state.asks.set(goalId, row);
    return row;
  });
  state.asks.set(goalId, { loading: true });
  return promise;
}

async function loadWeek() {
  if (state.week) return state.week;
  try { state.week = await getJson(apiPath('week')); }
  catch (error) { state.week = { error: error.detail || { message: String(error.message || error) } }; }
  return state.week;
}

async function loadRules() {
  if (state.rules) return state.rules;
  try { state.rules = await getJson(apiPath('rules')); }
  catch (error) { state.rules = { error: error.detail || { message: String(error.message || error) } }; }
  return state.rules;
}

function renderError(error) {
  app.innerHTML = `<section class="card" id="errorCard"><h2>Could not read the goals data</h2>
    <p class="lede">${error.file ? `<code>${esc(error.file)}</code>${error.field ? ` · field <code>${esc(error.field)}</code>` : ''}: ` : ''}${esc(error.message || 'Unknown error.')}</p>
    <p class="small muted">Fix that field, then press Refresh now. See SETUP.md for the goals.json format.</p>
    <p><button type="button" id="errorRefresh">Refresh now</button> <a class="pill" href="/setup">Setup</a></p></section>`;
  $('#errorRefresh')?.addEventListener('click', refreshNow);
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, '');
  if (hash.startsWith('asks/')) return { tab: 'asks', goal: decodeURIComponent(hash.slice(5)) };
  if (['overview', 'week', 'rules'].includes(hash)) return { tab: hash };
  if (hash === 'goals') return { tab: 'overview' };
  return { tab: 'overview' };
}

function setActive(tab) {
  for (const el of $$('nav.tabs [data-tab]')) {
    if (el.dataset.tab === tab) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function renderAsksMenu() {
  const goals = state.overview?.goals || [];
  if (!goals.length) { asksMenuList.innerHTML = '<span class="muted small" style="padding:8px 10px">No goals yet</span>'; return; }
  asksMenuList.innerHTML = goals.map((goal) => {
    const hot = goal.asks?.needYou || 0, open = goal.asks?.open || 0;
    return `<a role="menuitem" href="#asks/${encodeURIComponent(goal.id)}" data-asks="${esc(goal.id)}" style="--c:${esc(goal.color)}">
      <span class="chip" style="--c:${esc(goal.color)}">${esc(goal.label)}</span>
      <span class="count${hot ? ' hot' : ''}" title="${open} open, ${hot} need you">${open}</span></a>`;
  }).join('');
}

async function render() {
  const route = parseRoute();
  setActive(route.tab);
  if (route.tab !== 'asks') asksMenu.open = false;
  if (!state.overview) {
    if (!state.error) app.innerHTML = '<section class="card"><h2>Loading goals...</h2><p class="lede">Reading the goals folder and the latest review.</p></section>';
    return;
  }
  if (route.tab === 'asks') return renderAsks(route.goal);
  if (route.tab === 'week') return renderWeek();
  if (route.tab === 'rules') return renderRules();
  renderOverview();
  updateWeeklyButton();
}

function renderOverview() {
  const ov = state.overview;
  if (!ov.goals?.length) {
    app.innerHTML = `<section class="card empty"><h2>Set up your goals</h2>
      <p class="lede">No goals.json yet. Ask your AI agent to read SETUP.md and interview you, or copy the example goals file.</p>
      <p><a class="btn" href="/setup">Open Setup</a> <a class="btn" href="/goals?demo=1">See the demo</a></p></section>`;
    return;
  }
  const o = ov.overall || {};
  const G = ov.goals.filter((g) => g.target != null || g.lane !== 'floor');
  const P = ov.goals.filter((g) => g.paused);
  const top = [...G].sort((a, b) => (b.share ?? 0) - (a.share ?? 0))[0];
  const dlt = (v, p) => v == null || p == null ? '' : `<em class="small ${v >= p ? 'muted' : ''}">${v >= p ? '+' : '-'}${Math.abs(Math.round(v - p))} vs last wk</em>`;
  const effO = Math.max(0, o.ownerMin ?? 0), effA = Math.max(0, Math.round((o.minutes ?? 0) * (ov.weighting?.WA ?? 0.1))), effT = Math.max(1, effO + effA);
  const oPct = Math.round(100 * effO / effT);
  const hero = `<section id="stand"><h2>Where things stand <span class="sub">${esc(ov.baseline ? `baseline ${ov.baseline}` : '')}${ov.policy ? ` · ${esc(ov.policy)}` : ''}</span></h2>
    <div class="hero">
      <figure class="ringfig">${ring(o.alignment, 'var(--accent)', 54, 12, 26)}<figcaption><b>${pct(o.alignment)}</b> weighted alignment ${dlt(o.alignment, o.prev)}</figcaption></figure>
      <div>
        <div class="kp">
          <div><b>${pct(o.ownerAlign)}</b><span>Your time on target</span></div>
          <div><b class="dim">${pct(o.agentAlign)}</b><span>Agent time on target ${dlt(o.agentAlign, o.agentPrev)}</span></div>
        </div>
        <div class="eff" role="img" aria-label="weighted effort this week: you ${oPct}%, agents ${100 - oPct}%"><i class="o" style="flex:${effO}"></i><i class="a" style="flex:${effA}"></i></div>
        <p class="legend"><span><i class="sw" style="--c:var(--accent2)"></i>You ${minutes(effO)} x ${ov.weighting?.WH ?? 1}</span>
          <span><i class="sw" style="--c:var(--muted)"></i>Agents ${minutes(o.minutes ?? 0)} x ${ov.weighting?.WA ?? 0.1} = ${minutes(effA)}</span>
          <span>Your time is ${oPct}% of the score.</span></p>
      </div>
    </div></section>`;

  const gmax = Math.max(50, ...G.map((g) => Math.max(g.share ?? 0, g.target ?? 0)));
  const goalRows = G.map((g) => {
    const d = (g.share ?? 0) - (g.target ?? 0);
    const cls = Math.abs(d) < 3 ? 'ok' : d > 0 ? 'over' : 'under';
    const plans = (g.plans || []).map((p) => `<a class="planlink" href="${planHref(p.dir)}" title="${esc(p.title)}">${esc(p.dir)}<span class="state ${esc(p.state)}">${esc(p.state)}</span></a>`).join(' ');
    return `<div class="grow" style="--c:${esc(g.color)}">
      <div class="gname"><span class="dot"></span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a><small>${esc(g.lane)}${g.allocation != null ? ` · ${g.allocation}%` : ''}</small>${g.paused ? '<span class="state held">paused</span>' : ''}</div>
      <div class="meterrow" title="alignment ${pct(g.alignment)}"><span class="meter"><i style="transform:scaleX(${Math.max(0, Math.min(1, (g.alignment ?? 0) / 100)).toFixed(3)})"></i></span><b>${pct(g.alignment)}</b></div>
      <div class="drift" title="${esc(`${g.share}% of weighted time vs ${g.target}% weight`)}"><span class="driftbar"><u style="left:${(100 * (g.target ?? 0) / gmax).toFixed(1)}%"></u><i class="${cls}" style="left:${(100 * Math.min(g.share ?? 0, g.target ?? 0) / gmax).toFixed(1)}%;width:${(100 * Math.abs(d) / gmax).toFixed(1)}%"></i></span><b class="${d > 0 ? 'up' : d < 0 ? 'down' : 'same'}">${d > 0 ? '+' : d < 0 ? '-' : ''}${Math.abs(Math.round(d))}</b></div>
      <div class="detail">${g.next ? `<span><b>Next:</b> ${esc(g.next)}</span>` : ''}${plans ? `<span>${plans}</span>` : '<span class="muted">no plans mapped</span>'}${(g.metrics || []).map((m) => `<span class="chip plain">${esc(m.label)}: ${m.actual == null ? 'not measured' : esc(m.actual)} / ${esc(m.target ?? '-')}</span>`).join('')}<a href="#asks/${encodeURIComponent(g.id)}" class="chip" style="--c:${esc(g.color)}">${g.asks?.needYou || 0} need you</a></div>
    </div>`;
  }).join('');
  const goalSection = `<section id="goals"><h2>Where each goal stands <span class="sub">${G.length} weighted goal${G.length === 1 ? '' : 's'}${P.length ? ` · ${P.length} paused` : ''}</span></h2>
    <div class="goalrows">${goalRows}</div>
    <p class="legend"><span><i class="sw" style="--c:var(--text)"></i>weight</span><span><i class="sw" style="--c:var(--accent)"></i>weighted time share</span><span class="muted">Drift is in points: over weight in amber, under weight in red.</span></p>
    ${P.map((g) => `<p class="small muted">${esc(g.label)} paused${g.paused?.recheck ? ` until ${esc(g.paused.recheck)}` : ''}${g.paused?.reason ? `: ${esc(g.paused.reason)}` : ''}.</p>`).join('')}</section>`;

  const drift = `<section id="drift"><h2>Alignment by week</h2>${lineChart(ov.weeks || [])}
    <p class="legend"><span><i class="sw" style="--c:var(--accent)"></i>weighted</span><span><i class="sw" style="--c:var(--accent2)"></i>your time</span><span><i class="sw" style="--c:var(--muted)"></i>agent time</span></p></section>`;

  const metrics = ov.goals.flatMap((g) => (g.metrics || []).map((m) => ({ ...m, goal: g })));
  const results = `<section id="results"><h2>Results so far</h2>
    ${metrics.length ? `<div class="bars">${metrics.map((m) => `<div class="barrow" style="--c:${esc(m.goal.color)}"><span><a href="#asks/${encodeURIComponent(m.goal.id)}">${esc(m.goal.label)}</a> · ${esc(m.label)}</span><span class="track"><i style="transform:scaleX(${m.actual != null && m.target ? Math.max(0, Math.min(1, Number(m.actual) / Math.max(Number(m.target), 1))).toFixed(3) : 0})"></i><u style="left:100%"></u></span><b>${m.actual == null ? 'not measured' : esc(m.actual)} / ${esc(m.target ?? '-')}</b></div>`).join('')}</div>`
      : '<p class="lede">No metrics in goals.json yet. Add a metrics entry to see results here.</p>'}
    <p class="small muted">${ov.goals.map((g) => `${esc(g.label)}: ${g.gates?.met ?? 0} of ${g.gates?.total ?? 0} gates met${g.gates?.unknown ? `, ${g.gates.unknown} unknown` : ''}`).join(' · ')}</p></section>`;

  const priorities = ov.priorities || [];
  const now = `<section id="now"><h2>What matters now</h2>
    <h3>The ${priorities.length === 5 ? 'five' : priorities.length || 'current'} priorities from the weekly review</h3>
    ${priorities.length ? `<ol class="ladder">${priorities.slice(0, 8).map((p) => { const g = goalById(p.goal); return `<li style="--c:${esc(g?.color || 'var(--accent)')}"><span class="rk">${esc(p.rank ?? '')}</span><div class="lb"><span>${g ? `<a class="chip" style="--c:${esc(g.color)}" href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a>` : `<span class="chip plain">${esc(p.goal || 'focus')}</span>`}</span><b>${esc(p.action || p.title)}</b>${p.metric ? `<small>Done when: ${esc(p.metric)}</small>` : ''}${p.why ? `<small>${esc(p.why)}</small>` : ''}</div><span class="who ${p.who === 'owner' ? 'owner' : ''}">${p.who === 'owner' ? 'You' : 'Agent'}</span></li>`; }).join('')}</ol>`
      : '<p class="lede">No priorities in the latest review yet. Run the weekly AI review, or add them to a review JSON.</p>'}</section>`;

  const weekItems = ov.week || [];
  const today = `<section id="today"><h2>Today and this week</h2>
    ${weekItems.length ? `<ol>${weekItems.map((w) => `<li>${esc(w)}</li>`).join('')}</ol>` : '<p class="lede">No "next seven days" list in the latest review markdown.</p>'}
    <div class="grid2" style="margin-top:10px">${ov.goals.filter((g) => g.next).slice(0, 6).map((g) => `<div class="mini" style="--c:${esc(g.color)}"><h3><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></h3><p class="small">${esc(g.next)}</p></div>`).join('')}</div></section>`;

  const coming = `<section id="coming"><h2>What comes next</h2>
    ${weekItems.length ? `<ol>${weekItems.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join('')}</ol>` : `<div class="grid2">${priorities.slice(0, 4).map((p) => `<div class="mini"><h3>${esc(p.action || p.title)}</h3><p class="small">${esc(p.next || p.why || '')}</p></div>`).join('') || '<p class="lede">No next steps in the latest review yet.</p>'}</div>`}
    </section>`;

  const askRows = ov.goals.map((g) => `<a class="ask" href="#asks/${encodeURIComponent(g.id)}" style="--c:${esc(g.color)}"><span class="kind">${esc(g.label)}</span><span class="tx"><b>${g.asks?.open || 0} open ask${g.asks?.open === 1 ? '' : 's'}</b><span>${g.asks?.needYou || 0} need your call${g.plans?.length ? ` · ${g.plans.length} plan${g.plans.length === 1 ? '' : 's'}` : ' · no plans mapped'}</span></span><span class="st ${g.asks?.needYou ? 'hot' : ''}">${g.asks?.needYou ? 'Needs you' : 'Clear'}</span></a>`).join('');
  const asks = `<section id="asks"><h2>Asks waiting on you <span class="sub">${ov.counts?.needYou ?? 0} need you, ${ov.counts?.openAsks ?? 0} open</span></h2><div class="asklist">${askRows}</div></section>`;

  const roadmap = `<section id="next"><h2>Roadmap: today to this year</h2><div class="grid2">${ov.goals.map((g) => `<div class="mini" style="--c:${esc(g.color)}"><h3><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></h3><p class="small"><b>Next:</b> ${esc(g.next || 'not set')}</p>${g.outcome ? `<p class="small muted">${esc(g.outcome)}</p>` : ''}${(g.acceptance || []).length ? `<ul class="small muted">${g.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</div>`).join('')}</div></section>`;

  const projects = `<section id="projects"><h2>Projects by state, per goal</h2><div class="bars">${ov.goals.map((g) => {
    const plans = g.plans || [], counts = {};
    for (const p of plans) counts[p.state] = (counts[p.state] || 0) + 1;
    const total = Math.max(1, plans.length), colours = { building: 'var(--accent2)', gate: 'var(--warn)', held: 'var(--bad)', done: 'var(--info)', waiting: 'var(--muted)', example: 'var(--muted)' };
    return `<div class="barrow" style="--c:${esc(g.color)}"><span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></span><span class="track" title="${esc(plans.map((p) => `${p.dir}: ${p.state}`).join(', ') || 'no plans mapped')}"><i style="transform:scaleX(${(plans.length / Math.max(1, ...ov.goals.map((x) => x.plans?.length || 0))).toFixed(3)})"></i></span><b>${plans.length}</b></div>`;
  }).join('')}</div><p class="small muted">${ov.counts?.plans ?? 0} mapped plan${ov.counts?.plans === 1 ? '' : 's'}. States: building, gate, held, done, waiting.</p></section>`;

  const hours = `<section id="weeks"><h2>Your hours per week, stacked</h2>${hoursChart(ov.weeks || [])}<p class="legend"><span><i class="sw" style="--c:var(--accent2)"></i>your minutes</span><span><i class="sw" style="--c:var(--muted)"></i>agent minutes</span></p></section>`;
  const you = `<section id="you"><h2>Your time against each weight</h2>${weightChart(G)}<p class="legend"><span><i class="sw" style="--c:var(--accent2)"></i>your share</span><span><i class="sw" style="--c:var(--text)"></i>weight</span><span><i class="sw" style="--c:var(--muted)"></i>agents</span></p></section>`;
  const area = `<section id="area"><h2>Your hours by area, week by week</h2>${stackedHours(ov.weeks || [], ov.goals)}<p class="legend">${ov.goals.map((g) => `<span><i class="sw" style="--c:${esc(g.color)}"></i>${esc(g.label)}</span>`).join('')}</p></section>`;
  const cum = `<section id="cum"><h2>Agent rounds finished, running total</h2>${cumulativeChart(ov.weeks || [])}</section>`;
  const byGoalAlign = `<section id="bygoal"><h2>Alignment by goal, this week</h2>${goalBarChart(G, (g) => g.alignment, 100, '%')}</section>`;
  const overUnder = `<section id="overunder"><h2>Over or under weight, by goal (points)</h2>${pointsChart(G)}</section>`;
  const expected = `<section id="expected"><h2>Expected against actual</h2>${expectedChart(ov.goals)}</section>`;
  const radar = `<section id="radar"><h2>Weight against time, as a radar</h2>${radarChart(G)}<p class="legend"><span><i class="sw" style="--c:var(--text)"></i>weight</span><span><i class="sw" style="--c:var(--accent)"></i>weighted time share</span></p></section>`;
  const columns = `<section id="columns"><h2>Weight against share, as columns</h2>${columnsChart(G)}</section>`;
  const heat = `<section id="heat"><h2>Your hours by week, as a heatmap</h2>${heatmap(ov.weeks || [])}</section>`;

  const unmapped = ov.unmapped || [];
  const outside = `<section id="unmapped"><h2>Projects outside the goals <span class="sub">${unmapped.length}</span></h2>${unmapped.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px">${unmapped.map((d) => `<a class="chip plain" href="${planHref(d)}">${esc(d)}</a>`).join('')}</div>` : '<p class="lede">Every plan folder is mapped to a goal.</p>'}</section>`;

  const detail = `<section id="detail"><h2>The detail</h2>
    <details class="block" open><summary>What drifted this week</summary>
      ${(ov.drift || []).length ? `<ul class="notes">${ov.drift.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="small muted">No drift notes in the latest review.</p>'}
      ${(ov.gaps || []).length ? `<h3 style="margin-top:10px">Gaps in the evidence</h3><ul class="notes">${ov.gaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${ov.experiment ? `<p class="small"><b>Experiment:</b> ${esc(ov.experiment)}</p>` : ''}
    </details>
  </section>`;
  const method = `<section id="method"><h2>How the numbers work</h2>
    <ul class="notes">
      <li>${esc(ov.weighting?.formula || 'Effort = owner minutes plus weighted agent minutes.')}${ov.weighting?.why ? ` ${esc(ov.weighting.why)}` : ''}</li>
      <li>Your time comes from ${num(ov.weighting?.sessions)} interactive sessions and ${num(ov.weighting?.blocks)} active blocks. A gap over ${num(ov.weighting?.gapMin)} min ends a block, and ${num(ov.weighting?.tailMin)} min are added after the last message.</li>
      <li>Agent time is the finished agent minutes in the harness log. Client work (the floor) and paused goals stay out of the alignment score.</li>
      <li>${num(ov.weighting?.agentMin)} agent minutes and ${num(ov.weighting?.superMin)} supervision minutes are in this week's weighting.</li>
    </ul></section>`;

  const byGoal = `<section id="goalbygoal"><h2>Goal by goal</h2><div class="grid2">${ov.goals.map((g) => `<div class="card" style="--c:${esc(g.color)}"><h3><a href="#asks/${encodeURIComponent(g.id)}" style="color:var(--text);text-decoration:none;border-bottom:1px dotted ${esc(g.color)}">${esc(g.label)}</a> <span class="state ${esc(g.status || '')}">${esc(g.status || g.lane)}</span></h3>
      <p class="small"><b>Share:</b> ${pct(g.share)} of weighted time against ${pct(g.target)} weight. You ${pct(g.ownerShare)}, agents ${pct(g.agentShare)}.</p>
      <p class="small"><b>Next:</b> ${esc(g.next || 'not set')}</p>
      ${(g.acceptance || []).length ? `<ul class="small muted">${g.acceptance.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
      <p class="small muted">${(g.plans || []).map((p) => `${esc(p.dir)} (${esc(p.state)})`).join(', ') || 'no plans mapped'}</p></div>`).join('')}</div></section>`;

  app.innerHTML = [hero, goalSection, drift, results, now, today, coming, asks, roadmap, projects, hours, you, area, cum, byGoalAlign, overUnder, expected, radar, columns, heat, byGoal, outside, detail, method].join('');
}

function goalById(id) { return (state.overview?.goals || []).find((g) => g.id === id) || null; }

function planHref(dir) {
  if (!state.planPagesUrl) return '#';
  return `${state.planPagesUrl.replace(/\/$/, '')}/${encodeURIComponent(dir)}/index.html`;
}

function ring(value, colour, r = 30, sw = 7, fs = 13) {
  const c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, Number(value) || 0)), s = r + sw;
  return `<svg viewBox="0 0 ${2 * s} ${2 * s}" width="${2 * s}" height="${2 * s}" role="img" aria-label="${value == null ? 'unknown' : Math.round(value)} percent"><circle cx="${s}" cy="${s}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/><circle cx="${s}" cy="${s}" r="${r}" fill="none" stroke="${colour}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${(c * v / 100).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${s} ${s})"/><text x="${s}" y="${s}" dy=".35em" text-anchor="middle" fill="var(--text)" font-size="${fs}" font-weight="650">${value == null ? '?' : `${Math.round(value)}%`}</text></svg>`;
}

function lineChart(weeks) {
  const rows = weeks.filter((w) => w.end);
  if (!rows.length) return '<p class="lede">No weekly history yet. The first refresh records this week.</p>';
  const W = 720, H = 220, L = 38, R = 18, T = 18, B = 28;
  const px = (i) => L + i * (W - L - R) / Math.max(1, rows.length - 1);
  const py = (v) => T + (H - T - B) * (1 - Math.max(0, Math.min(100, Number(v) || 0)) / 100);
  const series = [
    { key: 'alignment', colour: 'var(--accent)', width: 3, dash: '' },
    { key: 'ownerAlign', colour: 'var(--accent2)', width: 2, dash: '' },
    { key: 'agentAlign', colour: 'var(--muted)', width: 2, dash: '4 3' },
  ];
  const grid = [0, 25, 50, 75, 100].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"${v % 50 ? ' stroke-dasharray="2 4"' : ''}/><text x="${L - 8}" y="${py(v) + 4}" text-anchor="end">${v}</text>`).join('');
  const lines = series.map((s) => {
    let started = false, path = '';
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][s.key];
      if (v == null) { started = false; continue; }
      path += `${started ? 'L' : 'M'}${px(i).toFixed(1)},${py(v).toFixed(1)} `;
      started = true;
    }
    return path ? `<path d="${path.trim()}" fill="none" stroke="${s.colour}" stroke-width="${s.width}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>` : '';
  }).join('');
  const dots = rows.map((w, i) => w.alignment == null ? '' : `<circle cx="${px(i).toFixed(1)}" cy="${py(w.alignment).toFixed(1)}" r="4" fill="var(--panel)" stroke="var(--accent)" stroke-width="2.5"><title>${esc(w.end)}: weighted ${w.alignment}%, you ${w.ownerAlign ?? '?'}%, agents ${w.agentAlign ?? '?'}%</title></circle><text class="v" x="${px(i).toFixed(1)}" y="${(py(w.alignment) - 9).toFixed(1)}" text-anchor="middle">${w.alignment}%</text>`).join('');
  const labels = rows.map((w, i) => `<text x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(shortDate(w.end))}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="alignment per week">${grid}${lines}${dots}${labels}</svg>`;
}

function hoursChart(weeks) {
  const rows = weeks.filter((w) => w.end);
  if (!rows.length) return '<p class="lede">No weekly history yet.</p>';
  const W = 720, H = 220, L = 40, R = 18, T = 18, B = 32;
  const max = Math.max(60, ...rows.map((w) => Math.max(w.ownerMin ?? 0, w.minutes ?? 0)));
  const slot = (W - L - R) / rows.length, bw = Math.max(8, Math.min(26, slot * 0.3));
  const py = (v) => T + (H - T - B) * (1 - (Number(v) || 0) / max);
  const bars = rows.map((w, i) => {
    const x = L + i * slot + slot / 2;
    const o = w.ownerMin ?? 0, a = w.minutes ?? 0;
    return `<rect x="${(x - bw - 1).toFixed(1)}" y="${py(o).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, H - B - py(o)).toFixed(1)}" rx="3" fill="var(--accent2)"><title>${esc(w.end)}: you ${minutes(o)}</title></rect>
      <rect x="${(x + 1).toFixed(1)}" y="${py(a).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, H - B - py(a)).toFixed(1)}" rx="3" fill="var(--muted)"><title>${esc(w.end)}: agents ${minutes(a)}</title></rect>
      <text x="${x.toFixed(1)}" y="${(py(Math.max(o, a)) - 6).toFixed(1)}" text-anchor="middle" class="v">${minutes(o)} / ${minutes(a)}</text>
      <text x="${x.toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(shortDate(w.end))}</text>`;
  }).join('');
  const grid = [0, Math.round(max / 2), max].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"/><text x="${L - 8}" y="${py(v) + 4}" text-anchor="end">${Math.round(v / 60)}h</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="your minutes and agent minutes per week">${grid}${bars}</svg>`;
}

function weightChart(goals) {
  const rows = goals.filter((g) => g.target != null);
  if (!rows.length) return '<p class="lede">No weighted goals yet.</p>';
  const max = Math.max(50, ...rows.map((g) => Math.max(g.ownerShare ?? 0, g.target ?? 0, g.agentShare ?? 0)));
  return `<div class="bars">${rows.map((g) => `<div class="barrow" style="--c:${esc(g.color)}"><span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></span><span class="track" title="you ${pct(g.ownerShare)}, agents ${pct(g.agentShare)}, weight ${pct(g.target)}"><i style="transform:scaleX(${((g.ownerShare ?? 0) / max).toFixed(3)})"></i><u style="left:${(100 * (g.target ?? 0) / max).toFixed(1)}%"></u><s style="left:${(100 * (g.agentShare ?? 0) / max).toFixed(1)}%"></s></span><b>${pct(g.ownerShare)}</b></div>`).join('')}</div>`;
}

function goalBarChart(goals, valueOf, max, suffix = '') {
  const rows = goals.filter((g) => valueOf(g) != null);
  if (!rows.length) return '<p class="lede">No data yet.</p>';
  return `<div class="bars">${rows.map((g) => { const v = Math.max(0, Math.min(max, Number(valueOf(g)) || 0)); return `<div class="barrow" style="--c:${esc(g.color)}"><span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></span><span class="track"><i style="transform:scaleX(${(v / max).toFixed(3)})"></i></span><b>${Math.round(v)}${suffix}</b></div>`; }).join('')}</div>`;
}

function pointsChart(goals) {
  const rows = goals.filter((g) => g.target != null);
  if (!rows.length) return '<p class="lede">No weighted goals yet.</p>';
  const max = Math.max(20, ...rows.map((g) => Math.abs((g.share ?? 0) - (g.target ?? 0))));
  return `<div class="bars">${rows.map((g) => { const d = (g.share ?? 0) - (g.target ?? 0), w = Math.abs(d) / max * 50; return `<div class="barrow" style="--c:${esc(g.color)}"><span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a></span><span class="track" title="${d > 0 ? 'over' : d < 0 ? 'under' : 'on'} weight by ${Math.abs(d)} points"><i class="${d >= 0 ? 'over' : 'under'}" style="left:50%;width:${w.toFixed(1)}%;transform:${d >= 0 ? 'none' : `translateX(-100%)`}"></i><u style="left:50%"></u></span><b>${d > 0 ? '+' : ''}${Math.round(d)}</b></div>`; }).join('')}</div>`;
}

function expectedChart(goals) {
  const rows = goals.flatMap((g) => (g.metrics || []).map((m) => ({ g, m }))).filter(({ m }) => m.target != null);
  if (!rows.length) return '<p class="lede">No metrics with a target yet.</p>';
  const max = Math.max(1, ...rows.map(({ m }) => Math.max(Number(m.actual) || 0, Number(String(m.target).split('-').pop()) || 1)));
  return `<div class="bars">${rows.map(({ g, m }) => { const target = Number(String(m.target).split('-').pop()) || 1, actual = Number(m.actual) || 0; return `<div class="barrow" style="--c:${esc(g.color)}"><span><a href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a> · ${esc(m.label)}</span><span class="track" title="expected ${esc(m.target)}, actual ${m.actual == null ? 'not measured' : esc(m.actual)}"><i style="transform:scaleX(${(actual / max).toFixed(3)})"></i><u style="left:${(100 * target / max).toFixed(1)}%"></u></span><b>${m.actual == null ? '?' : esc(m.actual)} / ${esc(m.target)}</b></div>`; }).join('')}</div>`;
}

function radarChart(goals) {
  const rows = goals.filter((g) => g.target != null);
  if (rows.length < 3) return '<p class="lede">A radar needs at least three weighted goals.</p>';
  const S = 320, c = S / 2, r = 110, n = rows.length;
  const pt = (i, v) => { const a = -Math.PI / 2 + i * 2 * Math.PI / n, d = r * Math.max(0, Math.min(100, v || 0)) / 100; return [c + Math.cos(a) * d, c + Math.sin(a) * d]; };
  const poly = (key) => rows.map((g, i) => pt(i, key === 'target' ? g.target : g.share).map((x) => x.toFixed(1)).join(',')).join(' ');
  const axes = rows.map((g, i) => { const [x, y] = pt(i, 100), [lx, ly] = pt(i, 118); return `<line class="axis" x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/><text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(g.label)}</text>`; }).join('');
  const rings = [25, 50, 75, 100].map((v) => `<circle cx="${c}" cy="${c}" r="${(r * v / 100).toFixed(1)}" fill="none" stroke="var(--line)" stroke-dasharray="2 4"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${S} ${S}" role="img" aria-label="weight against weighted time share, as a radar">${rings}${axes}<polygon points="${poly('target')}" fill="none" stroke="var(--text)" stroke-width="2"/><polygon points="${poly('share')}" fill="color-mix(in srgb, var(--accent) 18%, transparent)" stroke="var(--accent)" stroke-width="2.5"/></svg>`;
}

function columnsChart(goals) {
  const rows = goals.filter((g) => g.target != null);
  if (!rows.length) return '<p class="lede">No weighted goals yet.</p>';
  const W = 720, H = 220, L = 30, B = 34, T = 14, R = 12;
  const max = Math.max(50, ...rows.map((g) => Math.max(g.target ?? 0, g.share ?? 0)));
  const slot = (W - L - R) / rows.length, bw = Math.min(34, slot * 0.3);
  const py = (v) => T + (H - T - B) * (1 - Math.max(0, Math.min(100, v || 0)) / max);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="weight against weighted time share, as columns">${[0, 50, 100].filter((v) => v <= max).map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"/><text x="${L - 6}" y="${py(v) + 4}" text-anchor="end">${v}</text>`).join('')}${rows.map((g, i) => { const x = L + slot * i + slot / 2; return `<rect x="${(x - bw - 1).toFixed(1)}" y="${py(g.target).toFixed(1)}" width="${bw}" height="${Math.max(1, H - B - py(g.target)).toFixed(1)}" rx="3" fill="var(--text)" opacity=".55"><title>${esc(g.label)} weight ${g.target}%</title></rect><rect x="${(x + 1).toFixed(1)}" y="${py(g.share).toFixed(1)}" width="${bw}" height="${Math.max(1, H - B - py(g.share)).toFixed(1)}" rx="3" fill="${esc(g.color)}"><title>${esc(g.label)} share ${g.share}%</title></rect><text x="${x.toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(g.label)}</text>`; }).join('')}</svg>`;
}

function cumulativeChart(weeks) {
  const rows = weeks.filter((w) => w.end);
  if (!rows.length) return '<p class="lede">No weekly history yet.</p>';
  const W = 720, H = 190, L = 40, B = 28, T = 16, R = 14;
  let total = 0; const vals = rows.map((w) => (total += w.minutes || 0));
  const max = Math.max(1, ...vals);
  const px = (i) => L + i * (W - L - R) / Math.max(1, rows.length - 1), py = (v) => T + (H - T - B) * (1 - v / max);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="finished agent minutes, running total">${[0, max].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"/><text x="${L - 6}" y="${py(v) + 4}" text-anchor="end">${Math.round(v / 60)}h</text>`).join('')}<polyline points="${vals.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')}" fill="none" stroke="var(--accent2)" stroke-width="2.5"/>${vals.map((v, i) => `<circle cx="${px(i).toFixed(1)}" cy="${py(v).toFixed(1)}" r="3.5" fill="var(--panel)" stroke="var(--accent2)" stroke-width="2"><title>${esc(rows[i].end)}: ${minutes(v)} total</title></circle>`).join('')}${rows.map((w, i) => `<text x="${px(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(shortDate(w.end))}</text>`).join('')}</svg>`;
}

function stackedHours(weeks, goals) {
  const rows = weeks.filter((w) => w.end && w.ownerBy);
  if (!rows.length) return '<p class="lede">No per-area hours yet. The first review records them.</p>';
  const areas = [...new Set(rows.flatMap((w) => Object.keys(w.ownerBy || {})))];
  const colours = Object.fromEntries(goals.map((g) => [g.id, g.color]));
  const max = Math.max(30, ...rows.map((w) => Object.values(w.ownerBy || {}).reduce((a, b) => a + b, 0)));
  const W = 720, H = 210, L = 36, B = 30, T = 14, R = 12, slot = (W - L - R) / rows.length, bw = Math.min(34, slot * 0.55);
  const py = (v) => T + (H - T - B) * (1 - v / max);
  const bars = rows.map((w, i) => {
    let y = H - B; const x = L + slot * i + slot / 2 - bw / 2;
    return areas.map((a) => { const v = w.ownerBy?.[a] || 0, h = (H - T - B) * v / max; y -= h; return v ? `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, h - 1).toFixed(1)}" rx="2" fill="${esc(colours[a] || 'var(--muted)')}"><title>${esc(w.end)} ${esc(a)}: ${minutes(v)}</title></rect>` : ''; }).join('') + `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(shortDate(w.end))}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="your minutes per area, per week">${[0, max].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}"/><text x="${L - 6}" y="${py(v) + 4}" text-anchor="end">${Math.round(v / 60)}h</text>`).join('')}${bars}</svg>`;
}

function heatmap(weeks) {
  const rows = weeks.filter((w) => w.end);
  if (!rows.length) return '<p class="lede">No weekly history yet.</p>';
  const max = Math.max(30, ...rows.map((w) => Math.max(w.ownerMin || 0, w.minutes || 0)));
  const cell = (v) => { const a = Math.max(0, Math.min(1, (v || 0) / max)); return `style="background:color-mix(in srgb, var(--accent) ${Math.round(12 + a * 78)}%, transparent)"`; };
  return `<div class="heat" role="img" aria-label="your minutes and agent minutes per week as a heatmap"><span></span>${rows.map((w) => `<b>${esc(shortDate(w.end))}</b>`).join('')}<span>You</span>${rows.map((w) => `<i ${cell(w.ownerMin)} title="${esc(w.end)}: you ${minutes(w.ownerMin)}">${Math.round(w.ownerMin || 0)}</i>`).join('')}<span>Agents</span>${rows.map((w) => `<i ${cell(w.minutes)} title="${esc(w.end)}: agents ${minutes(w.minutes)}">${Math.round(w.minutes || 0)}</i>`).join('')}</div>`;
}

function renderAsks(goalId) {
  const ov = state.overview;
  const row = state.asks.get(goalId);
  const goal = goalById(goalId) || row?.goal || { id: goalId, title: goalId, color: 'var(--accent)', label: goalId };
  if (!row || row.loading) {
    app.innerHTML = `<section class="card"><h2>${esc(goal.label || goalId)} asks</h2><p class="lede">Loading open asks...</p></section>`;
    loadAsks(goalId).then(render);
    return;
  }
  if (row.error) { renderError(row.error); return; }
  const asks = row;
  const projects = asks.projects || [];
  const items = projects.flatMap((p) => (p.asks || []).map((a) => ({ ...a, project: p })));
  const need = items.filter((a) => a.needYou).length;
  const projectHtml = projects.map((p) => {
    const rows = p.asks || [];
    const needRows = rows.filter((a) => a.needYou), rest = rows.filter((a) => !a.needYou);
    const line = (a) => {
      const href = a.href || (a.anchor && state.planPagesUrl ? `${state.planPagesUrl.replace(/\/$/, '')}/${encodeURIComponent(p.dir)}/approvals.html#${encodeURIComponent(a.anchor)}` : null);
      const tag = href ? 'a' : 'div';
      const status = a.needYou ? (a.choice === 'will' ? 'You said: I will do it' : 'Needs your call') : `Your call: ${choiceLabel(a.choice)}`;
      return `<${tag} class="ask" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : ''}><span class="kind">${esc(a.kind || 'ask')}</span><span class="tx"><b>${esc(a.title)}</b>${a.short ? `<span>${esc(a.short)}</span>` : ''}</span><span class="st ${a.needYou ? 'hot' : 'call'}">${esc(status)}</span></${tag}>`;
    };
    return `<section class="card" id="p-${esc(p.dir)}"><h3><a href="${planHref(p.dir)}" target="_blank" rel="noopener" class="planlink">${esc(p.dir)}: ${esc(p.title)}</a> <span class="state ${esc(p.state)}">${esc(p.state)}</span> <span class="small muted">${rows.length} open · ${p.needYou} need you</span></h3>
      ${needRows.length ? `<div class="asklist">${needRows.map(line).join('')}</div>` : '<p class="small muted">Nothing here needs you: every open ask already has your call.</p>'}
      ${rest.length ? `<details class="block" style="margin-top:10px"><summary>Already has your call (${rest.length})</summary><div class="asklist">${rest.map(line).join('')}</div></details>` : ''}
      <p class="small" style="margin-top:10px"><a href="${planHref(p.dir).replace(/index\.html.*/, 'approvals.html')}" target="_blank" rel="noopener">Open the plan's approvals page</a></p></section>`;
  }).join('');
  app.innerHTML = `<section class="card" style="border-left:3px solid ${esc(goal.color)}"><h2><span class="chip" style="--c:${esc(goal.color)}">${esc(goal.label || goalId)}</span> asks <span class="sub">${need} need you, ${items.length} open</span></h2>
    <p class="lede">${need ? `${need} ${need === 1 ? 'ask needs' : 'asks need'} your call or a check now.` : 'Nothing needs your call right now.'}${items.length - need ? ` The other ${items.length - need} already have your call and wait on the builders.` : ''}</p>
    <p class="small"><a href="#overview">&larr; Back to Overview</a></p></section>
    ${projectHtml || `<section class="card"><p class="lede">No plans are mapped to ${esc(goal.label || goalId)} in goal-map.json yet, so there are no asks to group.</p></section>`}`;
}

function choiceLabel(choice) {
  return ({ fix: 'Fix next round', defer: 'Defer', will: 'I will do it', other: 'Other', yes: 'Yes', no: 'No' })[choice] || choice || 'not set';
}

async function renderWeek() {
  if (!state.overview) return;
  const w = await loadWeek();
  if (w.error) { renderError(w.error); return; }
  const ov = state.overview;
  const priorities = w.priorities || [];
  const news = w.news || { items: [], sources: [] };
  const srcs = (news.sources || []).map((s) => `<span class="src ${s.ok ? 'ok' : 'bad'}" title="${esc(s.error || s.url || '')}">${esc(s.name)}</span>`).join('');
  app.innerHTML = `<section class="card"><h2>This week <span class="sub">review ${esc(w.reviewDate || ov.freshness?.reviewFile || 'not dated')}</span></h2>
      <p class="lede">The latest review priorities, the source feed and the next steps. All of it stays in the goals folder as JSON.</p>
      <p class="small"><a href="#overview">&larr; Back to Overview</a> · <a href="#rules">Operating rules &rarr;</a></p></section>
    <section class="card"><h2>${priorities.length === 5 ? 'The five priorities from the weekly review' : `The ${priorities.length || 'current'} priorities from the weekly review`}</h2>
      ${priorities.length ? `<ol class="ladder">${priorities.map((p) => { const g = goalById(p.goal); return `<li style="--c:${esc(g?.color || 'var(--accent)')}"><span class="rk">${esc(p.rank ?? '')}</span><div class="lb">${g ? `<a class="chip" style="--c:${esc(g.color)}" href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a>` : `<span class="chip plain">${esc(p.goal || 'focus')}</span>`}<b>${esc(p.action || p.title)}</b>${p.next ? `<small>${esc(p.next)}</small>` : ''}${p.why ? `<small>${esc(p.why)}</small>` : ''}${p.metric ? `<small><b>Done when:</b> ${esc(p.metric)}</small>` : ''}</div><span class="who ${p.who === 'owner' ? 'owner' : ''}">${p.who === 'owner' ? 'You' : 'Agent'}</span></li>`; }).join('')}</ol>` : '<p class="lede">No priorities in the latest review.</p>'}</section>
    <section class="card"><h2>New in the source feeds <span class="sub">${esc(news.checkedAt ? new Date(news.checkedAt).toLocaleString() : 'not collected')}</span></h2>
      <div class="srcs">${srcs || '<span class="src">No sources configured</span>'}</div>
      ${news.note ? `<p class="small muted">${esc(news.note)}</p>` : ''}
      ${(news.items || []).length ? `<div class="news">${news.items.slice(0, 12).map((i) => `<div class="item"><a href="${esc(i.url || '#')}" target="_blank" rel="noopener">${esc(i.title)}</a><small>${esc(i.source || '')}${i.published ? ` · ${esc(dateOnly(i.published))}` : ''}</small><small>${esc(i.assessment || '')}${i.confidence ? ` · ${esc(i.confidence)}` : ''}</small><div class="goals">${(i.goals || []).map((id) => { const g = goalById(id); return g ? `<a class="chip" style="--c:${esc(g.color)}" href="#asks/${encodeURIComponent(g.id)}">${esc(g.label)}</a>` : `<span class="chip plain">${esc(id)}</span>`; }).join('')}</div></div>`).join('')}</div>` : '<p class="lede">No feed items collected yet.</p>'}</section>
    <section class="card"><h2>The next useful steps</h2>${(w.week || []).length ? `<ol>${w.week.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : '<p class="lede">No numbered next steps in the latest review markdown.</p>'}</section>
    <section class="card"><h2>What drifted this week</h2>${(w.drift || []).length ? `<ul class="notes">${w.drift.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="lede">No drift notes.</p>'}
      ${(w.gaps || []).length ? `<h3>Gaps in the evidence</h3><ul class="notes">${w.gaps.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${w.experiment ? `<p class="small"><b>Experiment:</b> ${esc(w.experiment)}</p>` : ''}</section>`;
}

async function renderRules() {
  if (!state.overview) return;
  const r = await loadRules();
  if (r.error) { renderError(r.error); return; }
  const files = r.files || [];
  app.innerHTML = `<section class="card"><h2>Rules <span class="sub">${files.length} note${files.length === 1 ? '' : 's'}</span></h2>
    <p class="lede">The operating rules and research policy from the goals knowledge folder. They are stored as Markdown outside this repo.</p>
    <p class="small"><a href="#overview">&larr; Back to Overview</a> · <a href="#week">This week &rarr;</a></p></section>
    ${files.length ? files.map((f, i) => `<section class="card"><h2>${esc(f.title)}</h2><div class="md">${md(f.text)}</div></section>`).join('')
      : '<section class="card"><p class="lede">No knowledge files yet. Add <code>knowledge/*.md</code> to your goals folder, or read SETUP.md.</p></section>'}`;
}

// Tiny Markdown renderer for the rules tab. Everything is escaped before simple formatting.
function md(source) {
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  const out = [];
  let list = null, para = [];
  const inline = (text) => esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map((x) => `<li>${inline(x)}</li>`).join('')}</ul>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length === 1 ? 3 : h[1].length + 1}>${inline(h[2])}</h${h[1].length === 1 ? 3 : h[1].length + 1}>`); continue; }
    const li = line.match(/^\s*[-*]\s+(.+)$/);
    if (li) { flushPara(); (list ||= []).push(li[1]); continue; }
    const ol = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (ol) { flushPara(); flushList(); out.push(`<p class="small"><b>${ol[1]}.</b> ${inline(ol[2])}</p>`); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

async function refreshNow() {
  if (state.busy) return;
  state.busy = true;
  const button = $('#refreshBtn');
  const original = button.textContent;
  button.disabled = true; button.textContent = 'Refreshing...';
  try {
    const response = await fetch(apiPath('refresh'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error?.message || result.error || `HTTP ${response.status}`);
    state.asks.clear(); state.week = null; state.rules = null;
    await loadOverview({ silent: true });
    renderAsksMenu();
    render();
    toast(`Refreshed: ${result.goals?.length ?? 0} goals.`);
  } catch (error) {
    if (error.detail) { state.error = error.detail; renderError(state.error); }
    toast(`Refresh failed: ${error.message}`, true);
  } finally {
    state.busy = false;
    button.disabled = false; button.textContent = original;
  }
}

async function postWeekly() {
  if (state.demo) { toast('Demo mode does not write to the SuperAgent inbox.', true); return; }
  const ov = state.overview;
  const gate = ov?.weekly?.gate || { ok: true, label: 'No usage data.' };
  if (!confirm(`Queue the weekly AI review for the SuperAgent?\n\nUsage gate: ${gate.label}`)) return;
  const button = $('#weeklyBtn');
  button.disabled = true;
  try {
    const response = await fetch(apiPath('weekly-review'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.queued) throw new Error(body.error?.message || body.error || 'not queued');
    toast('Weekly review queued for the SuperAgent.');
    await loadOverview({ silent: true });
    render();
  } catch (error) { toast(`Could not queue the review: ${error.message}`, true); }
  finally { button.disabled = false; updateWeeklyButton(); }
}

function updateWeeklyButton() {
  const button = $('#weeklyBtn');
  const weekly = state.overview?.weekly;
  if (state.demo) { button.disabled = true; button.textContent = 'Weekly review (demo)'; button.title = 'Demo mode does not queue a review.'; return; }
  if (weekly?.pending) { button.disabled = true; button.textContent = 'Weekly review queued'; button.title = `Queued ${ago(weekly.pending.at)} for the SuperAgent.`; return; }
  if (weekly?.gate && !weekly.gate.ok) { button.disabled = true; button.textContent = 'Run weekly AI review'; button.title = `Gate closed: ${weekly.gate.label}`; return; }
  button.disabled = false; button.textContent = 'Run weekly AI review'; button.title = `Queue the weekly AI review. Usage gate: ${weekly?.gate?.label || 'no usage data'}`;
}

function openHelp() {
  const dialog = $('#helpDlg');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  $('#helpClose')?.focus();
}
function closeHelp() { const dialog = $('#helpDlg'); if (dialog.open) dialog.close(); }

$('#refreshBtn').addEventListener('click', refreshNow);
$('#weeklyBtn').addEventListener('click', postWeekly);
$('#printBtn').addEventListener('click', () => window.print());
$('#helpBtn').addEventListener('click', openHelp);
$('#helpClose').addEventListener('click', closeHelp);
document.addEventListener('click', (event) => {
  if (!asksMenu.open) return;
  if (!event.target.closest('#asksMenu')) asksMenu.open = false;
});
asksMenu.addEventListener('toggle', () => {
  if (asksMenu.open) setActive('asks');
  else setActive(parseRoute().tab === 'asks' ? 'asks' : parseRoute().tab);
});
$('#helpClose')?.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeHelp(); });

// Expand every folded block for print, then restore the page.
let printOpen = [];
addEventListener('beforeprint', () => {
  printOpen = $$('details:not([open])');
  for (const d of printOpen) d.open = true;
});
addEventListener('afterprint', () => { for (const d of printOpen) d.open = false; printOpen = []; });

addEventListener('hashchange', () => { render(); });
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && asksMenu.open) { asksMenu.open = false; }
});

export async function reload() { await loadOverview({ silent: true }); renderAsksMenu(); render(); }

// Exposed for the Playwright checks; no private data is added here.
window.GoalsApp = { state, reload, openHelp, refreshNow };

(async () => {
  const ov = await loadOverview();
  renderAsksMenu();
  if (ov) { render(); updateWeeklyButton(); }
})();
