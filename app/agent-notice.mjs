// agent-notice.mjs: the one rule for the "Your AI agent" popup family (first-run setup, no SuperAgent,
// stale/offline refresh). Shared by the dashboard (portable-ui.js imports it) and the tests.
//
//   The popup (a blocking <dialog>) only ever opens while the setup file is NOT filled out.
//   On a configured install, staleness, a lost connection or a missing SuperAgent heartbeat is a small
//   non-blocking banner, never the popup.
//
// "Filled out" is decided on the server by setupFilled() in setup.mjs and sent as state.setupFilled
// (/api/portable and every /api/stream snapshot). An unknown state (server unreachable, older server) never opens
// the popup: the page cannot tell that setup is missing, so it must not block the dashboard.
export const STALE_MS = 15 * 60e3;   // no snapshot for this long while the page is visible: the data looks stale
export const OFFLINE_MS = 20e3;      // a stream error that lasts this long is worth a banner (restarts take ~10 s)

export function setupFilledState(state) {
  if (!state || typeof state !== 'object') return null;           // unknown
  if (typeof state.setupFilled === 'boolean') return state.setupFilled;
  if (typeof state.setupComplete === 'boolean') return state.setupComplete; // servers from before setupFilled
  return null;
}

// state: the /api/portable object (or null when not read yet). client: what only the browser knows.
//   offlineMs  how long the event stream has been failing (0 = connected)
//   quietMs    how long since the last snapshot while the page was visible (hidden time never counts)
// Returns { modal: 'setup' | null, banner: 'offline' | 'stale' | 'watcher' | null }.
export function agentNotice(state, { offlineMs = 0, quietMs = 0 } = {}) {
  if (setupFilledState(state) === false) return { modal: 'setup', banner: null };
  const banner = offlineMs >= OFFLINE_MS ? 'offline'
    : state?.stale || quietMs > STALE_MS ? 'stale'
    : state && state.watcher === false ? 'watcher' : null;
  return { modal: null, banner };
}
