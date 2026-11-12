// Agentbox fleet snapshot reader for the Observatory "Containers" card (INCUS-SPEC §7/§8).
//
// Read-only by construction: this module reads local files and private integration settings,
// never starts a child process, never calls `incus`, never writes a file and
// exposes no POST route. The Observatory has no Incus identity: the launcher
// writes state/fleet/snapshot.json (atomic os.replace on the Python side) and
// this module only reads and validates it.
//
// Contract: build/contracts/fleet-snapshot-v1.schema.json (v1, closed objects,
// 13 alert rules, no secrets). The checker below is a hand-written mirror of
// the Python `agentbox.fleet_schema` checker so the card can never render a
// document the writer would refuse to emit.

import fs from 'node:fs';
import { integrations } from './integrations.mjs';

export const SNAPSHOT_SCHEMA = 'fleet-snapshot/1';
export const STALE_AFTER_S = 60;
export const MAX_SNAPSHOT_BYTES = 1_000_000;
export const DEFAULT_SNAPSHOT_PATH = integrations.fleetSnapshot;
export const DOCTOR_COMMAND = 'agentbox doctor --runtime incus';
export const NOT_SET_UP_MESSAGE = 'Incus not set up yet';

export const TOP_FIELDS = Object.freeze([
  'schema', 'generated_at', 'host', 'incus_version', 'project', 'stale_after_s',
  'containers', 'exits', 'alerts',
]);
export const CONTAINER_FIELDS = Object.freeze([
  'name', 'run_id', 'profile', 'role', 'state', 'started_at', 'cpu_pct', 'mem_mib',
  'mem_limit_mib', 'disk_mib', 'private_ip', 'exit', 'public_ip', 'country', 'perms',
  'last_event', 'owner',
]);
export const PERMS_FIELDS = Object.freeze([
  'privileged', 'nesting', 'idmap_isolated', 'guestapi', 'mounts', 'devices', 'acl',
  'raw_keys',
]);
export const EXIT_FIELDS = Object.freeze([
  'name', 'kind', 'provider', 'gateway', 'state', 'public_ip', 'country', 'checked_at',
  'leak', 'workers', 'bytes_month', 'usd_month', 'cap',
]);
export const ALERT_FIELDS = Object.freeze(['rule', 'severity', 'target', 'detail', 'at']);
export const ALERT_RULES = Object.freeze([
  'container_privileged', 'container_nesting', 'container_raw_keys',
  'container_writable_host_mount', 'container_guestapi_enabled', 'container_without_acl',
  'container_not_in_journal', 'run_without_container', 'exit_check_failed',
  'exit_check_stale', 'cap_warning', 'cap_exhausted', 'snapshot_stale',
]);
export const CONTAINER_STATES = Object.freeze([
  'running', 'stopped', 'frozen', 'starting', 'stopping', 'error', 'crashed', 'unknown',
]);
export const EXIT_STATES = Object.freeze(['up', 'down', 'blocked', 'disabled', 'unknown']);
export const EXIT_KINDS = Object.freeze(['none', 'direct', 'wireguard', 'proxy', 'vps', 'unknown']);
export const ROLES = Object.freeze(['worker', 'orchestrator', 'gateway', 'unknown']);
export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);
//: Key names that may never appear anywhere in a snapshot (INCUS-SPEC §7 last line).
export const SECRET_KEYS = Object.freeze([
  'env', 'environment', 'password', 'passwd', 'private_key', 'privatekey', 'token',
  'api_key', 'apikey', 'secret', 'secrets', 'credential', 'credentials', 'authorization',
  'cookie', 'config', 'config_text', 'peer', 'peer_config', 'wg_config', 'key', 'keys',
  'username', 'user', 'auth',
]);

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBool = (v) => typeof v === 'boolean';
const isInt = (v) => typeof v === 'number' && Number.isInteger(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string';
const isTimestamp = (v) => isStr(v) && TIMESTAMP_RE.test(v);
const isIpv4 = (v) => isStr(v) && IPV4_RE.test(v);

function closed(value, allowed, where, problems, required = allowed) {
  if (!isObject(value)) {
    problems.push(`${where}: expected object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    const lowered = String(key).trim().toLowerCase();
    if (SECRET_KEYS.includes(lowered)) problems.push(`${where}.${key}: secret-shaped key`);
    else if (!allowed.includes(key)) problems.push(`${where}.${key}: unknown field`);
  }
  for (const key of required) {
    if (!(key in value)) problems.push(`${where}.${key}: missing`);
  }
  return true;
}

function kindCheck(value, kind, where, key, problems) {
  const optional = kind.endsWith('?');
  const base = kind.replace(/\?$/, '');
  if (value === null || value === undefined) {
    if (!optional) problems.push(`${where}.${key}: null where ${base} required`);
    return;
  }
  const ok =
    base === 'string' ? isStr(value)
      : base === 'boolean' ? isBool(value)
        : base === 'integer' ? isInt(value)
          : base === 'number' ? isNum(value)
            : base === 'list' ? Array.isArray(value)
              : base === 'object' ? isObject(value)
                : base === 'timestamp' ? isTimestamp(value)
                  : base === 'ipv4' ? isIpv4(value)
                    : false;
  if (!ok) problems.push(`${where}.${key}: expected ${base}`);
}

function lengthOk(value, key, where, problems, min, max) {
  if (!isStr(value)) return;
  if (min !== undefined && value.length < min) problems.push(`${where}.${key}: too short`);
  if (max !== undefined && value.length > max) problems.push(`${where}.${key}: too long`);
}

function numRange(value, key, where, problems, min, max) {
  if (!isNum(value)) return;
  if (min !== undefined && value < min) problems.push(`${where}.${key}: below ${min}`);
  if (max !== undefined && value > max) problems.push(`${where}.${key}: above ${max}`);
}

function checkPerms(perms, where, problems) {
  if (!closed(perms, PERMS_FIELDS, where, problems)) return;
  for (const flag of ['privileged', 'nesting', 'idmap_isolated', 'guestapi']) {
    kindCheck(perms[flag], 'boolean', where, flag, problems);
  }
  kindCheck(perms.acl, 'string?', where, 'acl', problems);
  lengthOk(perms.acl, 'acl', where, problems, undefined, 128);
  for (const key of ['mounts', 'devices', 'raw_keys']) {
    kindCheck(perms[key], 'list', where, key, problems);
  }
  for (const mount of Array.isArray(perms.mounts) ? perms.mounts : []) {
    if (!closed(mount, ['source', 'target', 'readonly'], `${where}.mounts[]`, problems)) continue;
    kindCheck(mount.source, 'string', `${where}.mounts[]`, 'source', problems);
    kindCheck(mount.target, 'string', `${where}.mounts[]`, 'target', problems);
    kindCheck(mount.readonly, 'boolean', `${where}.mounts[]`, 'readonly', problems);
    lengthOk(mount.source, 'source', `${where}.mounts[]`, problems, 1, 400);
    lengthOk(mount.target, 'target', `${where}.mounts[]`, problems, 1, 400);
  }
  for (const device of Array.isArray(perms.devices) ? perms.devices : []) {
    closed(device, ['name', 'type', 'network', 'target', 'readonly'], `${where}.devices[]`,
      problems, ['name', 'type']);
    if (!isObject(device)) continue;
    for (const key of ['name', 'type', 'network', 'target']) {
      if (key in device) kindCheck(device[key], 'string', `${where}.devices[]`, key, problems);
    }
    if ('readonly' in device) kindCheck(device.readonly, 'boolean', `${where}.devices[]`, 'readonly', problems);
  }
  for (const name of Array.isArray(perms.raw_keys) ? perms.raw_keys : []) {
    if (!isStr(name) || !name) problems.push(`${where}.raw_keys[]: not a non-empty string`);
  }
}

function checkContainer(item, where, problems) {
  if (!closed(item, CONTAINER_FIELDS, where, problems)) return;
  kindCheck(item.name, 'string', where, 'name', problems);
  kindCheck(item.run_id, 'string', where, 'run_id', problems);
  kindCheck(item.profile, 'string?', where, 'profile', problems);
  kindCheck(item.started_at, 'timestamp?', where, 'started_at', problems);
  kindCheck(item.cpu_pct, 'number?', where, 'cpu_pct', problems);
  numRange(item.cpu_pct, 'cpu_pct', where, problems, 0, 100);
  for (const key of ['mem_mib', 'mem_limit_mib', 'disk_mib']) {
    kindCheck(item[key], 'integer?', where, key, problems);
    numRange(item[key], key, where, problems, 0);
  }
  kindCheck(item.private_ip, 'ipv4?', where, 'private_ip', problems);
  kindCheck(item.public_ip, 'ipv4?', where, 'public_ip', problems);
  kindCheck(item.country, 'string?', where, 'country', problems);
  lengthOk(item.country, 'country', where, problems, undefined, 8);
  kindCheck(item.exit, 'string?', where, 'exit', problems);
  kindCheck(item.last_event, 'string?', where, 'last_event', problems);
  lengthOk(item.last_event, 'last_event', where, problems, undefined, 200);
  kindCheck(item.owner, 'string', where, 'owner', problems);
  lengthOk(item.name, 'name', where, problems, 1, 128);
  lengthOk(item.run_id, 'run_id', where, problems, 1, 200);
  lengthOk(item.owner, 'owner', where, problems, 1, 128);
  if (!ROLES.includes(item.role)) problems.push(`${where}.role: ${JSON.stringify(item.role)} not allowed`);
  if (!CONTAINER_STATES.includes(item.state)) problems.push(`${where}.state: ${JSON.stringify(item.state)} not allowed`);
  checkPerms(item.perms, `${where}.perms`, problems);
}

function checkExit(item, where, problems) {
  if (!closed(item, EXIT_FIELDS, where, problems)) return;
  kindCheck(item.name, 'string', where, 'name', problems);
  lengthOk(item.name, 'name', where, problems, 1, 64);
  kindCheck(item.provider, 'string?', where, 'provider', problems);
  kindCheck(item.gateway, 'string?', where, 'gateway', problems);
  kindCheck(item.public_ip, 'ipv4?', where, 'public_ip', problems);
  kindCheck(item.country, 'string?', where, 'country', problems);
  kindCheck(item.checked_at, 'timestamp?', where, 'checked_at', problems);
  kindCheck(item.workers, 'integer', where, 'workers', problems);
  numRange(item.workers, 'workers', where, problems, 0, 1024);
  kindCheck(item.bytes_month, 'integer?', where, 'bytes_month', problems);
  numRange(item.bytes_month, 'bytes_month', where, problems, 0);
  kindCheck(item.usd_month, 'number?', where, 'usd_month', problems);
  numRange(item.usd_month, 'usd_month', where, problems, 0);
  if (!EXIT_KINDS.includes(item.kind)) problems.push(`${where}.kind: ${JSON.stringify(item.kind)} not allowed`);
  if (!EXIT_STATES.includes(item.state)) problems.push(`${where}.state: ${JSON.stringify(item.state)} not allowed`);
  if (closed(item.leak, ['dns', 'ipv6'], `${where}.leak`, problems)) {
    for (const key of ['dns', 'ipv6']) kindCheck(item.leak[key], 'boolean?', `${where}.leak`, key, problems);
  }
  if (closed(item.cap, ['max_workers', 'max_gb_month', 'max_usd_month'], `${where}.cap`, problems)) {
    kindCheck(item.cap.max_workers, 'integer?', `${where}.cap`, 'max_workers', problems);
    kindCheck(item.cap.max_gb_month, 'number?', `${where}.cap`, 'max_gb_month', problems);
    kindCheck(item.cap.max_usd_month, 'number?', `${where}.cap`, 'max_usd_month', problems);
    for (const key of ['max_workers', 'max_gb_month', 'max_usd_month']) {
      numRange(item.cap[key], key, `${where}.cap`, problems, 0);
    }
  }
}

function checkAlert(item, where, problems) {
  if (!closed(item, ALERT_FIELDS, where, problems)) return;
  kindCheck(item.target, 'string', where, 'target', problems);
  kindCheck(item.detail, 'string', where, 'detail', problems);
  kindCheck(item.at, 'timestamp', where, 'at', problems);
  lengthOk(item.target, 'target', where, problems, undefined, 200);
  lengthOk(item.detail, 'detail', where, problems, undefined, 500);
  if (!ALERT_RULES.includes(item.rule)) problems.push(`${where}.rule: ${JSON.stringify(item.rule)} not allowed`);
  if (!SEVERITIES.includes(item.severity)) problems.push(`${where}.severity: ${JSON.stringify(item.severity)} not allowed`);
}

/** Validate a snapshot against the v1 contract. Empty array == valid. */
export function validateFleet(doc) {
  const problems = [];
  if (!closed(doc, TOP_FIELDS, 'snapshot', problems)) return problems;
  if (doc.schema !== SNAPSHOT_SCHEMA) problems.push('snapshot.schema: expected const fleet-snapshot/1');
  kindCheck(doc.generated_at, 'timestamp', 'snapshot', 'generated_at', problems);
  kindCheck(doc.host, 'string', 'snapshot', 'host', problems);
  lengthOk(doc.host, 'host', 'snapshot', problems, 1, 255);
  kindCheck(doc.incus_version, 'string?', 'snapshot', 'incus_version', problems);
  lengthOk(doc.incus_version, 'incus_version', 'snapshot', problems, undefined, 64);
  kindCheck(doc.project, 'string', 'snapshot', 'project', problems);
  lengthOk(doc.project, 'project', 'snapshot', problems, 1, 64);
  if (isStr(doc.project) && !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(doc.project)) {
    problems.push('snapshot.project: not a safe project name');
  }
  kindCheck(doc.stale_after_s, 'integer', 'snapshot', 'stale_after_s', problems);
  numRange(doc.stale_after_s, 'stale_after_s', 'snapshot', problems, 1, 86400);
  for (const section of ['containers', 'exits', 'alerts']) {
    if (!Array.isArray(doc[section])) problems.push(`snapshot.${section}: expected list`);
  }
  if (Array.isArray(doc.containers)) {
    if (doc.containers.length > 512) problems.push('snapshot.containers: too many items');
    doc.containers.forEach((item, i) => checkContainer(item, `snapshot.containers[${i}]`, problems));
  }
  if (Array.isArray(doc.exits)) {
    if (doc.exits.length > 64) problems.push('snapshot.exits: too many items');
    doc.exits.forEach((item, i) => checkExit(item, `snapshot.exits[${i}]`, problems));
  }
  if (Array.isArray(doc.alerts)) {
    if (doc.alerts.length > 1000) problems.push('snapshot.alerts: too many items');
    doc.alerts.forEach((item, i) => checkAlert(item, `snapshot.alerts[${i}]`, problems));
  }
  if (problems.length === 0) {
    const size = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (size > MAX_SNAPSHOT_BYTES) problems.push(`snapshot: larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  }
  return problems;
}

/** Path the Observatory reads; an explicit environment override takes precedence. */
export function snapshotPath(env = process.env) {
  const configured = env && typeof env.AGENTBOX_FLEET_SNAPSHOT === 'string'
    ? env.AGENTBOX_FLEET_SNAPSHOT.trim() : '';
  return configured || DEFAULT_SNAPSHOT_PATH;
}

const epochOf = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
};

/**
 * Read and validate the fleet snapshot. Never throws.
 *
 * @returns {{state: 'ok'|'stale'|'not_set_up'|'error', fleet?: object,
 *            doctor?: string, message?: string, age_s?: number|null,
 *            path: string, problems?: string[]}}
 */
export function readFleet(options = {}) {
  const target = options.path || snapshotPath(options.env);
  if (!target) return { state: 'not_set_up', path: null, message: 'No fleet snapshot configured' };
  const nowS = Number.isFinite(options.now) ? Number(options.now) : Date.now() / 1000;
  const result = { state: 'error', path: target };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { state: 'not_set_up', path: target, doctor: DOCTOR_COMMAND, message: NOT_SET_UP_MESSAGE };
    }
    return { ...result, message: `snapshot unreadable (${error && error.code ? error.code : 'error'})` };
  }
  if (!stat.isFile()) return { ...result, message: 'snapshot path is not a regular file' };
  if (stat.size > MAX_SNAPSHOT_BYTES) {
    return { ...result, message: `snapshot is ${stat.size} bytes (limit ${MAX_SNAPSHOT_BYTES})` };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    return { ...result, message: `snapshot is not valid JSON (${error && error.name ? error.name : 'parse'})` };
  }
  const problems = validateFleet(doc);
  if (problems.length) {
    return { ...result, message: `snapshot failed the v1 contract (${problems.length} problems)`, problems: problems.slice(0, 12) };
  }
  const generated = epochOf(doc.generated_at);
  const age = generated === null ? null : nowS - generated;
  const limit = Number.isFinite(doc.stale_after_s) ? doc.stale_after_s : STALE_AFTER_S;
  if (age === null) return { ...result, fleet: doc, age_s: null, message: 'snapshot has no readable generated_at' };
  return {
    state: age > limit ? 'stale' : 'ok',
    fleet: doc,
    age_s: Math.round(age * 10) / 10,
    path: target,
  };
}

