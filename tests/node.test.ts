import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmRequest, LlmResponse } from 'llm';
import { executeNode, inspectNode, parseNodeDefinition, resolveRequest } from '../src/node.js';
import { main } from '../src/cli/main.js';

const fixture = (name: string) => join(process.cwd(), 'tests', 'fixtures', name);
const load = async (name: string) => parseNodeDefinition(await readFile(fixture(name), 'utf8'));

const successResponse: LlmResponse = {
  schema: 'https://schemas.handschuh.dev/llm/response/v1',
  status: 'success',
  output: { $type: 'string', schema: null, value: 'deterministic answer' },
  failedAttempts: 0,
  iterations: 1,
  errors: [],
};

test('valid direct-node YAML exposes implementation, parameters, and ports', async () => {
  const node = await load('valid-node.yaml');
  assert.equal(node.implementation, 'llm.complete');
  assert.equal(node.parameters.model.default, 'openai/gpt-5.6-luna');
  assert.equal(node.ports.inputs.task.required, true);
  assert.deepEqual(Object.keys(node.ports.outputs), ['response']);
  assert.equal(inspectNode(node).kind, 'node');
});

test('malformed YAML and unknown fields are rejected before execution', async () => {
  await assert.rejects(() => load('invalid-yaml.yaml'), /not valid/);
  await assert.rejects(() => load('unknown-field.yaml'), /unexpected is not allowed/);
});

test('parameter defaults and explicit overrides resolve into the final request', async () => {
  const node = await load('valid-node.yaml');
  const defaultRequest = resolveRequest(node, { input: { task: 'default task' } });
  assert.equal(defaultRequest.model, 'openai/gpt-5.6-luna');
  assert.equal(defaultRequest.maxIterations, 2);
  assert.equal(defaultRequest.task, 'default task');

  const overriddenRequest = resolveRequest(node, {
    parameters: { model: 'anthropic/claude-sonnet-4', maxIterations: 1 },
    input: { task: 'overridden task' },
  });
  assert.equal(overriddenRequest.model, 'anthropic/claude-sonnet-4');
  assert.equal(overriddenRequest.maxIterations, 1);
  assert.equal(overriddenRequest.task, 'overridden task');
});

test('fake completion service captures llm request and returns response envelope', async () => {
  const node = await load('valid-node.yaml');
  let captured: LlmRequest | undefined;
  const service = async (request: LlmRequest): Promise<LlmResponse> => {
    captured = request;
    return successResponse;
  };
  const response = await executeNode(node, { input: { task: 'capture me' } }, service);
  assert.deepEqual(response, successResponse);
  assert.equal(captured?.schema, 'https://schemas.handschuh.dev/llm/request/v1');
  assert.equal(captured?.task, 'capture me');
  assert.equal(captured?.systemPrompt, 'Return a concise answer.');

  const providerError = await executeNode(node, { input: { task: 'fail me' } }, async () => {
    throw new Error('provider details must not escape');
  });
  assert.equal(providerError.status, 'provider_error');
  assert.equal(providerError.errors[0]?.message, 'The provider request failed before a usable response was returned.');
});

test('invalid runtime input returns a bounded input-invalid response', async () => {
  const node = await load('valid-node.yaml');
  const response = await executeNode(node, { input: {} });
  assert.equal(response.status, 'input_invalid');
  assert.equal(response.failedAttempts, 0);
});

test('CLI validate and inspect remain provider-free and invalid input is nonzero', async () => {
  assert.equal(await main(['validate', fixture('valid-node.yaml')]), 0);
  assert.equal(await main(['inspect', fixture('valid-node.yaml'), '--resolved', '--format', 'json']), 0);
  assert.equal(await main(['validate', fixture('invalid-yaml.yaml')]), 1);
});