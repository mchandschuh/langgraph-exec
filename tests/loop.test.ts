import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { compileLoopFile, LoopDefinitionError, parseLoopDefinition } from '../src/loop.js';
import type { GraphComponent } from '../src/graph.js';

const fixture = (name: string) => join(process.cwd(), 'tests', 'fixtures', 'loops', name);
const sample = (name: string) => join(process.cwd(), 'samples', 'bounded-loop', name);
const component = (name: string, execute: GraphComponent['execute'], inputs = ['value'], outputs = ['value', 'done', 'iterations']): GraphComponent => ({ name, inputs: Object.fromEntries(inputs.map((key) => [key, { type: key === 'value' ? 'integer' : 'boolean' }])), outputs: Object.fromEntries(outputs.map((key) => [key, { type: key === 'iterations' ? 'integer' : key === 'value' ? 'integer' : 'boolean' }])), execute });

const fake = {
  'fake.increment-until-two': component('fake.increment-until-two', async (input) => { const value = Number(input.value ?? 0) + 1; return { value, done: value >= 2, iterations: value }; }),
  'fake.never-done': component('fake.never-done', async (input) => ({ value: Number(input.value ?? 0) + 1, done: false, iterations: Number(input.iterations ?? 0) + 1 })),
  'fake.loop-body': component('fake.loop-body', async (input) => ({ out: String(input.in ?? 'nested'), done: true, iterations: 1 }), ['in'], ['out', 'done', 'iterations']),
};

test('valid loop exits early with deterministic counters', async () => {
  const loop = await compileLoopFile(fixture('early-exit.yml'), { components: fake });
  const result = await loop.invoke({});
  assert.equal(result.status, 'success');
  assert.equal(result.iterations, 2);
  assert.equal(result.steps, 2);
  assert.equal(result.output.value, 2);
});

test('loop exhaustion and max-step budgets are distinct bounded outcomes', async () => {
  const exhausted = await compileLoopFile(fixture('exhaustion.yml'), { components: fake });
  const exhaustedResult = await exhausted.invoke({});
  assert.equal(exhaustedResult.status, 'iteration_exhausted');
  assert.equal(exhaustedResult.iterations, 3);

  const budget = await compileLoopFile(fixture('step-budget.yml'), { components: fake });
  const budgetResult = await budget.invoke({});
  assert.equal(budgetResult.status, 'step_budget_exhausted');
  assert.equal(budgetResult.steps, 2);
});

test('invalid loop contracts fail before execution', async () => {
  assert.throws(() => parseLoopDefinition('kind: loop\nschema: https://schemas.handschuh.dev/langgraph-exec/loop/v1\nname: bad'), LoopDefinitionError);
  await assert.rejects(() => compileLoopFile(fixture('invalid-missing-limit.yml'), { components: fake }), LoopDefinitionError);
});

test('nested graph loop bodies compose through public ports', async () => {
  const loop = await compileLoopFile(fixture('loop-nested-graph.yml'), { components: fake });
  const result = await loop.invoke({ text: 'nested' });
  assert.equal(result.status, 'success');
  assert.equal(result.output.result, 'nested');
});

test('loop inspection is provider-free and exposes effective limits', async () => {
  const loop = await compileLoopFile(fixture('early-exit.yml'), { components: fake });
  assert.equal(loop.inspect.kind, 'loop');
  assert.deepEqual(loop.inspect.loop, { entry: 'body', body: 'body', exit: 'done', condition: 'done', counter: 'iterations', maxIterations: 5, maxSteps: 10, onExhaustion: 'error' });
});

test('bounded-loop sample is a real inspectable loop artifact', async () => {
  const loop = await compileLoopFile(sample('loop.yml'), { components: fake });
  assert.equal(loop.definition.name, 'sample-bounded-loop');
  assert.equal(loop.definition.loop.maxSteps, 6);
  assert.equal(loop.inspect.resolution && (loop.inspect.resolution as Record<string, unknown>).bounded, true);
});