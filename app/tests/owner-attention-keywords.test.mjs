// node --test app/tests/owner-attention-keywords.test.mjs : the "clients" attention area matches the word itself
// plus whatever client names the owner keeps in their own config ($AGENTGLIM_DATA/setup.json, "clientKeywords").
// No client name ships with the code: with no config (or a broken one) the list is empty. Each case runs in a
// child process because the keyword list is built once at import, from the data folder in effect at that moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = path.resolve(import.meta.dirname, '..');
const probe = (data, texts) => {
  const code = `const m = await import(${JSON.stringify(path.join(APP, 'owner-attention.mjs'))});
    const texts = ${JSON.stringify(texts)};
    console.log(JSON.stringify({ kw: m.clientKeywords(), areas: texts.map((t) => m.areaOfText(t)) }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: APP, encoding: 'utf8', env: { ...process.env, AGENTGLIM_DATA: data } });
  return JSON.parse(out);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ag-kw-'));

test('no config: no extra keywords, the word "clients" still matches', () => {
  const r = probe(tmp(), ['clients call tomorrow', 'acme said yes', 'the client asked']);
  assert.deepEqual(r.kw, []);
  assert.deepEqual(r.areas, ['clients', null, 'clients']);
});

test('clientKeywords from setup.json match, case-insensitively and literally', () => {
  const data = tmp();
  fs.writeFileSync(path.join(data, 'setup.json'), JSON.stringify({ setupComplete: true, clientKeywords: ['acme', 'Globex Inc', ' a+b (x) ', 7, ''] }));
  const r = probe(data, ['ACME said yes', 'the globex inc renewal', 'quote for a+b (x) stuff', 'aab x', 'unrelated']);
  assert.deepEqual(r.kw, ['acme', 'Globex Inc', 'a+b (x)']);
  assert.deepEqual(r.areas, ['clients', 'clients', 'clients', null, null]);
});

test('a broken setup.json means no extra keywords', () => {
  const data = tmp();
  fs.writeFileSync(path.join(data, 'setup.json'), '{ not json');
  const r = probe(data, ['acme said yes']);
  assert.deepEqual(r.kw, []);
  assert.deepEqual(r.areas, [null]);
});

test('saveSetup keeps the keywords across a Setup save and still validates them', async () => {
  const { clean } = await import('../setup.mjs');
  const out = clean({ clientKeywords: ['acme', '  ', 5, null, 'x'.repeat(80)] });
  assert.deepEqual(out.clientKeywords, ['acme', 'x'.repeat(40)]);
  assert.deepEqual(clean({}).clientKeywords, []);
});
