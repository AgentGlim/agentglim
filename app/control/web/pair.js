// /pair on the remote listener: pair this phone (one-time token from the desktop QR), register a passkey or a PIN,
// unlock, lock. All text goes in with textContent. The token is removed from the address bar at once.
const $ = (id) => document.getElementById(id);
const STEPS = ['stepNone', 'stepName', 'stepRegister', 'stepUnlock', 'stepDone'];
const token = (() => { const m = location.hash.match(/^#t=([\w-]{43})$/); return m ? m[1] : null; })();
if (location.hash) history.replaceState(null, '', location.pathname);
let pending = token;

const b2u = (b) => { const s = String.fromCharCode(...new Uint8Array(b)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const u2b = (s) => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(t, (c) => c.charCodeAt(0)).buffer; };
const REASONS = { pair_token_used: 'This pairing code was already used. Make a new one on the PC.', pair_token_expired: 'This pairing code expired (5 minutes). Make a new one on the PC.', pair_token_invalid: 'This pairing code is not valid. Make a new one on the PC.', pair_token_other_listener: 'This pairing code was made for another address. Make a new one on the PC.', pin_wrong: 'Wrong PIN.', pin_wrong_locked: 'Wrong PIN. Locked for 15 minutes.', pin_locked: 'PIN locked. Try again later or use the passkey.', device_disabled: 'Too many wrong PINs: this phone is disabled. Pair it again at the PC.', step_up: 'Unlock again first (passkey or PIN in the last 2 minutes).', rate_limited: 'Too many tries. Wait a moment.' };

function say(t, bad = false) { const m = $('msg'); m.textContent = t || ''; m.className = bad ? 'msg bad' : 'msg'; }
function show(id) { for (const s of STEPS) $(s).hidden = s !== id; }
async function api(method, p, body) {
  const r = await fetch(`/api/remote/${p}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(REASONS[j.error] || j.error || r.statusText); e.status = r.status; e.body = j; if (j.triesBeforeLock) e.message += ` ${j.triesBeforeLock} tries before a 15-minute lock.`; throw e; }
  return j;
}

async function refresh() {
  let me; try { me = await api('GET', 'me'); } catch (e) { say(e.message, true); return; }
  $('dot').className = `dot ${me.unlocked ? 'ok' : me.paired ? '' : 'bad'}`;
  $('who').textContent = me.paired ? `${me.device.name}: ${me.unlocked ? 'unlocked' : 'locked'}` : 'not paired';
  if (pending) return show('stepName');
  if (!me.paired) return show('stepNone');
  if (!me.unlocked && (me.methods.passkeys || me.methods.pin)) {
    $('unlockPasskey').hidden = !me.methods.passkeys || !window.PublicKeyCredential;
    $('pinForm').hidden = !me.methods.pin;
    return show('stepUnlock');
  }
  if (!me.unlocked) return show(me.canRegister ? 'stepRegister' : 'stepNone');
  $('doneMeta').textContent = `Passkeys: ${me.methods.passkeys}. PIN: ${me.methods.pin ? 'set' : 'not set'}. Unlock lasts 15 minutes idle, 12 hours at most.`;
  show('stepDone');
}

async function passkeyRegister() {
  const { publicKey: o } = await api('POST', 'webauthn/register/options', {});
  o.challenge = u2b(o.challenge); o.user.id = u2b(o.user.id);
  o.excludeCredentials = (o.excludeCredentials || []).map((c) => ({ ...c, id: u2b(c.id) }));
  const c = await navigator.credentials.create({ publicKey: o });
  await api('POST', 'webauthn/register/verify', { credential: { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(c.response.clientDataJSON), attestationObject: b2u(c.response.attestationObject) } } });
}
async function passkeyUnlock() {
  const { publicKey: o } = await api('POST', 'webauthn/auth/options', {});
  o.challenge = u2b(o.challenge); o.allowCredentials = (o.allowCredentials || []).map((c) => ({ ...c, id: u2b(c.id) }));
  const c = await navigator.credentials.get({ publicKey: o });
  await api('POST', 'webauthn/auth/verify', { credential: { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(c.response.clientDataJSON), authenticatorData: b2u(c.response.authenticatorData), signature: b2u(c.response.signature), userHandle: c.response.userHandle ? b2u(c.response.userHandle) : null } } });
}
const run = (fn, ok) => async (ev) => { ev?.preventDefault?.(); say('...'); try { await fn(); say(ok); } catch (e) { say(e.name === 'NotAllowedError' ? 'Cancelled.' : e.message, true); } await refresh(); };

$('nameForm').addEventListener('submit', run(async () => { const t = pending; pending = null; await api('POST', 'pair', { token: t, name: $('devName').value }); }, 'Paired. Now choose how to unlock.'));
$('regPasskey').addEventListener('click', run(passkeyRegister, 'Passkey saved. Unlocked.'));
$('addPasskey').addEventListener('click', run(passkeyRegister, 'Passkey added.'));
$('unlockPasskey').addEventListener('click', run(passkeyUnlock, 'Unlocked.'));
$('pinSetForm').addEventListener('submit', run(async () => { await api('POST', 'pin/set', { pin: $('pinNew').value }); $('pinNew').value = ''; }, 'PIN set. Unlocked.'));
$('pinChangeForm').addEventListener('submit', run(async () => { await api('POST', 'pin/set', { pin: $('pinChange').value }); $('pinChange').value = ''; }, 'PIN changed.'));
$('pinForm').addEventListener('submit', run(async () => { const v = $('pin').value; $('pin').value = ''; await api('POST', 'pin/unlock', { pin: v }); }, 'Unlocked.'));
$('lock').addEventListener('click', run(() => api('POST', 'lock', {}), 'Locked.'));
if (!window.PublicKeyCredential) { $('regPasskey').hidden = true; $('addPasskey').hidden = true; }
refresh();
