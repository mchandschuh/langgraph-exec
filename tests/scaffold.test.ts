import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli/main.js';

test('CLI help is provider-free and succeeds', async () => {
  assert.equal(await main(['--help']), 0);
});

test('CLI version is provider-free and succeeds', async () => {
  assert.equal(await main(['--version']), 0);
});

test('execution command reports a missing component with a stable nonzero result', async () => {
  assert.equal(await main(['run', 'example.yml', '--input', 'input.json']), 1);
});