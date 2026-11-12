import test from 'node:test';
import assert from 'node:assert/strict';
import { signal, computed, effect } from '../signal.ts';

test('signal/computed/effect', () => {
  const a = signal(1), b = signal(2);
  const sum = computed(() => a() + b());
  const seen = [];
  const stop = effect(() => { seen.push(sum()); });
  a.set(5);
  b.set(10);
  a.set(5); // same value: no rerun
  assert.deepEqual(seen, [3, 7, 15]);
  stop();
  a.set(0);
  assert.deepEqual(seen, [3, 7, 15]);
  assert.equal(sum(), 10);
});
