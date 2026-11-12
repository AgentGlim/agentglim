// New headed sessions in tmux session `obs`: tmux new-window -d -t obs -n <harness>-<4 hex> -c <dir> -- <launcher> <flags>
// Everything through execFile with an argument array (no shell). Folder: a real directory under a configured root
// (realpath-checked, no `..`). Model, effort and permission mode only from control.json allowlists; Claude's
// bypassPermissions is never offered: only the brief's modes (CLAUDE_MODES) pass, whatever control.json lists.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CLAUDE_MODES = Object.freeze(['manual', 'acceptEdits', 'plan', 'auto']);
export const HARNESSES = ['claude', 'codex', 'pi', 'opencode'];
export class LaunchError extends Error { constructor(msg) { super(msg); this.code = 422; } }

export function resolveFolder(folder, roots) {
  if (typeof folder !== 'string' || !folder || folder.length > 500) throw new LaunchError('folder required');
  if (folder.split(/[\\/]/).includes('..')) throw new LaunchError('folder may not contain ..');
  if (!path.isAbsolute(folder)) throw new LaunchError('folder must be absolute');
  let real; try { real = fs.realpathSync(folder); } catch { throw new LaunchError('folder does not exist'); }
  let st; try { st = fs.statSync(real); } catch { st = null; }
  if (!st?.isDirectory()) throw new LaunchError('not a directory');
  const ok = roots.some((r) => { let rr; try { rr = fs.realpathSync(r); } catch { return false; } return real.startsWith(rr + path.sep); });
  if (!ok) throw new LaunchError('folder is outside the project roots');
  return real;
}

export function listFolders(roots) {
  const out = [];
  for (const r of roots) {
    let rr; try { rr = fs.realpathSync(r); } catch { continue; }
    let es = []; try { es = fs.readdirSync(rr, { withFileTypes: true }); } catch { continue; }
    for (const e of es) if (e.isDirectory() && !e.name.startsWith('.')) out.push(path.join(r, e.name));
  }
  return out.sort();
}

// launcher argv for one request, or a LaunchError
export function buildArgv(req, launchCfg) {
  const h = req.harness;
  if (!HARNESSES.includes(h)) throw new LaunchError('unknown harness');
  const c = launchCfg[h] || {};
  const pick = (v, list, what, optional = true) => {
    if (v == null || v === '') { if (optional) return null; throw new LaunchError(`${what} required`); }
    if (!Array.isArray(list) || !list.includes(v)) throw new LaunchError(`${what} not allowed`);
    return v;
  };
  const argv = [c.bin || h];
  if (h === 'claude') {
    const model = pick(req.model, c.models, 'model'), effort = pick(req.effort, c.efforts, 'effort');
    const mode = req.mode === 'bypassPermissions' ? (() => { throw new LaunchError('bypassPermissions is not offered'); })() : pick(req.mode, (c.modes || []).filter((m) => CLAUDE_MODES.includes(m)), 'permission mode');
    if (model) argv.push('--model', model);
    if (effort) argv.push('--effort', effort);
    if (mode) argv.push('--permission-mode', mode);
  } else if (h === 'codex') {
    const model = pick(req.model, c.models, 'model'), effort = pick(req.effort, c.efforts, 'effort');
    if (model) argv.push('-m', model);
    if (effort) argv.push('-c', `model_reasoning_effort=${effort}`);
  } else if (h === 'pi') {
    const model = pick(req.model, c.models, 'model'), thinking = pick(req.effort, c.thinking, 'thinking');
    if (model) argv.push('--model', thinking ? `${model}:${thinking}` : model);
    else if (thinking) argv.push('--thinking', thinking);
  } else if (h === 'opencode') {
    const model = pick(req.model, c.models, 'model');
    if (model && !/^[\w.-]+\/[\w.:-]+$/.test(model)) throw new LaunchError('model must be provider/model');
    if (model) argv.push('-m', model);
  }
  return argv;
}

export function makeLauncher({ cfg, tmux, proc }) {
  function plan(req) {
    const conf = cfg.load().launch;
    const dir = resolveFolder(req.folder, conf.roots || []);
    const argv = buildArgv(req, conf);
    const name = `${req.harness}-${crypto.randomBytes(2).toString('hex')}`;
    return { harness: req.harness, dir, argv, name, session: conf.tmuxSession || 'obs' };
  }
  async function launch(p, { waitMs = 10000 } = {}) {
    if (!(await tmux.hasSession(p.session))) await tmux.newSession(p.session, p.dir);
    const w = await tmux.newWindow(p.session, p.name, p.dir, p.argv);
    // the agent pid: the pane pid or a descendant that is an agent process (10 s)
    let pid = null; const t0 = Date.now();
    while (!pid && Date.now() - t0 < waitMs) {
      const tree = proc.tree(w.panePid);
      pid = tree.find((x) => { const st = proc.stat(x); return st && proc.agentKind(st.comm, x); }) || null;
      if (!pid) await new Promise((r) => setTimeout(r, 250));
    }
    return { ...w, pid, window: `${p.session}:${p.name}`, attach: `tmux attach -t ${p.session}` };
  }
  return { plan, launch, folders: () => listFolders(cfg.load().launch.roots || []) };
}
