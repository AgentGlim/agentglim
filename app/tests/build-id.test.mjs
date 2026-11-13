// Auto-reload support (owner 2026-11-13): the page carries the build id of the code the server served (agBuild
// meta tag, /api/build, every snapshot). A new id means new page code is deployed, and only then does the page
// reload itself. A restart alone must not change the id, or every restart would reload every open page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeBuildId, PAGE_FILES } from '../build-id.mjs';
import { fixtureServer } from './helpers/fixture-server.mjs';

const HEX12 = /^[0-9a-f]{12}$/;

test('build id is a hash of the page files: stable while they are, new when one changes', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentglim-build-'));
  for (const f of PAGE_FILES) fs.writeFileSync(path.join(d, f), `${f}\n`);
  let now = 0;
  const id = makeBuildId(d, { cacheMs: 1000, now: () => now });

  const first = id();
  assert.match(first, HEX12);
  assert.equal(id(), first, 'cached inside cacheMs');
  now += 5000;
  assert.equal(id(), first, 'nothing changed: same id');

  fs.writeFileSync(path.join(d, 'index.html'), 'index.html with new page code\n');
  now += 5000;
  const second = id();
  assert.match(second, HEX12);
  assert.notEqual(second, first, 'new page code: new id');

  now += 5000;
  assert.equal(id(), second, 'stable again');

  fs.unlinkSync(path.join(d, 'theme.js'));
  now += 5000;
  assert.notEqual(id(), second, 'a missing asset is a change too');

  const archive = path.join(os.tmpdir(), '_archive');
  fs.mkdirSync(archive, { recursive: true });
  fs.renameSync(d, path.join(archive, `${path.basename(d)}-${Date.now()}`));
});

test('server: /api/build, the served page and every snapshot carry the same build id', async (t) => {
  const fixture = fixtureServer('ag-build-');
  t.after(() => fixture.close());
  const base = await fixture.start();

  const build = await (await fetch(base + '/api/build')).json();
  assert.match(build.build, HEX12);
  assert.ok(build.started, 'the page can tell a restart from a deploy');

  const html = await (await fetch(base + '/')).text();
  const stamped = html.match(/<meta name="agBuild" content="([0-9a-f]{12})">/);
  assert.ok(stamped, 'the served page is stamped with its own build id');
  assert.equal(stamped[1], build.build);

  const snap = await (await fetch(base + '/api/snapshot')).json();
  assert.equal(snap.build, build.build, 'the stream carries it too');
});
