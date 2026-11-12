import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseNodeDefinition, resolveRequest } from '../src/node.js';
import { SchemaRegistry } from '../src/schema-registry.js';
import { main } from '../src/cli/main.js';

const customSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://schemas.handschuh.dev/test/contract/v1',
  title: 'Test contract',
  description: 'A test contract used to verify registry and oneOf behavior.',
  oneOf: [
    { type: 'object', required: ['kind'], properties: { kind: { const: 'object' } }, additionalProperties: true },
    { type: 'string', minLength: 3 },
  ],
  examples: [{ kind: 'object' }, 'text'],
};

async function registryFile(): Promise<{ file: string; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'langgraph-exec-schema-'));
  await writeFile(join(directory, 'contract.schema.json'), JSON.stringify(customSchema));
  const file = join(directory, 'paths.txt');
  await writeFile(file, `# custom schema directories\n${directory}\n`);
  return { file, directory };
}

test('schema registry discovers directories from a text registry file', async () => {
  const { file } = await registryFile();
  const registry = await SchemaRegistry.load({ includeDefaults: false, registryFile: file });
  assert.equal(registry.has(customSchema.$id), true);
  assert.deepEqual(registry.validate('okay', customSchema.$id), []);
  assert.notDeepEqual(registry.validate('x', customSchema.$id), []);
});

test('node parameter schema supports oneOf and external registry references', async () => {
  const { file } = await registryFile();
  const registry = await SchemaRegistry.load({ registryFile: file });
  const node = parseNodeDefinition(`schema: https://schemas.handschuh.dev/langgraph-exec/node/v1
kind: node
name: schema-node
implementation: llm.complete
parameters:
  provider: { type: string, default: openrouter }
  model: { type: string, default: openai/gpt-5.6-luna }
  thinking: { type: string, default: high }
  maxFailedAttempts: { type: integer, default: 0 }
  maxIterations: { type: integer, default: 1 }
  systemPrompt: { type: string, default: test }
  task: { type: object, schema: https://schemas.handschuh.dev/test/contract/v1, required: true }
  responseSchema: { type: string, default: https://schemas.handschuh.dev/llm/response/v1 }
ports:
  inputs: { task: { type: object, required: true } }
  outputs: { response: { type: object, required: true } }
bindings:
  provider: parameter.provider
  model: parameter.model
  thinking: parameter.thinking
  maxFailedAttempts: parameter.maxFailedAttempts
  maxIterations: parameter.maxIterations
  task: parameter.task
  systemPrompt: parameter.systemPrompt
`, 'schema-node.yaml', registry);
  assert.deepEqual(resolveRequest(node, { input: {}, parameters: { task: { kind: 'object' } } }, registry).task, { kind: 'object' });
  assert.throws(() => resolveRequest(node, { input: {}, parameters: { task: 1 as unknown as Record<string, unknown> } }, registry), /must be an object/);
});

test('CLI lists built-in and configured registry schemas', async () => {
  const { file } = await registryFile();
  assert.equal(await main(['schemas', '--schema-registry', file]), 0);
});