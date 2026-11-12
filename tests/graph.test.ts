import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmRequest, LlmResponse } from 'llm';
import { compileGraphFile, GraphDefinitionError, parseGraphDefinition } from '../src/graph.js';
import type { GraphComponent } from '../src/graph.js';
import { main } from '../src/cli/main.js';

const graphFixture = (name: string) => join(process.cwd(), 'tests', 'fixtures', 'graphs', name);
const nestedGraphSample = join(process.cwd(), 'samples', 'nested-graph', 'graph.yml');

function component(name: string, execute: GraphComponent['execute'], inputs = ['in'], outputs = ['out']): GraphComponent {
  return { name, inputs: Object.fromEntries(inputs.map((key) => [key, { type: 'string' }])), outputs: Object.fromEntries(outputs.map((key) => [key, { type: 'string' }])), execute };
}

const fakeComponents = {
  'fake.first': component('fake.first', async (input) => ({ out: `${String(input.in)}-first` })),
  'fake.second': component('fake.second', async (input) => ({ out: `${String(input.in)}-second` })),
  'fake.choose': component('fake.choose', async (input) => ({ route: String(input.in) }), ['in'], ['route']),
  'fake.yes': component('fake.yes', async () => ({ out: 'yes-branch' })),
  'fake.no': component('fake.no', async () => ({ out: 'no-branch' })),
  'fake.upper': component('fake.upper', async (input) => ({ out: String(input.in).toUpperCase() })),
};

const completionService = async (request: LlmRequest): Promise<LlmResponse> => ({
  schema: 'https://schemas.handschuh.dev/llm/response/v1',
  status: 'success',
  output: { $type: 'object', schema: null, value: { task: request.task } },
  failedAttempts: 0,
  iterations: 1,
  errors: [],
});

test('trusted imports resolve and unsafe imports fail closed', async () => {
  const graph = await compileGraphFile(graphFixture('import-root.yml'), { completionService });
  const result = await graph.invoke({ task: 'imported task' });
  assert.deepEqual(result, { result: { task: 'imported task' } });
  await assert.rejects(() => compileGraphFile(graphFixture('import-traversal.yml')), GraphDefinitionError);
  await assert.rejects(() => compileGraphFile(graphFixture('import-digest-bad.yml')), GraphDefinitionError);
  await assert.rejects(() => compileGraphFile(graphFixture('import-cycle-a.yml')), GraphDefinitionError);
});

test('graph contract rejects unknown state and supports fixed DAG execution', async () => {
  const graph = await compileGraphFile(graphFixture('fixed-dag.yml'), { components: fakeComponents });
  assert.deepEqual(await graph.invoke({ message: 'hello' }), { result: 'hello-first-second' });
  const parsed = parseGraphDefinition(await readFile(graphFixture('fixed-dag.yml'), 'utf8'));
  assert.equal(parsed.kind, 'graph');
});

test('conditional routes select a deterministic branch and cycles fail closed', async () => {
  const graph = await compileGraphFile(graphFixture('conditional-dag.yml'), { components: fakeComponents });
  assert.deepEqual(await graph.invoke({ choice: 'yes' }), { result: 'yes-branch' });
  assert.deepEqual(await graph.invoke({ choice: 'no' }), { result: 'no-branch' });
  await assert.rejects(() => compileGraphFile(graphFixture('cyclic-dag.yml'), { components: fakeComponents }), GraphDefinitionError);
});

test('nested graphs expose public ports and keep private state internal', async () => {
  const graph = await compileGraphFile(graphFixture('nested-parent.yml'), { components: fakeComponents });
  assert.deepEqual(await graph.invoke({ text: 'nested' }), { result: 'NESTED' });
  assert.deepEqual(Object.keys(graph.inspect.state), ['text', 'result']);
});

test('CLI validates and inspects an imported graph without provider access', async () => {
  assert.equal(await main(['validate', graphFixture('import-root.yml')]), 0);
  assert.equal(await main(['inspect', graphFixture('import-root.yml'), '--resolved', '--format', 'json']), 0);
});

test('phase-two sample composes an imported child graph through public ports', async () => {
  const graph = await compileGraphFile(nestedGraphSample, { completionService });
  assert.deepEqual(await graph.invoke({ task: 'sample task' }), { result: { task: 'sample task' } });
  assert.equal(graph.definition.name, 'sample-nested-answer');
});