/** Counts the card's summary chips use. Pure; never throws on a valid fleet. */
export function summariseFleet(fleet) {
  const containers = Array.isArray(fleet && fleet.containers) ? fleet.containers : [];
  const exits = Array.isArray(fleet && fleet.exits) ? fleet.exits : [];
  const alerts = Array.isArray(fleet && fleet.alerts) ? fleet.alerts : [];
  const byState = (state) => containers.filter((c) => c.state === state).length;
  return {
    running: byState('running'),
    stopped: byState('stopped') + byState('frozen'),
    other: containers.length - byState('running') - byState('stopped') - byState('frozen'),
    exits_up: exits.filter((e) => e.state === 'up').length,
    exits_down: exits.filter((e) => e.state !== 'up').length,
    alerts: alerts.length,
    critical: alerts.filter((a) => a.severity === 'critical').length,
  };
}

/** `GET /api/fleet` — the only route this module serves. */
export function fleetRoute(req, res, options = {}) {
  const method = String((req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET') {
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' });
      res.end(JSON.stringify({ error: 'method not allowed', allow: 'GET' }));
      return false;
    }
    return false;
  }
  let payload;
  try {
    payload = readFleet(options);
  } catch (error) {
    payload = { state: 'error', message: 'fleet reader failed', problems: [] };
  }
  const body = JSON.stringify({
    state: payload.state,
    age_s: payload.age_s ?? null,
    doctor: payload.doctor ?? null,
    message: payload.message ?? null,
    problems: payload.problems ?? [],
    fleet: payload.fleet ?? null,
  });
  if (res && typeof res.writeHead === 'function') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }
  return true;
}

export default { readFleet, fleetRoute, validateFleet, summariseFleet, snapshotPath };
