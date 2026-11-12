// Minimal CBOR (RFC 8949) for WebAuthn: decode attestation objects and COSE keys; encode (used by the test
// soft authenticator). Supports unsigned/negative ints, byte and text strings, arrays, maps, false/true/null.
// No indefinite lengths, tags or floats (WebAuthn authenticators do not use them in these structures).

export class CborError extends Error {}

export function decode(buf, { allowTrailing = false } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let i = 0;
  const need = (n) => { if (i + n > b.length) throw new CborError('cbor: truncated'); };
  function len(info) {
    if (info < 24) return info;
    if (info === 24) { need(1); return b[i++]; }
    if (info === 25) { need(2); const v = b.readUInt16BE(i); i += 2; return v; }
    if (info === 26) { need(4); const v = b.readUInt32BE(i); i += 4; return v; }
    if (info === 27) { need(8); const v = b.readBigUInt64BE(i); i += 8; if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('cbor: int too large'); return Number(v); }
    throw new CborError('cbor: indefinite length not supported');
  }
  function item(depth) {
    if (depth > 16) throw new CborError('cbor: too deep');
    need(1);
    const ib = b[i++], major = ib >> 5, info = ib & 31;
    switch (major) {
      case 0: return len(info);
      case 1: return -1 - len(info);
      case 2: { const n = len(info); need(n); const v = b.subarray(i, i + n); i += n; return Buffer.from(v); }
      case 3: { const n = len(info); need(n); const v = b.toString('utf8', i, i + n); i += n; return v; }
      case 4: { const n = len(info); if (n > 1000) throw new CborError('cbor: array too long'); const a = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
      case 5: { const n = len(info); if (n > 1000) throw new CborError('cbor: map too long'); const m = new Map(); for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); } return m; }
      case 7: if (info === 20) return false; if (info === 21) return true; if (info === 22) return null; throw new CborError('cbor: unsupported simple/float');
      default: throw new CborError('cbor: tags not supported');
    }
  }
  const v = item(0);
  if (!allowTrailing && i !== b.length) throw new CborError('cbor: trailing bytes');
  return allowTrailing ? { value: v, length: i } : v;
}

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const x = Buffer.alloc(3); x[0] = (major << 5) | 25; x.writeUInt16BE(n, 1); return x; }
  const x = Buffer.alloc(5); x[0] = (major << 5) | 26; x.writeUInt32BE(n, 1); return x;
}

export function encode(v) {
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === null || v === undefined) return Buffer.from([0xf6]);
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new CborError('cbor: floats not supported'); return v >= 0 ? head(0, v) : head(1, -1 - v); }
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { const s = Buffer.from(v); return Buffer.concat([head(2, s.length), s]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encode)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [encode(k), encode(x)])]);
}
