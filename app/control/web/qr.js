// In-house QR encoder (ISO/IEC 18004): byte mode (plus numeric for the standard's worked example), ECC level M,
// versions 1-10, mask chosen by the four standard penalty rules. Plain ES module: runs in the browser (desktop
// Control page, pairing QR) and in Node (tests). No DOM, no dependencies. Output: a square boolean matrix.

const ECC_M = { bits: 0 }; // format-info ECC bits: L=1, M=0, Q=3, H=2
const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
export const MAX_VERSION = 10;

function rawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) { const n = Math.floor(ver / 7) + 2; r -= (25 * n - 10) * n - 55; if (ver >= 7) r -= 36; }
  return r;
}
export function dataCodewords(ver) { return Math.floor(rawDataModules(ver) / 8) - EC_PER_BLOCK[ver] * NUM_BLOCKS[ver]; }

// ---- GF(256), polynomial 0x11D
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
export const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
export const gfExp = (i) => EXP[i % 255];
function rsDivisor(degree) {
  // coefficients of prod_{i<degree} (x - a^i), highest power first, leading 1 dropped
  let r = new Array(degree).fill(0); r[degree - 1] = 1; let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) { r[j] = gfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; }
    root = gfMul(root, 2);
  }
  return r;
}
export function rsRemainder(data, degree) {
  const div = rsDivisor(degree), r = new Array(degree).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); for (let i = 0; i < degree; i++) r[i] ^= gfMul(div[i], f); }
  return r;
}

// ---- segments -> data codewords
class Bits { constructor() { this.a = []; } put(v, n) { for (let i = n - 1; i >= 0; i--) this.a.push((v >>> i) & 1); } }
const countBits = (mode, ver) => (mode === 'numeric' ? (ver <= 9 ? 10 : 12) : (ver <= 9 ? 8 : 16));
const utf8 = (s) => (typeof TextEncoder !== 'undefined' ? [...new TextEncoder().encode(s)] : [...Buffer.from(s, 'utf8')]);
function segBits(seg, ver) {
  const b = new Bits();
  if (seg.mode === 'numeric') {
    if (!/^\d*$/.test(seg.text)) throw new Error('numeric segment needs digits');
    b.put(1, 4); b.put(seg.text.length, countBits('numeric', ver));
    for (let i = 0; i < seg.text.length; i += 3) { const g = seg.text.slice(i, i + 3); b.put(Number(g), g.length * 3 + 1); }
  } else {
    const bytes = seg.bytes || utf8(seg.text);
    b.put(4, 4); b.put(bytes.length, countBits('byte', ver));
    for (const x of bytes) b.put(x, 8);
  }
  return b.a;
}
export function codewordsFor(segs, ver) {
  const cap = dataCodewords(ver) * 8;
  const bits = segs.flatMap((s) => segBits(s, ver));
  if (bits.length > cap) return null;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, x) => (a << 1) | x, 0));
  for (let p = 0xec; out.length < cap / 8; p ^= 0xec ^ 0x11) out.push(p);
  return out;
}

// data codewords -> blocks with EC, interleaved
export function interleave(data, ver) {
  const nb = NUM_BLOCKS[ver], ec = EC_PER_BLOCK[ver], raw = Math.floor(rawDataModules(ver) / 8);
  const nShort = nb - (raw % nb), shortLen = Math.floor(raw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dat = data.slice(k, k + shortLen - ec + (i < nShort ? 0 : 1)); k += dat.length;
    const e = rsRemainder(dat, ec);
    if (i < nShort) dat.push(0);
    blocks.push(dat.concat(e));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ec || j >= nShort) out.push(b[i]); });
  return out;
}

// ---- matrix
export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6]; for (let pos = size - 7; r.length < n; pos -= step) r.splice(1, 0, pos);
  return r;
}
export function formatBits(mask) {
  const data = (ECC_M.bits << 3) | mask; let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
function versionBits(ver) { let rem = ver; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25); return (ver << 12) | rem; }
const bit = (x, i) => ((x >>> i) & 1) !== 0;

function baseMatrix(ver) {
  const size = ver * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = alignmentPositions(ver), last = al.length - 1;
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(m, fn, 0, size);
  if (ver >= 7) { const v = versionBits(ver); for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, bit(v, i)); set(b, a, bit(v, i)); } }
  return { m, fn, size };
}
function drawFormat(m, fn, mask, size) {
  const b = formatBits(mask); const set = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
  set(8, 7, bit(b, 6)); set(8, 8, bit(b, 7)); set(7, 8, bit(b, 8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
  set(8, size - 8, true); // the dark module
}
function placeData(m, fn, size, cw) {
  let i = 0; const n = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x]) { m[y][x] = i < n ? bit(cw[i >>> 3], 7 - (i & 7)) : false; i++; }
    }
  }
}
export const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// ISO/IEC 18004 section 7.8.3: N1=3 (runs of 5+, +1 per extra), N2=3 (2x2 blocks), N3=40 (1:1:3:1:1 finder-like
// pattern with 4 light modules on one side), N4=10 per 5% deviation of dark modules from 50%
export function penalty(m) {
  const size = m.length; let p = 0, dark = 0;
  const lines = [];
  for (let y = 0; y < size; y++) lines.push(m[y]);
  for (let x = 0; x < size; x++) lines.push(m.map((r) => r[x]));
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) p += 3 + (run - 5); run = 1; }
    }
    for (let i = 0; i + 11 <= size; i++) {
      let a = true, b = true;
      for (let k = 0; k < 11; k++) { const v = line[i + k] ? 1 : 0; if (v !== P1[k]) a = false; if (v !== P2[k]) b = false; }
      if (a) p += 40; if (b) p += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
  for (const r of m) for (const c of r) if (c) dark++;
  p += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
  return p;
}

// segs: [{mode: 'byte'|'numeric', text}] ; opts.version forces a version; opts.mask forces a mask (0-7)
export function encodeSegments(segs, opts = {}) {
  let ver = opts.version || 0, data = null;
  if (ver) { data = codewordsFor(segs, ver); if (!data) throw new Error(`data too long for version ${ver}-M`); }
  else for (ver = 1; ver <= MAX_VERSION; ver++) { data = codewordsFor(segs, ver); if (data) break; }
  if (!data) throw new Error(`data too long for QR version ${MAX_VERSION}-M`);
  const all = interleave(data, ver);
  const { m, fn, size } = baseMatrix(ver);
  placeData(m, fn, size, all);
  const apply = (mask) => {
    const out = m.map((r) => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) out[y][x] = !out[y][x];
    drawFormat(out, fn.map((r) => r.slice()), mask, size);
    return out;
  };
  let best = null;
  const masks = opts.mask != null ? [opts.mask] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const k of masks) { const mm = apply(k), s = penalty(mm); if (!best || s < best.score) best = { mask: k, modules: mm, score: s }; }
  return { version: ver, size, ecc: 'M', mask: best.mask, penalty: best.score, modules: best.modules, dataCodewords: data, codewords: all };
}
export function encodeText(text, opts = {}) { return encodeSegments([{ mode: 'byte', text: String(text) }], opts); }
