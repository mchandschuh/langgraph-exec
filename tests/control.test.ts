import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeJoin, executeParallel, joinParallel } from '../src/controls.js';

test('control.parallel runs bounded branches concurrently and captures outputs', async () => {
  const events: string[] = [];
  const result = await executeParallel('input', [
    { id: 'left', execute: async (input, debug) => { debug?.({ event: 'test.left', timestamp: new Date().toISOString(), data: { input } }); return 'left-result'; } },
    { id: 'right', execute: async () => 'right-result' },
  ], 2, (event) => events.push(event.event));
  assert.equal(result.status, 'success');
  assert.deepEqual(result.branches, { left: 'left-result', right: 'right-result' });
  assert.ok(events.includes('control.parallel.start'));
  assert.ok(events.includes('control.parallel.branch.success'));
});

test('control.parallel rejects duplicate branches and enforces branch limits', async () => {
  await assert.rejects(() => executeParallel(null, [{ id: 'same', execute: async () => 1 }, { id: 'same', execute: async () => 2 }], 2), /unique/);
  const limited = await executeParallel(null, [{ id: 'a', execute: async () => 1 }, { id: 'b', execute: async () => 2 }], 1);
  assert.equal(limited.status, 'branch_limit_exceeded');
});

test('control.join requires all declared branches and merges outputs', () => {
  assert.equal(joinParallel({ left: { value: 1 } }, ['left', 'right']).status, 'missing_branch');
  const joined = joinParallel({ left: { values: [1] }, right: { values: [2] } }, ['left', 'right'], (current, next) => [...(current as number[]), ...(next as number[])]);
  assert.deepEqual(joined, { status: 'success', value: { values: [1, 2] } });
});

test('control.join applies declared reducers at the barrier', () => {
  const joined = executeJoin({ left: { values: [1], total: 2 }, right: { values: [3], total: 4 } }, { branches: ['left', 'right'], reducers: { values: 'append', total: 'sum' } });
  assert.deepEqual(joined, { status: 'success', value: { values: [1, 3], total: 6 } });
});