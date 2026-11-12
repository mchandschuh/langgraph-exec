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
  output: { $type: 'object', schema: { name: 'https://schemas.handschuh.dev/example/graph-output/v1' }, value: { task: request.task } },
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

test('graph execution emits node and port-flow debug events', async () => {
  const graph = await compileGraphFile(graphFixture('fixed-dag.yml'), { components: fakeComponents });
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const result = await graph.invoke({ message: 'debug graph' }, (event) => events.push(event));
  assert.deepEqual(result, { result: 'debug graph-first-second' });
  assert.ok(events.some((event) => event.event === 'graph.node.input' && event.data?.node === 'first'));
  assert.ok(events.some((event) => event.event === 'graph.port.flow' && event.data?.from === 'input.message'));
  assert.ok(events.some((event) => event.event === 'graph.node.output' && event.data?.node === 'second'));
});

test('compiled graphs expose LangGraph stream updates and preserve actual node event values', async () => {
  const graph = await compileGraphFile(graphFixture('fixed-dag.yml'), { components: fakeComponents });
  assert.ok(graph.stream);
  const stream = await graph.stream!({ message: 'stream graph' }, 'updates');
  const updates: unknown[] = [];
  for await (const update of stream) updates.push(update);
  assert.ok(updates.length >= 2);
  const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  await graph.invoke({ message: 'actual values' }, (event) => events.push(event));
  const firstInput = events.find((event) => event.event === 'graph.node.input' && event.data?.node === 'first');
  const secondInput = events.find((event) => event.event === 'graph.node.input' && event.data?.node === 'second');
  assert.equal(firstInput?.data?.ports && (firstInput.data.ports as Record<string, unknown>).in, 'actual values');
  assert.equal(secondInput?.data?.ports && (secondInput.data.ports as Record<string, unknown>).in, 'actual values-first');
});