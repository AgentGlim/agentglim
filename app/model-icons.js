// Per-model icons for Claude and GPT (Codex) models, shared by the dashboard (index.html),
// the picker page (model-icons.html) and server.mjs. A classic script that sets globalThis.ModelIcons,
// so the browser loads it with <script src="/model-icons.js"> and Node with a side-effect import.
//
// Icons key off the model NAME, never the route: claude-opus-5-5 on the Claude sub, an API key or
// OpenRouter (anthropic/claude-opus-5.5) all get the same Opus icon. Other models (DeepSeek, Qwen,
// GLM...) are not handled here and keep their provider marks.
//
// Model -> tier: claude-opus-5-5 -> claude:opus, gpt-6.1-sol -> codex:sol, openai/gpt-6-luna ->
// codex:luna, gpt-7 (no tier word) -> codex:base, bare "sonnet" -> claude:sonnet.
//
// The owner picks a style (Logo, Logo + letter, Glyph, Badge, Soft tile, Letter) and a shape per tier on /model-icons; picks
// live in data/model-icons.json { picks, auto, seen }. Everything is designed for the dashboard's 16 px size.
//
// THE RULE (what happens when a model shows up):
//   1. Same tier, any version (claude-opus-6, gpt-6.2-sol): reuses that tier's icon. Nothing new is made.
//   2. A tier the owner never picked (a brand-new name like gpt-7-nova, or a known tier left unpicked):
//      style = the style the owner picked most often for that brand (tie: the earliest pick);
//      shape = the first free one (not used by another tier of that brand in that style) from the
//      model's personality set: known tiers have their own (SETS: Fable crowns and stars, Opus gears,
//      Sonnet balanced shapes, Haiku bolts, Sol suns, Terra worlds, Astra stars, Luna moons); a new tier's name picks a set
//      (personaOf: mini/flash/nano -> speed, pro/max/ultra -> power, code/dev -> worker, else balanced).
//      Logo style works the same way with LOGO_SETS (Fable blaze, Opus boxed, Sonnet six rays, Haiku
//      pinwheel, Sol sun core, Terra globe core, Astra star core, Luna half-lit orbits). Letter style uses the first free letter of the name.
//      server.mjs saves it under "auto" the first time the model is seen, so it stays stable.
//   3. If the owner's brand style changes later, unpicked "auto" tiers move to the new style.
//   4. Before the owner picks anything for a brand, that brand keeps its plain mark.
globalThis.ModelIcons = (() => {
  const BRAND = {
    claude: { color: '#d97757', label: 'Claude', soft: '#ffd2bf' },
    codex: { color: '#a78bfa', label: 'GPT (Codex)', soft: '#e2d8ff' },
  };
  // Known tiers, biggest first. ver/id are the current model, shown on the picker page.
  const KNOWN = {
    claude: [
      { tier: 'fable', name: 'Fable', id: 'claude-fable-5-1', ver: '5.1' },
      { tier: 'opus', name: 'Opus', id: 'claude-opus-5-5', ver: '5.5' },
      { tier: 'sonnet', name: 'Sonnet', id: 'claude-sonnet-5-5', ver: '5.5' },
      { tier: 'haiku', name: 'Haiku', id: 'claude-haiku-5-5', ver: '5.5' },
    ],
    codex: [
      { tier: 'astra', name: 'Astra', id: 'gpt-6.1-astra', ver: '6.1' },
      { tier: 'sol', name: 'Sol', id: 'gpt-6.1-sol', ver: '6.1' },
      { tier: 'terra', name: 'Terra', id: 'gpt-6.1-terra', ver: '6.1' },
      { tier: 'luna', name: 'Luna', id: 'gpt-6-luna', ver: '6' },
      { tier: 'base', name: 'GPT (no tier)', id: 'gpt-6.1', ver: '', hidden: true },
    ],
  };

  // ---- drawing ----
  // The dashboard shows these at 16 px, so every shape is drawn on a 16x16 pixel grid (1 unit = 1 screen
  // pixel) and scaled into the 24x24 viewBox. Tested at 1x and 2x: shapes with thin parts, small holes or
  // rays around a center (the old Core style) turned to noise at 16 px and were dropped.
  const f = (n) => +n.toFixed(2);
  const rays = (n, r1, r2) => Array.from({ length: n }, (_, i) => {
    const a = i * Math.PI * 2 / n;
    return `<line x1="${f(12 + r1 * Math.cos(a))}" y1="${f(12 + r1 * Math.sin(a))}" x2="${f(12 + r2 * Math.cos(a))}" y2="${f(12 + r2 * Math.sin(a))}"/>`;
  }).join('');
  const orbits = (n, rx, ry) => Array.from({ length: n }, (_, i) =>
    `<ellipse cx="12" cy="12" rx="${rx}" ry="${ry}" transform="rotate(${f(i * 180 / n)} 12 12)"/>`).join('');
  const claudeMark = (c, w = 2.6, n = 10, r1 = 2.5, r2 = 10.5) => `<g stroke="${c}" stroke-width="${w}" stroke-linecap="round">${rays(n, r1, r2)}</g>`;
  const codexMark = (c, w = 2, n = 3, rx = 9.5, ry = 4.5) => `<g fill="none" stroke="${c}" stroke-width="${w}">${orbits(n, rx, ry)}</g>`;
  const mark = (b, c) => b === 'claude' ? claudeMark(c) : codexMark(c);

  const DARK = '#0b0c0e'; // dashboard background
  const P = (pts) => `M${pts.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
  const starPts = (n, ro, ri, cx = 8, cy = 8) => Array.from({ length: n * 2 }, (_, i) => {
    const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? ri : ro; return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
  const ngonPts = (n, r) => Array.from({ length: n }, (_, i) => [8 + r * Math.cos(i * Math.PI * 2 / n), 8 + r * Math.sin(i * Math.PI * 2 / n)]);
  const gearPts = (teeth, ro, ri, tw) => Array.from({ length: teeth * 4 }, (_, i) => {
    const t = Math.floor(i / 4), k = i % 4, step = Math.PI * 2 / teeth, edge = k === 0 || k === 3;
    const a = -Math.PI / 2 + t * step + [-0.5, -tw / 2, tw / 2, 0.5][k] * step * (edge ? 0.62 : 1), r = edge ? ri : ro;
    return [8 + r * Math.cos(a), 8 + r * Math.sin(a)];
  });
  // crescent = circle (cx,cy,r) minus circle (ox,oy,r2), as one path
  function crescent(cx, cy, r, ox, oy, r2) {
    const dx = ox - cx, dy = oy - cy, d = Math.hypot(dx, dy), a = (r * r - r2 * r2 + d * d) / (2 * d), h = Math.sqrt(r * r - a * a);
    const mx = cx + a * dx / d, my = cy + a * dy / d, p1 = [f(mx + h * dy / d), f(my - h * dx / d)], p2 = [f(mx - h * dy / d), f(my + h * dx / d)];
    return `M${p1[0]} ${p1[1]}A${r} ${r} 0 1 0 ${p2[0]} ${p2[1]}A${r2} ${r2} 0 0 1 ${p1[0]} ${p1[1]}Z`;
  }
  const fill = (d, c) => `<path d="${d}" fill="${c}"/>`;
  const dot = (r, c) => `<circle cx="8" cy="8" r="${r}" fill="${c}"/>`;
  const ring = (r, c, w) => `<circle cx="8" cy="8" r="${r}" fill="none" stroke="${c}" stroke-width="${w}"/>`;
  const sunRays = (c) => `<g stroke="${c}" stroke-width="2" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => {
    const a = i * Math.PI / 4; return `<line x1="${f(8 + 5.8 * Math.cos(a))}" y1="${f(8 + 5.8 * Math.sin(a))}" x2="${f(8 + 7 * Math.cos(a))}" y2="${f(8 + 7 * Math.sin(a))}"/>`;
  }).join('')}</g>`;

  // Shapes, 16x16 grid. draw(c, bg): c = shape color, bg = color behind it (for punched holes).
  // tile: false = glyph only; inside a filled badge it read as a plain ring at 16 px.
  const SHAPES = {
    crown: { label: 'Crown', why: 'top of the line', draw: (c) => fill('M1 13.5V4L4.8 7.5L8 2L11.2 7.5L15 4V13.5Z', c) },
    star: { label: 'Star', why: 'the strongest', draw: (c) => fill(P(starPts(5, 7.6, 3.3, 8, 8.6)), c) },
    gem: { label: 'Gem', why: 'rare and precious', draw: (c, bg) => fill('M1 5.5L4.5 1.5H11.5L15 5.5L8 14.5Z', c) + `<path d="M1 6H15" stroke="${bg}" stroke-width="1.2"/>` },
    spark: { label: 'Spark', why: 'a flash of brilliance', draw: (c) => fill(P(starPts(4, 7.5, 2.4)), c) },
    gear: { label: 'Gear', why: 'always turning', draw: (c, bg) => fill(P(gearPts(6, 7.8, 5.4, 0.46)), c) + dot(2.1, bg) },
    nut: { label: 'Hex nut', why: 'holds the build together', tile: false, draw: (c, bg) => fill(P(ngonPts(6, 7.4)), c) + dot(2.6, bg) },
    shield: { label: 'Shield', why: 'reliable under load', tile: false, draw: (c) => fill('M8 1L14 3.3V8C14 11.6 11.5 14 8 15.2 4.5 14 2 11.6 2 8V3.3Z', c) },
    cube: { label: 'Block', why: 'builds things, block by block', draw: (c, bg) => fill('M8 1L14.5 4.5V11.5L8 15L1.5 11.5V4.5Z', c) + `<path d="M1.8 4.7L8 8.2L14.2 4.7M8 8.2V14.7" fill="none" stroke="${bg}" stroke-width="1.3" stroke-linejoin="round"/>` },
    half: { label: 'Balance', why: 'half and half', draw: (c) => ring(5.9, c, 2) + fill('M8 2.1A5.9 5.9 0 0 0 8 13.9Z', c) },
    diamond: { label: 'Diamond', why: 'balanced on a point', draw: (c) => fill('M8 1L15 8L8 15L1 8Z', c) },
    wave: { label: 'Wave', why: 'smooth rhythm, like a poem', draw: (c) => `<path d="M1.5 9C3.5 4 5.5 4 8 8S12.5 12 14.5 7" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round"/>` },
    target: { label: 'Target', why: 'steady aim', draw: (c) => ring(5.8, c, 2.4) + dot(2, c) },
    bolt: { label: 'Bolt', why: 'lightning fast', draw: (c) => fill('M10 .5L2 9.5H7L5.5 15.5L14 6.5H9Z', c) },
    ffwd: { label: 'Fast-forward', why: 'skips ahead', draw: (c) => fill('M1.5 3V13L8 8ZM8 3V13L14.5 8Z', c) },
    play: { label: 'Go', why: 'straight off the line', draw: (c) => fill('M3.5 2V14L14 8Z', c) + `<path d="M3.5 2V14L14 8Z" fill="none" stroke="${c}" stroke-linejoin="round"/>` },
    feather: { label: 'Feather', why: 'light and quick', draw: (c) => fill('M14.5 1.5C8 1.5 3 6 3 12.5L1.5 14.5L2.5 15L4 13C10 13 14.5 8 14.5 1.5Z', c) },
    sun: { label: 'Sun', why: 'the bright one', draw: (c) => dot(3.7, c) + sunRays(c) },
    disc: { label: 'Full sun', why: 'big and bright', draw: (c) => dot(6.5, c) },
    moon: { label: 'Crescent', why: 'the night shift', draw: (c) => fill(crescent(7.3, 8.3, 6.6, 11, 5.4, 5.3), c) },
    moonstar: { label: 'Moon + star', why: 'works the late hours', draw: (c) => fill(crescent(6.8, 9, 5.8, 10, 6.6, 4.6), c) + fill(P(starPts(4, 3.2, 1, 12.6, 3.6)), c) },
    globe: { label: 'Globe', why: 'the whole world, steady ground', tile: false, draw: (c) => ring(6.2, c, 1.5) + `<g fill="none" stroke="${c}" stroke-width="1.3"><ellipse cx="8" cy="8" rx="2.7" ry="6.2"/><path d="M1.8 8H14.2"/></g>` },
    mountain: { label: 'Mountain', why: 'solid ground to build on', draw: (c) => fill('M.8 13.5L6 4L9 9L11 6.5L15.2 13.5Z', c) },
    ringworld: { label: 'Ringed world', why: 'a planet on its own orbit', tile: false, draw: (c) => dot(4, c) + `<ellipse cx="8" cy="8" rx="7.2" ry="2.5" transform="rotate(-25 8 8)" fill="none" stroke="${c}" stroke-width="1.4"/>` },
    sprout: { label: 'Sprout', why: 'grows the work', draw: (c) => fill('M7.2 15V8.8C3.8 8.8 1.8 6.5 1.8 2.8C5.5 2.8 7.5 4.8 7.5 8.4C7.5 5 9.5 3 14 3C14 7 12 9.6 8.6 9.6V15Z', c) },
    constellation: { label: 'Constellation', why: 'connected points of light', tile: false, draw: (c) => `<path d="M2.8 12.2L6.6 5.2L13 9.2L11.4 2.6" fill="none" stroke="${c}" stroke-width="1.2" stroke-linejoin="round"/>` + [[2.8, 12.2, 1.9], [6.6, 5.2, 1.9], [13, 9.2, 2.1], [11.4, 2.6, 1.6]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join('') },
    octstar: { label: 'Eight-point star', why: 'a bright guiding star', draw: (c) => fill(P(starPts(8, 7.7, 3.1)), c) },
    starring: { label: 'Star in a ring', why: 'a star held in its orbit', tile: false, draw: (c) => ring(6.4, c, 1.4) + fill(P(starPts(5, 4.1, 1.8)), c) },
    cluster: { label: 'Star cluster', why: 'many stars, one verdict', draw: (c) => fill(P(starPts(4, 5, 1.5, 5, 10.2)), c) + fill(P(starPts(4, 3.4, 1, 12, 4)), c) + fill(P(starPts(4, 2.4, .8, 12.4, 12.6)), c) },
    halfmoon: { label: 'Half moon', why: 'half the price', draw: (c) => fill('M8 1.5A6.5 6.5 0 0 0 8 14.5Z', c) + ring(5.7, c, 1.6) },
  };
  const ALL_SHAPES = Object.keys(SHAPES);
  const TILE_SHAPES = ALL_SHAPES.filter((k) => SHAPES[k].tile !== false);
  // Shapes per known model, first = preset. Each fits the model's personality (PERSONA).
  const SETS = {
    'claude:fable': ['crown', 'star', 'gem', 'spark'],
    'claude:opus': ['gear', 'nut', 'shield', 'cube'],
    'claude:sonnet': ['half', 'diamond', 'wave', 'target'],
    'claude:haiku': ['bolt', 'ffwd', 'play', 'feather'],
    'codex:sol': ['sun', 'disc', 'spark', 'crown'],
    'codex:astra': ['constellation', 'octstar', 'starring', 'cluster'],
    'codex:terra': ['globe', 'mountain', 'ringworld', 'sprout'],
    'codex:luna': ['moon', 'moonstar', 'halfmoon', 'feather'],
    'codex:base': ['diamond', 'half', 'target', 'disc'],
  };
  const PERSONA = {
    'claude:fable': 'The strongest: a blazing sun, a crown, big stars.',
    'claude:opus': 'The hardest worker: short, heavy rays round an open center.',
    'claude:sonnet': 'The balanced all-rounder: six even rays.',
    'claude:haiku': 'The fastest: a spinning pinwheel.',
    'codex:sol': 'GPT\'s big model, the sun.',
    'codex:astra': 'GPT\'s premium checker, the star that guides the rest.',
    'codex:terra': 'GPT\'s steady mid-tier worker, the earth.',
    'codex:luna': 'GPT\'s quick, cheap worker, the moon.',
  };
  // a new tier's personality from its name, so gpt-7-mini gets speed shapes and claude-titan gets power ones
  const PERSONA_RX = [
    ['power', /pro|max|ultra|heavy|large|prime|titan|mythos|giga|grand|fable|opus|sol|astra|star/],
    ['speed', /mini|nano|flash|lite|fast|turbo|swift|small|instant|quick|haiku|luna|spark/],
    ['worker', /code|dev|work|engineer|build|forge|terra|earth/],
  ];
  const PERSONA_POOL = {
    claude: { power: ['claude:fable', 'claude:opus'], speed: ['claude:haiku'], worker: ['claude:opus'], balanced: ['claude:sonnet'] },
    codex: { power: ['codex:sol', 'codex:astra', 'claude:fable'], speed: ['codex:luna', 'claude:haiku'], worker: ['codex:terra', 'claude:opus'], balanced: ['codex:base', 'claude:sonnet'] },
  };
  const personaOf = (tier) => (PERSONA_RX.find(([, rx]) => rx.test(tier)) || ['balanced'])[0];

  // ---- Logo style: the brand mark itself, changed per model (24x24, same coordinates as the plain mark) ----
  // Kept only variants that still read as different marks at 16 px; ray-count and stroke-weight changes
  // all looked like the same asterisk at that size and were dropped.
  const pt = (a, r) => [f(12 + r * Math.cos(a)), f(12 + r * Math.sin(a))];
  const seg = (a, r1, r2) => { const [x1, y1] = pt(a, r1), [x2, y2] = pt(a, r2); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; };
  const ang = (n, off = 0) => Array.from({ length: n }, (_, i) => off + i * Math.PI * 2 / n);
  const strokes = (c, w, inner, cap = 'round') => `<g stroke="${c}" stroke-width="${w}" stroke-linecap="${cap}" fill="none">${inner}</g>`;
  const UP = -Math.PI / 2;
  const ell = (rx, ry, rot) => `<ellipse cx="12" cy="12" rx="${rx}" ry="${ry}" transform="rotate(${rot} 12 12)"/>`;
  const orb = (c, w, rx, ry, rots = [0, 60, 120]) => `<g fill="none" stroke="${c}" stroke-width="${w}">${rots.map((r) => ell(rx, ry, r)).join('')}</g>`;
  const core = (r, c, gap = 1.2, cx = 12, cy = 12) => `<circle cx="${cx}" cy="${cy}" r="${r + gap}" fill="${DARK}"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}"/>`;
  const curve = (c, w, n, bend, sweep) => strokes(c, w, ang(n).map((a) => {
    const [x1, y1] = pt(a, 2.3), [qx, qy] = pt(a + bend, 7.5), [x2, y2] = pt(a + sweep, 10.6); return `<path d="M${x1} ${y1}Q${qx} ${qy} ${x2} ${y2}"/>`;
  }).join(''));
  const star24 = (n, ro, ri, off = UP) => `M${Array.from({ length: n * 2 }, (_, i) => pt(off + i * Math.PI / n, i % 2 ? ri : ro).join(' ')).join('L')}Z`;
  const LOGOS = {
    claude: {
      blaze: { label: 'Blaze', why: 'a solid spiky sun', draw: (c) => `<path d="${star24(10, 11.2, 5.4)}" fill="${c}" stroke="${c}" stroke-width="1" stroke-linejoin="round"/>` },
      sparkle: { label: 'Sparkle', why: 'four big points, the star of the line', draw: (c) => `<path d="${star24(4, 11.6, 3.6)}" fill="${c}" stroke="${c}" stroke-width=".8" stroke-linejoin="round"/>` },
      crownrays: { label: 'Crown', why: 'rays fanned up like a crown', draw: (c) => strokes(c, 2.6, [-150, -120, -90, -60, -30].map((d) => { const a = d * Math.PI / 180; return `<line x1="12" y1="16" x2="${f(12 + (d === -90 ? 13 : 10.5) * Math.cos(a))}" y2="${f(16 + (d === -90 ? 13 : 10.5) * Math.sin(a))}"/>`; }).join('')) + `<rect x="3.5" y="17.6" width="17" height="3.2" rx="1.6" fill="${c}"/>` },
      star5: { label: 'Five', why: 'five heavy points', draw: (c) => strokes(c, 3.6, ang(5, UP).map((a) => seg(a, 2.2, 11)).join('')) },
      double: { label: 'Double', why: 'two rings of rays', draw: (c) => strokes(c, 2.4, ang(10).map((a) => seg(a, 6.4, 11.2)).join('')) + strokes(c, 2, ang(10, Math.PI / 10).map((a) => seg(a, 1.6, 4.6)).join('')) },
      boxed: { label: 'Boxed', why: 'rays packed in a crate', draw: (c) => `<rect x="2.2" y="2.2" width="19.6" height="19.6" rx="4.5" fill="none" stroke="${c}" stroke-width="2.4"/>` + strokes(c, 2.3, ang(8).map((a) => seg(a, 1.8, 5.8)).join('')) },
      nutrays: { label: 'Nut', why: 'rays held in a hex nut', draw: (c) => `<path d="${star24(3, 10.8, 10.8 * Math.cos(Math.PI / 6) * 1.155, -Math.PI / 2 + Math.PI / 6)}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/>` + strokes(c, 2.3, ang(6, UP).map((a) => seg(a, 1.8, 5.6)).join('')) },
      plus: { label: 'Plus', why: 'four thick rays, no frills', draw: (c) => strokes(c, 4.2, ang(4, UP).map((a) => seg(a, 3, 10.4)).join('')) },
      shift: { label: 'Shift', why: 'rays rising over the workbench', draw: (c) => strokes(c, 2.6, [-180, -150, -120, -90, -60, -30, 0].map((d) => { const a = d * Math.PI / 180; return `<line x1="${f(12 + 4 * Math.cos(a))}" y1="${f(15 + 4 * Math.sin(a))}" x2="${f(12 + 10.4 * Math.cos(a))}" y2="${f(15 + 10.4 * Math.sin(a))}"/>`; }).join('')) + `<rect x="1.5" y="18.4" width="21" height="3.2" rx="1.6" fill="${c}"/>` },
      washer: { label: 'Washer', why: 'short heavy rays round an open center', draw: (c) => strokes(c, 3.6, ang(8, Math.PI / 8).map((a) => seg(a, 5.4, 10.6)).join(''), 'butt') },
      washer10: { label: 'Ten heavy', why: 'the brand\'s ten rays, short and heavy', draw: (c) => strokes(c, 3, ang(10).map((a) => seg(a, 5.4, 10.6)).join('')) },
      washerRound: { label: 'Rounded', why: 'eight thick rays, soft ends', draw: (c) => strokes(c, 3.9, ang(8, Math.PI / 8).map((a) => seg(a, 5.8, 10)).join('')) },
      hub: { label: 'Hub', why: 'heavy rays round a solid hub', draw: (c) => strokes(c, 3.4, ang(8, Math.PI / 8).map((a) => seg(a, 6.6, 10.8)).join(''), 'butt') + `<circle cx="12" cy="12" r="3" fill="${c}"/>` },
      wedges: { label: 'Wedges', why: 'rays that thicken outward, like pistons', draw: (c) => ang(8, Math.PI / 8).map((a) => { const w1 = 0.2, w2 = 0.3, p = [pt(a - w1, 5.6), pt(a + w1, 5.6), pt(a + w2 * 0.62, 10.8), pt(a - w2 * 0.62, 10.8)]; return `<path d="M${p.map((q) => q.join(' ')).join('L')}Z" fill="${c}" stroke="${c}" stroke-width=".6" stroke-linejoin="round"/>`; }).join('') },
      heavy12: { label: 'Twelve', why: 'twelve stubby rays, never stops', draw: (c) => strokes(c, 2.6, ang(12).map((a) => seg(a, 6.2, 10.8)).join(''), 'butt') },
      sun: { label: 'Sun', why: 'radiates power', draw: (c) => strokes(c, 2.4, ang(10).map((a) => seg(a, 7.6, 11)).join('')) + `<circle cx="12" cy="12" r="5.2" fill="${c}"/>` },
      star: { label: 'Star', why: 'six long points', draw: (c) => strokes(c, 2.8, ang(12, UP).map((a, i) => seg(a, 2.2, i % 2 ? 6 : 11)).join('')) },
      burst: { label: 'Burst', why: 'more rays, more power', draw: (c) => strokes(c, 1.8, ang(16).map((a) => seg(a, 3.4, 10.9)).join('')) },
      spikes: { label: 'Spikes', why: 'long and short rays', draw: (c) => strokes(c, 2.6, ang(10, UP).map((a, i) => seg(a, 2.2, i % 2 ? 6.4 : 11)).join('')) },
      gear: { label: 'Gear', why: 'rays turned into teeth', draw: (c) => strokes(c, 3.4, ang(8, Math.PI / 8).map((a) => seg(a, 7.4, 10.6)).join(''), 'butt') + `<circle cx="12" cy="12" r="5.6" fill="none" stroke="${c}" stroke-width="2.6"/>` },
      cog: { label: 'Cog', why: 'ten teeth, never stops', draw: (c) => strokes(c, 3, ang(10).map((a) => seg(a, 7.6, 10.8)).join(''), 'butt') + `<circle cx="12" cy="12" r="5.8" fill="none" stroke="${c}" stroke-width="2.8"/>` },
      bold6: { label: 'Bold six', why: 'heavy rays, built strong', draw: (c) => strokes(c, 3.8, ang(6, UP).map((a) => seg(a, 3, 10.2)).join('')) },
      heavy: { label: 'Heavy', why: 'thick rays', draw: (c) => strokes(c, 3.8, ang(8).map((a) => seg(a, 3.6, 10)).join('')) },
      six: { label: 'Six', why: 'six even rays', draw: (c) => strokes(c, 2.8, ang(6, UP).map((a) => seg(a, 2.5, 10.5)).join('')) },
      rhythm: { label: 'Rhythm', why: 'ray, dot, ray: a poem\'s beat', draw: (c) => strokes(c, 2.6, ang(10).map((a, i) => i % 2 ? '' : seg(a, 2.5, 10.5)).join('')) + ang(10).map((a, i) => i % 2 ? `<circle cx="${pt(a, 9.3)[0]}" cy="${pt(a, 9.3)[1]}" r="1.7" fill="${c}"/>` : '').join('') },
      compass: { label: 'Compass', why: 'four points in balance', draw: (c) => strokes(c, 3, ang(4, UP).map((a) => seg(a, 2.5, 10.8)).join('')) + strokes(c, 2.4, ang(4, UP + Math.PI / 4).map((a) => seg(a, 4.2, 7.2)).join('')) },
      ring: { label: 'Ring', why: 'rays around a steady core', draw: (c) => strokes(c, 2.4, ang(10).map((a) => seg(a, 6.2, 10.6)).join('')) + `<circle cx="12" cy="12" r="2.6" fill="${c}"/>` },
      pinwheel: { label: 'Pinwheel', why: 'spinning fast', draw: (c) => curve(c, 2.4, 8, 0.25, 0.75) },
      spin: { label: 'Spin', why: 'six curved arms', draw: (c) => curve(c, 2.8, 6, 0.2, 0.85) },
      lean: { label: 'Lean', why: 'leaning forward', draw: (c) => `<g transform="translate(12 12) skewX(-22) translate(-12 -12)">${strokes(c, 2.6, ang(10).map((a) => seg(a, 2.5, 10)).join(''))}</g>` },
      swept: { label: 'Swept', why: 'rays blown back', draw: (c) => strokes(c, 2.6, ang(8).map((a) => { const [x1, y1] = pt(a, 3), [x2, y2] = pt(a + 0.8, 10.8); return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`; }).join('')) },
    },
    codex: {
      halflit: { label: 'Half lit', why: 'orbits lit on one side, like a half moon', draw: (c) => orb(c, 2, 9.5, 4.5) + `<rect x="12" y="0" width="12" height="24" fill="${DARK}" opacity=".62"/>` },
      moonwrap: { label: 'Moon wrap', why: 'a crescent hugging the orbits', draw: (c) => orb(c, 1.7, 7, 3) + `<path d="M15.5 2.4A10 10 0 1 0 15.5 21.6" fill="none" stroke="${c}" stroke-width="2.6" stroke-linecap="round"/>` },
      oneorbit: { label: 'One orbit', why: 'the light, cheap version', draw: (c) => orb(c, 2.3, 10.4, 4, [-30]) + `<circle cx="12" cy="12" r="3.2" fill="${c}"/>` },
      night: { label: 'Night', why: 'orbits with a star overhead', draw: (c) => orb(c, 1.7, 8.2, 3.6, [0, 60, 120]).replace(/cx="12" cy="12"/g, 'cx="10" cy="13"').replace(/12 12\)/g, '10 13)') + `<path d="${star24(4, 4.6, 1.3).replace(/([\d.]+) ([\d.]+)/g, (m, x, y) => `${f(+x + 7.4)} ${f(+y - 7)}`)}" fill="${c}"/>` },
      bigmoon: { label: 'Moon', why: 'a big crescent across the orbits', draw: (c) => orb(c, 1.7, 9.4, 4) + `<circle cx="12" cy="12" r="7.2" fill="${DARK}"/><path d="M15.8 6.2A6.4 6.4 0 1 0 15.8 17.8A5.2 5.2 0 0 1 15.8 6.2Z" fill="${c}"/>` },
      globecore: { label: 'Globe', why: 'a globe inside the orbits', draw: (c) => orb(c, 1.8, 10.4, 4) + core(5.2, c) + `<path d="M6.8 12H17.2" stroke="${DARK}" stroke-width="1.3"/><ellipse cx="12" cy="12" rx="2.2" ry="5.2" fill="none" stroke="${DARK}" stroke-width="1.2"/>` },
      peaks: { label: 'Peaks', why: 'mountains rising inside the orbits', draw: (c) => orb(c, 1.7, 10.4, 4.4) + `<path d="M4.6 17.4L10 8L13 13L15 10.4L19.4 17.4Z" fill="${c}" stroke="${DARK}" stroke-width="1.6" stroke-linejoin="round"/>` },
      worldring: { label: 'Ringed world', why: 'one tilted ring round a solid world', draw: (c) => `<g transform="rotate(-28 12 12)"><circle cx="12" cy="12" r="5.6" fill="${c}"/><ellipse cx="12" cy="12" rx="10.6" ry="3.4" fill="none" stroke="${DARK}" stroke-width="4.4"/><ellipse cx="12" cy="12" rx="10.6" ry="3.4" fill="none" stroke="${c}" stroke-width="1.8"/><path d="M6.6 11.5A5.6 5.6 0 0 1 17.4 11.5" fill="${c}" stroke="${c}" stroke-width="1"/></g>` },
      crossorbit: { label: 'Cross orbits', why: 'two crossed orbits round the ground', draw: (c) => orb(c, 2.1, 10.2, 4.2, [0, 90]) + core(3.8, c) },
      starcore: { label: 'Star core', why: 'a bright star inside the orbits', draw: (c) => orb(c, 1.6, 10.4, 4) + `<circle cx="12" cy="12" r="7" fill="${DARK}"/><path d="${star24(5, 6.4, 2.6)}" fill="${c}" stroke="${c}" stroke-width=".8" stroke-linejoin="round"/>` },
      northstar: { label: 'North star', why: 'one long four-point star', draw: (c) => orb(c, 1.2, 10, 3.2, [45, 135]) + `<path d="${star24(4, 11.6, 2.6)}" fill="${c}" stroke="${DARK}" stroke-width="1.2" stroke-linejoin="round"/>` },
      constellation: { label: 'Constellation', why: 'three points joined by orbits', draw: (c) => `<path d="M4.5 17L10 6.5L19.5 13.5" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round"/>` + [[4.5, 17, 3.2], [10, 6.5, 3.6], [19.5, 13.5, 3.2], [17, 3.8, 1.8]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${c}"/>`).join('') },
      astrahalo: { label: 'Star halo', why: 'a ring of light round a star', draw: (c) => `<circle cx="12" cy="12" r="10.2" fill="none" stroke="${c}" stroke-width="1.8"/>` + orb(c, 1.4, 7.4, 3, [30, 150]) + `<path d="${star24(4, 5.4, 1.8)}" fill="${c}"/>` },
      sun: { label: 'Sun core', why: 'a sun inside the orbits', draw: (c) => orb(c, 1.9, 10.4, 4) + core(4.2, c) },
      corona: { label: 'Corona', why: 'orbits with sun rays', draw: (c) => orb(c, 1.8, 8.2, 3.7) + strokes(c, 2.2, ang(6, Math.PI / 6).map((a) => seg(a, 9.4, 11.2)).join('')) + `<circle cx="12" cy="12" r="2.4" fill="${c}"/>` },
      halo: { label: 'Halo', why: 'a ring around the orbits', draw: (c) => `<g fill="none" stroke="${c}" stroke-width="1.8">${[0, 60, 120].map((r) => ell(7.6, 3.4, r)).join('')}<circle cx="12" cy="12" r="10.6"/></g>` },
      bold: { label: 'Bold', why: 'thicker orbits', draw: (c) => orb(c, 2.8, 9.6, 5) },
      moon: { label: 'Moon', why: 'a moon on its orbit', draw: (c) => orb(c, 1.8, 8.6, 4) + core(3.2, c, 1.2, 19.2, 5.6) },
      two: { label: 'Two orbits', why: 'lighter and simpler', draw: (c) => orb(c, 2.3, 10, 4.3, [45, 135]) + `<circle cx="12" cy="12" r="2.6" fill="${c}"/>` },
      crescent: { label: 'Moon core', why: 'a crescent inside', draw: (c) => orb(c, 1.9, 10.4, 4) + core(4.4, c) + `<circle cx="14.2" cy="10.2" r="3.6" fill="${DARK}"/>` },
      planet: { label: 'Planet', why: 'one orbit, one world', draw: (c) => `<g transform="rotate(-25 12 12)" fill="none" stroke-linecap="round"><path d="M1 12A11 3.4 0 0 1 23 12" stroke="${c}" stroke-width="2"/><circle cx="12" cy="12" r="5.4" fill="${c}" stroke="${DARK}" stroke-width="1.4"/><path d="M1 12A11 3.4 0 0 0 23 12" stroke="${DARK}" stroke-width="4"/><path d="M1 12A11 3.4 0 0 0 23 12" stroke="${c}" stroke-width="2"/></g>` },
      four: { label: 'Four orbits', why: 'one more orbit', draw: (c) => orb(c, 1.7, 9.8, 4, [0, 45, 90, 135]) },
      thin: { label: 'Fine', why: 'fine lines', draw: (c) => orb(c, 1.3, 9.8, 4.4) },
    },
  };
  const LOGO_SETS = {
    'claude:fable': ['blaze', 'crownrays', 'sparkle', 'star5'],
    'claude:opus': ['washer10', 'washerRound', 'hub', 'wedges', 'heavy12', 'washer'],
    'claude:sonnet': ['six'],
    'claude:haiku': ['pinwheel'],
    'codex:sol': ['sun'],
    'codex:astra': ['starcore', 'northstar', 'constellation', 'astrahalo'],
    'codex:terra': ['globecore', 'peaks', 'worldring', 'crossorbit'],
    'codex:luna': ['halflit', 'moonwrap', 'bigmoon', 'oneorbit'],
    'codex:base': ['halo', 'four', 'thin', 'bold'],
  };
  const LOGO_POOL = {
    claude: { power: ['claude:fable', 'claude:opus'], speed: ['claude:haiku'], worker: ['claude:opus'], balanced: ['claude:sonnet'] },
    codex: { power: ['codex:sol', 'codex:astra'], speed: ['codex:luna'], worker: ['codex:terra', 'codex:base'], balanced: ['codex:base'] },
  };
  const SHAPE_STYLES = new Set(['glyph', 'badge', 'soft']);
  // the shapes a tier can use in a style, best first (badge and soft skip the glyph-only shapes)
  function shapeSet(brand, tier, style = 'glyph') {
    if (style === 'logo') return LOGO_SETS[`${brand}:${tier}`] || [...new Set(LOGO_POOL[brand][personaOf(tier)].flatMap((k) => LOGO_SETS[k]))];
    const base = SETS[`${brand}:${tier}`] || [...new Set(PERSONA_POOL[brand][personaOf(tier)].flatMap((k) => SETS[k]))];
    return style === 'glyph' ? base : base.filter((k) => SHAPES[k].tile !== false);
  }

  const TILE = { claude: (c) => `<circle cx="8" cy="8" r="8" fill="${c}"/>`, codex: (c) => `<rect width="16" height="16" rx="4" fill="${c}"/>` };
  const SOFT = { claude: { tile: '#492c24', ink: '#f4a98c' }, codex: { tile: '#3a3255', ink: '#cbbcff' } };
  const AZ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const letterText = (v, c, size, y) => `<text x="12" y="${y}" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-weight="800" font-size="${size}" fill="${c}">${String(v).slice(0, 1)}</text>`;
  const LETTER_STYLES = new Set(['letter', 'mono', 'monoLight']);
  const g16 = (body) => `<g transform="scale(1.5)">${body}</g>`;
  const fit = (body, s) => `<g transform="translate(8 8) scale(${s}) translate(-8 -8)">${body}</g>`;
  const shape = (v) => SHAPES[v] || SHAPES.diamond;
  // Each style: label, blurb, the variation list per brand, draw(brand, v), text(v) for the variation.
  const STYLES = {
    logo: {
      label: 'Logo', blurb: 'The brand mark itself, changed to fit the model.',
      opts: { claude: Object.keys(LOGOS.claude), codex: Object.keys(LOGOS.codex) },
      draw: (b, v, color) => (LOGOS[b][v] || Object.values(LOGOS[b])[0]).draw(color || BRAND[b].color),
      text: (v, b) => (LOGOS[b]?.[v] || {}).label || v,
    },
    mono: {
      label: 'Logo + letter', blurb: 'The brand mark around a solid core with the model\'s first letter.',
      opts: { claude: AZ, codex: AZ },
      draw: (b, v) => (b === 'claude' ? claudeMark(BRAND.claude.color, 2.1, 12, 9.2, 11.4) + `<circle cx="12" cy="12" r="7.6" fill="${BRAND.claude.color}"/>`
        : codexMark(BRAND.codex.color, 1.8, 3, 11, 3.4) + `<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="4" fill="${BRAND.codex.color}" stroke="${DARK}" stroke-width="1.2"/>`)
        + letterText(v, DARK, 14, 16.9),
      text: (v) => `"${v}"`,
    },
    monoLight: {
      label: 'Logo + light letter', blurb: 'Shorter rays or tighter orbits around a light letter.',
      opts: { claude: AZ, codex: AZ },
      draw: (b, v) => (b === 'claude' ? claudeMark(BRAND.claude.color, 2.6, 10, 7.4, 11.2) : codexMark(BRAND.codex.color, 1.9, 3, 10.8, 3.4) + `<circle cx="12" cy="12" r="6.9" fill="${DARK}"/>`)
        + letterText(v, BRAND[b].soft, 14, 17),
      text: (v) => `"${v}"`,
    },
    glyph: {
      label: 'Glyph', blurb: 'Just the shape, in the brand color. The clearest at 16 px.',
      opts: { claude: ALL_SHAPES, codex: ALL_SHAPES },
      draw: (b, v) => g16(shape(v).draw(BRAND[b].color, DARK)),
      text: (v) => shape(v).label,
    },
    badge: {
      label: 'Badge', blurb: 'A dark shape cut out of a solid brand badge: a circle for Claude, a rounded square for GPT.',
      opts: { claude: TILE_SHAPES, codex: TILE_SHAPES },
      draw: (b, v) => g16(TILE[b](BRAND[b].color) + fit(shape(v).draw(DARK, BRAND[b].color), 0.78)),
      text: (v) => shape(v).label,
    },
    soft: {
      label: 'Soft tile', blurb: 'A light shape on a dim brand tile. Calmer than the badge.',
      opts: { claude: TILE_SHAPES, codex: TILE_SHAPES },
      draw: (b, v) => g16(TILE[b](SOFT[b].tile) + fit(shape(v).draw(SOFT[b].ink, SOFT[b].tile), 0.76)),
      text: (v) => shape(v).label,
    },
    letter: {
      label: 'Letter', blurb: 'The model\'s first letter on a brand badge.',
      opts: { claude: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), codex: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('') },
      draw: (b, v) => g16(TILE[b](BRAND[b].color)) + `<text x="12" y="17.6" text-anchor="middle" font-family="system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" font-weight="800" font-size="16" fill="${DARK}">${String(v).slice(0, 1)}</text>`,
      text: (v) => `"${v}"`,
    },
  };
  const STYLE_KEYS = Object.keys(STYLES);
  // color: optional override (the dashboard draws manual sessions in its manual blue); only Logo and plain use it
  const plain = (b, color) => mark(b, color || BRAND[b].color);
  function draw(brand, style, v, color) {
    const s = STYLES[style];
    return s && v != null ? s.draw(brand, v, color) : plain(brand, color);
  }

  // ---- model name -> brand + tier ----
  const CLAUDE_TIERS = new Set(KNOWN.claude.map((k) => k.tier));
  const SKIP = new Set(['latest', 'preview', 'chat', 'codex', 'claude', 'thinking', 'exp', 'beta']);
  function parse(id) {
    if (!id || typeof id !== 'string') return null;
    let s = id.toLowerCase().trim().replace(/\[[^\]]*\]$/, '');
    s = s.slice(s.lastIndexOf('/') + 1).replace(/^.*?(?=claude[-_.])/, '').replace(/[-_]\d{8}$/, '');
    let brand = null, tier = null, ver = '';
    if (/^claude[-_.]/.test(s)) {
      brand = 'claude';
      const t = s.split(/[-_.]/).slice(1);
      tier = t.find((x) => /^[a-z]+$/.test(x) && !SKIP.has(x)) || 'base';
      ver = t.filter((x) => /^\d+$/.test(x)).join('.');
    } else if (CLAUDE_TIERS.has(s.split(/[-_.\s]/)[0])) {
      brand = 'claude'; tier = s.split(/[-_.\s]/)[0];
    } else {
      const m = s.match(/(?:^|[^a-z])gpt-?(\d+(?:\.\d+)?)(.*)$/);
      if (m) {
        brand = 'codex'; ver = m[1];
        tier = m[2].split(/[-_.]/).filter((x) => /^[a-z]+$/.test(x) && !SKIP.has(x)).join('-') || 'base';
      } else if (/^(sol|astra|terra|luna)$/.test(s)) { brand = 'codex'; tier = s; }
      else if (/^o\d+(-[a-z]+)?$/.test(s)) { brand = 'codex'; tier = s; }
    }
    if (!brand) return null;
    tier = tier.slice(0, 30);
    return { brand, tier, key: `${brand}:${tier}`, ver, id };
  }
  const nameOf = (brand, tier) => (KNOWN[brand].find((k) => k.tier === tier) || {}).name
    || tier.replace(/(^|-)([a-z])/g, (_, a, c) => (a ? ' ' : '') + c.toUpperCase());

  // ---- the rule ----
  const emptyStore = () => ({ version: 1, picks: {}, auto: {}, seen: {} });
  const norm = (s) => Object.assign(emptyStore(), s || {});
  const inBrand = (key, brand) => key.startsWith(`${brand}:`);
  // the style the owner picked most for this brand; tie: earliest pick
  function brandStyle(brand, store) {
    const n = {}, first = {};
    for (const [k, e] of Object.entries(norm(store).picks)) {
      if (!inBrand(k, brand) || !STYLES[e.style]) continue;
      n[e.style] = (n[e.style] || 0) + 1;
      first[e.style] = Math.min(first[e.style] ?? Infinity, Date.parse(e.at) || 0);
    }
    const ks = Object.keys(n).sort((a, b) => n[b] - n[a] || first[a] - first[b]);
    return ks[0] || null;
  }
  // variations already taken in this brand + style (picks first, then auto), except one tier
  function usedVals(brand, style, store, except) {
    const st = norm(store), out = new Set();
    for (const src of [st.picks, st.auto]) for (const [k, e] of Object.entries(src))
      if (k !== except && inBrand(k, brand) && e.style === style && !(src === st.auto && st.picks[k])) out.add(String(e.v));
    // known tiers with no saved entry keep their preset free, so a new tier never copies Fable or Luna
    KNOWN[brand].forEach((k) => {
      const key = `${brand}:${k.tier}`;
      if (key === except || st.picks[key] || st.auto[key] || k.hidden) return;
      out.add(String(LETTER_STYLES.has(style) ? k.name[0].toUpperCase() : shapeSet(brand, k.tier, style)[0]));
    });
    return out;
  }
  function paramFor(brand, tier, style, used = new Set()) {
    const opts = STYLES[style].opts[brand];
    if (LETTER_STYLES.has(style)) {
      const letters = (nameOf(brand, tier).replace(/[^a-z]/gi, '') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ').toUpperCase();
      return [...letters].find((c) => !used.has(c)) || letters[0];
    }
    const set = shapeSet(brand, tier, style);
    return set.find((o) => !used.has(o)) ?? opts.find((o) => !used.has(o)) ?? set[0];
  }
  // the entry the dashboard draws for a tier: owner pick > saved auto > the rule, computed live
  function resolveKey(key, store) {
    const st = norm(store);
    if (st.picks[key]) return { ...st.picks[key], from: 'pick' };
    if (st.auto[key]) return { ...st.auto[key], from: 'auto' };
    const [brand, tier] = key.split(':');
    const style = brandStyle(brand, st);
    if (!style) return { style: 'plain', v: null, from: 'plain' };
    return { style, v: paramFor(brand, tier, style, usedVals(brand, style, st, key)), from: 'rule' };
  }
  const resolve = (id, store) => { const p = parse(id); return p ? { ...p, ...resolveKey(p.key, store) } : null; };
  function svgKey(key, store, color) { const e = resolveKey(key, store); return draw(key.split(':')[0], e.style, e.v, color); }
  const svg = (id, store, color) => { const p = parse(id); return p ? svgKey(p.key, store, color) : null; };

  // re-run the rule for unpicked auto tiers of a brand (after a pick changed the brand style)
  function reflow(brand, st) {
    const style = brandStyle(brand, st);
    for (const k of Object.keys(st.auto)) {
      if (!inBrand(k, brand)) continue;
      if (st.picks[k] || !style) { delete st.auto[k]; continue; }
      const e = st.auto[k];
      const tier = k.slice(brand.length + 1);
      const inSet = !KNOWN[brand].some((x) => x.tier === tier) || style === 'letter' || LETTER_STYLES.has(style) || shapeSet(brand, tier, style).includes(e.v);
      if (e.style === style && inSet && !usedVals(brand, style, { ...st, auto: {} }, k).has(String(e.v))) continue;
      st.auto[k] = { ...e, style, v: paramFor(brand, tier, style, usedVals(brand, style, st, k)), at: new Date().toISOString() };
    }
  }
  // owner picks a style for a tier (null style = clear the pick); v picks one variation (e.g. a Core shape)
  function pick(store, key, style, v) {
    const st = norm(store), [brand, tier] = key.split(':');
    if (!BRAND[brand] || !tier) throw new Error('bad tier key');
    if (style == null) delete st.picks[key];
    else if (style === 'plain') st.picks[key] = { style: 'plain', v: null, at: new Date().toISOString() };
    else {
      if (!STYLES[style]) throw new Error('unknown style');
      if (v != null && !STYLES[style].opts[brand].map(String).includes(String(v))) throw new Error('unknown variation');
      if (v == null) v = paramFor(brand, tier, style, usedVals(brand, style, { ...st, auto: {} }, key));
      st.picks[key] = { style, v, at: st.picks[key]?.style === style ? st.picks[key].at : new Date().toISOString() };
    }
    delete st.auto[key];
    reflow(brand, st);
    return st;
  }
  // server: note every model id the run used; save a rule icon the first time a tier shows up
  function register(ids, store) {
    const st = norm(store); let changed = false;
    for (const id of ids) {
      const p = parse(id); if (!p) continue;
      const seen = st.seen[p.key] ||= [];
      if (!seen.includes(id) && seen.length < 12) { seen.push(id); changed = true; }
      if (st.picks[p.key] || st.auto[p.key]) continue;
      const style = brandStyle(p.brand, st);
      if (!style) continue;
      st.auto[p.key] = { style, v: paramFor(p.brand, p.tier, style, usedVals(p.brand, style, st, p.key)), at: new Date().toISOString(), firstId: id };
      changed = true;
    }
    return { store: st, changed };
  }
  // every tier worth showing on the picker page: known ones plus any seen or saved
  function tiers(store) {
    const st = norm(store), out = [];
    for (const brand of Object.keys(BRAND)) {
      const keys = new Set(KNOWN[brand].filter((k) => !k.hidden).map((k) => `${brand}:${k.tier}`));
      for (const k of [...Object.keys(st.seen), ...Object.keys(st.picks), ...Object.keys(st.auto)]) if (inBrand(k, brand)) keys.add(k);
      for (const key of keys) {
        const tier = key.slice(brand.length + 1), known = KNOWN[brand].find((k) => k.tier === tier);
        out.push({ key, brand, tier, name: nameOf(brand, tier), known: !!known, id: known?.id || st.seen[key]?.[0] || tier, ver: known?.ver || '', seen: st.seen[key] || [] });
      }
    }
    return out;
  }
  return { LETTER_STYLES, BRAND, KNOWN, STYLES, STYLE_KEYS, SHAPES, SETS, LOGOS, LOGO_SETS, PERSONA, SHAPE_STYLES, shapeSet, personaOf, draw, plain, parse, nameOf, emptyStore, brandStyle, usedVals, paramFor, resolveKey, resolve, svg, svgKey, pick, register, tiers };
})();
