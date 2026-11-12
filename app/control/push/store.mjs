// Push tables in control.db (sub-item 03). push_subs is 02's table (auth/pairing.mjs: revoke deletes a device's rows);
// the create below repeats its schema so this module also works on its own. Rows hold endpoints and keys, never
// payload text. push_prefs: per-type switches, scope 'default' (desktop) or a device id (the phone's own).
export const TYPES = Object.freeze(['needs_input', 'watcher_reply', 'watcher_ask', 'plan_done', 'audit_score', 'gate_waiting', 'blocked', 'driver_down', 'usage_limit']);
export const TYPE_LABELS = Object.freeze({
  needs_input: 'A session needs input', watcher_reply: 'The watcher replied', watcher_ask: 'The watcher added an ask',
  plan_done: 'A plan finished', audit_score: 'A new audit score', gate_waiting: 'A gate waits for you',
  blocked: 'Something is blocked', driver_down: 'The driver is down', usage_limit: 'A usage limit was reached',
});

const SCHEMA = `
create table if not exists push_subs (id text primary key, device_id text, endpoint text, p256dh text, auth text, created integer, last_ok integer, fails integer default 0);
create table if not exists push_prefs (scope text, type text, enabled integer, updated integer, primary key (scope, type));
create table if not exists push_log (id integer primary key autoincrement, ts integer, device_id text, sub_id text, type text, status integer, test integer default 0);
create table if not exists push_state (k text primary key, v text, updated integer);
`;

export function makePushStore(db, { now = () => Date.now(), configTypes = () => ({}) } = {}) {
  db.exec(SCHEMA);
  const q = (sql) => db.prepare(sql);
  function defaults() {
    const c = configTypes() || {};
    const rows = Object.fromEntries(q("select type, enabled from push_prefs where scope = 'default'").all().map((r) => [r.type, !!r.enabled]));
    return Object.fromEntries(TYPES.map((t) => [t, t in rows ? rows[t] : c[t] !== false]));
  }
  function prefs(deviceId) {
    const d = defaults();
    if (!deviceId) return { types: d, own: {} };
    const own = Object.fromEntries(q('select type, enabled from push_prefs where scope = ?').all(String(deviceId)).map((r) => [r.type, !!r.enabled]));
    return { types: Object.fromEntries(TYPES.map((t) => [t, t in own ? own[t] : d[t]])), own };
  }
  function setPrefs(scope, patch) {
    const st = q('insert or replace into push_prefs values (?,?,?,?)');
    let n = 0;
    for (const [t, v] of Object.entries(patch || {})) { if (!TYPES.includes(t) || typeof v !== 'boolean') continue; st.run(String(scope), t, v ? 1 : 0, now()); n++; }
    return n;
  }
  function subscribe(deviceId, { endpoint, p256dh, auth }, id) {
    // one row per endpoint; a re-subscribe of the same endpoint (new keys) replaces it
    const old = q('select id from push_subs where endpoint = ?').get(endpoint);
    if (old) q('delete from push_subs where id = ?').run(old.id);
    q('insert into push_subs (id, device_id, endpoint, p256dh, auth, created, last_ok, fails) values (?,?,?,?,?,?,0,0)').run(id, deviceId, endpoint, p256dh, auth, now());
    // a device keeps at most 4 subscriptions (browser reinstall, TWA + Chrome): drop the oldest
    const extra = q('select id from push_subs where device_id = ? order by created desc limit -1 offset 4').all(deviceId);
    for (const r of extra) q('delete from push_subs where id = ?').run(r.id);
    return id;
  }
  return {
    defaults, prefs, setPrefs, subscribe,
    unsubscribe: (deviceId, endpoint) => q('delete from push_subs where device_id = ? and endpoint = ?').run(deviceId, String(endpoint)).changes,
    subs: (deviceId = null) => (deviceId ? q('select * from push_subs where device_id = ? order by created').all(deviceId) : q('select * from push_subs order by created').all()),
    dropSub: (id) => q('delete from push_subs where id = ?').run(id).changes,
    markOk: (id) => q('update push_subs set last_ok = ?, fails = 0 where id = ?').run(now(), id),
    markFail: (id) => q('update push_subs set fails = fails + 1 where id = ?').run(id),
    log: (row) => q('insert into push_log (ts, device_id, sub_id, type, status, test) values (?,?,?,?,?,?)').run(now(), row.deviceId || null, row.subId || null, row.type, row.status ?? 0, row.test ? 1 : 0),
    lastTest: () => q('select ts, device_id as deviceId, type, status from push_log where test = 1 order by id desc limit 1').get() || null,
    recent: (n = 20) => q('select ts, device_id as deviceId, type, status, test from push_log order by id desc limit ?').all(n),
    stateGet: (k) => { const r = q('select v from push_state where k = ?').get(k); if (!r) return null; try { return JSON.parse(r.v); } catch { return null; } },
    statePut: (k, v) => q('insert or replace into push_state values (?,?,?)').run(k, JSON.stringify(v), now()),
  };
}
