import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureServer } from './helpers/fixture-server.mjs';

test('/api/prefs defaults dark, guards writes, validates input and survives a server restart', async (t) => {
  const fixture = fixtureServer('ag-prefs-');
  t.after(() => fixture.close());
  let base = await fixture.start();
  const get = async () => {
    const response = await fetch(base + '/api/prefs');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.json();
  };
  const put = (body, headers = { origin: base, 'content-type': 'application/json' }) =>
    fetch(base + '/api/prefs', { method: 'PUT', headers, body });
  const file = path.join(fixture.data, 'prefs.json');
  assert.deepEqual(await get(), { theme: 'dark' });
  assert.equal(fs.existsSync(file), false, 'reading defaults does not create a prefs file');
  for (const headers of [
    { 'content-type': 'application/json' },
    { origin: 'https://evil.example', 'content-type': 'application/json' },
    { origin: base, 'content-type': 'text/plain' },
    { origin: base, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  ]) assert.equal((await put('{"theme":"light"}', headers)).status, 403);
  assert.equal((await fetch(base + '/api/prefs', { method: 'POST' })).status, 405);
  assert.equal((await put('not json')).status, 400);
  for (const body of [null, [], {}, { theme: 'system' }, { theme: 1 }, { theme: 'light', path: 'elsewhere' }]) {
    assert.equal((await put(JSON.stringify(body))).status, 422);
  }
  assert.equal((await put('x'.repeat(2048))).status, 413);
  assert.equal(fs.existsSync(file), false, 'rejected writes do not create prefs');
  const saved = await put('{"theme":"light"}');
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { theme: 'light' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'light' });
  await fixture.stop();
  base = await fixture.start();
  assert.deepEqual(await get(), { theme: 'light' }, 'disk preference survives a new process');
  assert.equal((await put('{"theme":"dark"}')).status, 200);
  assert.deepEqual(await get(), { theme: 'dark' });
  fs.writeFileSync(file, 'broken json');
  assert.deepEqual(await get(), { theme: 'dark' }, 'invalid saved JSON falls back to dark');
});
