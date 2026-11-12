// deliver(session, text): peer socket (only when enabled and a handshake is recorded) -> tmux paste -> read-only.
// Guards before any send: liveSend true; pid alive with the same procStart; the pane still belongs to the session
// (pane_pid is the pid or an ancestor of it); no prompt open; text <= 16 KB; 6 sends per minute per session.
import * as peer from './peer-socket.mjs';
import { validKey } from './tmux.mjs';

export const MAX_TEXT = 16 * 1024;
export const REASONS = {
  liveSendOff: 'live_send_off',
  noPane: 'no pane or socket',
  headless: 'headless agent: view and controls only',
  paneChanged: 'pane changed',
  promptOpen: 'prompt open: answer it first',
  stopped: 'session stopped',
  promptChanged: 'the prompt changed, look again',
};

export class Refusal extends Error { constructor(reason, code = 409) { super(reason); this.reason = reason; this.code = code; } }

export function makeDelivery({ cfg, proc, tmux, prompts, rate, dataDir, peerClient = peer }) {
  function liveGuard() { if (!cfg.liveSend()) throw new Refusal(REASONS.liveSendOff); }
  function identity(s) {
    if (!s || !s.pid) throw new Refusal(REASONS.noPane);
    // a row the registry could not tie to its process (stopped, pid reused, no procStart to prove it) gets no sends,
    // keys or signals
    if (s.alive === false || s.procStart == null) throw new Refusal(REASONS.stopped);
    const now = proc.procStart(s.pid);
    if (now == null || (s.procStart != null && String(now) !== String(s.procStart))) throw new Refusal(REASONS.stopped);
  }
  // the pane still exists and its pane_pid is the session pid or an ancestor of it
  async function ownedPane(s) {
    if (!s.pane) throw new Refusal(s.headless || s.source === 'run' ? REASONS.headless : REASONS.noPane);
    const panes = await tmux.listPanes();
    const p = panes.find((x) => x.id === s.pane);
    if (!p || (s.panePid && p.pid !== s.panePid) || !proc.isAncestor(p.pid, s.pid)) throw new Refusal(REASONS.paneChanged);
    return p;
  }
  async function openPrompt(s) {
    if (prompts.fromRegistry(s)) return true;
    if (s.pane) { try { return !!(await prompts.fromPane(s, tmux)); } catch { return false; } }
    return false;
  }
  const usePeer = (s) => cfg.load().peer?.enabled === true && s.socket && s.harness === 'claude' && peer.handshakeRecorded(dataDir);

  async function deliver(s, text) {
    liveGuard();
    if (typeof text !== 'string' || !text.trim()) throw new Refusal('empty text', 422);
    if (Buffer.byteLength(text) > MAX_TEXT) throw new Refusal('text over 16 KB', 413);
    identity(s);
    if (await openPrompt(s)) throw new Refusal(REASONS.promptOpen);
    const peerOk = usePeer(s);
    const p = peerOk ? null : await ownedPane(s);
    // the rate token is taken only once every guard passed
    if (!rate.take(`send:${s.id}`)) throw new Refusal('rate limited (6 per minute)', 429);
    if (peerOk) { await peerClient.sendText(s.socket, text); return { via: 'peer', bytes: Buffer.byteLength(text) }; }
    await tmux.paste(p.id, text);
    return { via: 'tmux', pane: p.id, bytes: Buffer.byteLength(text) };
  }

  // typed keys from the Terminal tab: [{key:'Enter'} | {text:'abc'}]
  async function keys(s, list) {
    liveGuard();
    if (!Array.isArray(list) || !list.length || list.length > 64 || !list.every(validKey)) throw new Refusal('bad keys', 422);
    identity(s);
    const p = await ownedPane(s);
    for (const k of list) await (k.key ? tmux.sendKeys(p.id, k.key) : tmux.sendKeys(p.id, k.text, { literal: true }));
    return { via: 'tmux', pane: p.id, count: list.length };
  }

  // prompt answer: re-capture, same hash, then the option's keys
  async function answer(s, hash, optionIndex) {
    liveGuard();
    identity(s);
    const p = await ownedPane(s);
    const now = await prompts.fromPane({ ...s, pane: p.id }, tmux);
    if (!now || now.hash !== hash) throw new Refusal(REASONS.promptChanged);
    const opt = now.options[Number(optionIndex)];
    if (!opt) throw new Refusal('unknown option', 422);
    for (const k of opt.keys) await tmux.sendKeys(p.id, k);
    return { via: 'tmux', pane: p.id, option: opt.label };
  }

  // interrupt (Escape) and Ctrl-C on the pane
  async function paneKey(s, key) {
    liveGuard(); identity(s);
    const p = await ownedPane(s);
    await tmux.sendKeys(p.id, key);
    return { via: 'tmux', pane: p.id };
  }
  return { deliver, keys, answer, paneKey, liveGuard, identity, ownedPane };
}
