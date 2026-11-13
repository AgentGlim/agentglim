// user-config: the owner's own names and rules come from $AGENTGLIM_DATA/setup.json, and the code ships none.
// A fresh install has no client names, no skill-id prefixes, no project icon overrides and no host alias.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostAliases, skillPrefixes, prefixSuffix, projectIcons, safeShape } from '../user-config.mjs';
import { clean } from '../setup.mjs';

const data = (cfg) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-user-config-')); if (cfg) fs.writeFileSync(path.join(d, 'setup.json'), JSON.stringify(cfg)); return d; };

test('missing, empty or malformed config means no extras', () => {
  const empty = data();
  assert.deepEqual(hostAliases(empty), []);
  assert.deepEqual(skillPrefixes(empty), {});
  assert.equal(prefixSuffix('auto', empty), '');
  assert.deepEqual(projectIcons(empty), { paths: {}, kinds: {} });
  const broken = data({ hostAliases: 'observatory', skillPrefixes: ['x'], projectIcons: 7 });
  assert.deepEqual(hostAliases(broken), []);
  assert.deepEqual(skillPrefixes(broken), {});
  assert.deepEqual(projectIcons(broken), { paths: {}, kinds: {} });
  const junk = data({ hostAliases: ['ok-alias', 'bad alias', 'EVIL.example:8090'], skillPrefixes: { auto: ['acme-', ' bad!'], 'not a cat': ['x-'] }, projectIcons: { 'demo-app': { path: '<path d="M2 12h3"/>', kind: 'agents' } } });
  assert.deepEqual(hostAliases(junk), ['ok-alias', 'evil.example']);
  assert.deepEqual(skillPrefixes(junk), { auto: ['acme-'] });
  assert.equal(prefixSuffix('auto', junk), '|^acme-');
  assert.deepEqual(projectIcons(junk), { paths: { 'demo-app': '<path d="M2 12h3"/>' }, kinds: { 'demo-app': 'agents' } });
});

test('a project icon is a plain SVG shape: no scripts, event handlers or images', () => {
  assert.equal(safeShape('<path d="M2 12h3"/><circle cx="1" cy="1" r="1"/>'), '<path d="M2 12h3"/><circle cx="1" cy="1" r="1"/>');
  for (const bad of ['<script>alert(1)</script>', '<path d="M2 12" onclick="x"/>', '<image href="x"/>', "<path d='M2 12'/>", 'plain text', ''])
    assert.equal(safeShape(bad), null, bad);
});

test('a Setup save keeps the owner config keys, validated', () => {
  const out = clean({
    hostAliases: ['observatory', 'bad alias'],
    skillPrefixes: { auto: ['acme-', 5] },
    projectIcons: { 'demo-app': { path: '<path d="M2 12h3"/>', kind: 'agents' }, 'bad name': { path: '<path d="M0 0"/>' } },
  });
  assert.deepEqual(out.hostAliases, ['observatory']);
  assert.deepEqual(out.skillPrefixes, { auto: ['acme-'] });
  assert.deepEqual(out.projectIcons, { 'demo-app': { path: '<path d="M2 12h3"/>', kind: 'agents' } });
  assert.deepEqual(clean({}).hostAliases, []);
});
