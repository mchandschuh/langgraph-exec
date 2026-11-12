import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LlmRequest, LlmResponse } from 'llm';
import { runConversation } from '../samples/two-llm-conversation/run.js';
import type { ConversationTask } from '../samples/two-llm-conversation/run.js';

const RESPONSE_SCHEMA = 'https://schemas.handschuh.dev/llm/response/v1' as const;
const taskSchema = JSON.parse(await readFile(join(process.cwd(), 'samples/two-llm-conversation/task.schema.json'), 'utf8')) as Record<string, unknown>;
const outputSchema = JSON.parse(await readFile(join(process.cwd(), 'samples/two-llm-conversation/output.schema.json'), 'utf8')) as Record<string, unknown>;

function successResponse(speaker: 'alpha' | 'beta', round: number, message: string): LlmResponse {
  return {
    schema: RESPONSE_SCHEMA,
    status: 'success',
    output: { $type: 'object', schema: { name: 'conversation-output' }, value: { speaker, round, message } },
    failedAttempts: 0,
    iterations: 1,
    errors: [],
  };
}

function failureResponse(status: 'provider_error' | 'output_invalid' | 'attempts_exhausted'): LlmResponse {
  return {
    schema: RESPONSE_SCHEMA,
    status,
    output: null,
    failedAttempts: status === 'provider_error' || status === 'attempts_exhausted' ? 1 : 0,
    iterations: status === 'output_invalid' ? 1 : 0,
    errors: [{ code: status === 'output_invalid' ? 'OUTPUT_SCHEMA_VALIDATION_FAILED' : 'PROVIDER_REQUEST_FAILED', message: `fake ${status}`, phase: status === 'output_invalid' ? 'output-validation' : 'provider' }],
  };
}

test('two-LLM sample alternates alpha then beta for ten rounds with the full transcript', async () => {
  const requests: LlmRequest[] = [];
  const result = await runConversation('Discuss bounded failure handling.', {
    completionService: async (request) => {
      requests.push(request);
      const task = request.task as ConversationTask;
      return successResponse(task.speaker, task.round, `${task.speaker} round ${task.round}; prior=${task.conversation.length}`);
    },
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.rounds, 10);
  assert.equal(result.turnCount, 20);
  assert.equal(result.successfulTurns, 20);
  assert.equal(result.failedTurns, 0);
  assert.deepEqual(result.conversation.slice(0, 4).map((turn) => `${turn.round}:${turn.speaker}`), ['1:alpha', '1:beta', '2:alpha', '2:beta']);
  assert.deepEqual(result.conversation.at(-1), { round: 10, speaker: 'beta', status: 'success', message: 'beta round 10; prior=19' });
  assert.equal(requests.length, 20);
  assert.ok(requests.every((request) => typeof request.task === 'object' && request.taskSchema && request.outputSchema));
  assert.deepEqual(requests[0]!.task, { conversationId: 'sample-two-llm-conversation', openingMessage: 'Discuss bounded failure handling.', round: 1, speaker: 'alpha', conversation: [], instruction: 'Respond as Alpha to the complete conversation. Address Beta when possible and add one concrete idea.' });
  assert.deepEqual(requests[0]!.taskSchema, taskSchema);
  assert.deepEqual(requests[0]!.outputSchema, outputSchema);
  assert.equal((requests[1]!.task as ConversationTask).conversation.length, 1);
  assert.equal((requests[2]!.task as ConversationTask).conversation.length, 2);
});

test('control.retry retries output failures and control.try records exhausted failures', async () => {
  const calls = new Map<string, number>();
  const requests: LlmRequest[] = [];
  const result = await runConversation('Discuss retries.', {
    completionService: async (request) => {
      requests.push(request);
      const task = request.task as ConversationTask;
      const key = `${task.round}:${task.speaker}`;
      const call = (calls.get(key) ?? 0) + 1;
      calls.set(key, call);
      if (task.round === 2 && task.speaker === 'alpha' && call < 3) return failureResponse('output_invalid');
      if (task.round === 3 && task.speaker === 'beta') return failureResponse('provider_error');
      return successResponse(task.speaker, task.round, `${task.speaker} recovered`);
    },
  });

  assert.equal(result.status, 'completed_with_failures');
  assert.equal(result.turnCount, 20);
  assert.equal(result.failedTurns, 1);
  assert.equal(calls.get('2:alpha'), 3);
  assert.equal(calls.get('3:beta'), 3);
  assert.deepEqual(result.conversation.find((turn) => turn.round === 3 && turn.speaker === 'beta'), {
    round: 3,
    speaker: 'beta',
    status: 'failure',
    message: '[beta unavailable after bounded retries]',
    error: {
      code: 'PROVIDER_REQUEST_FAILED',
      status: 'provider_error',
      attempts: 3,
      message: 'fake provider_error',
    },
  });
  const roundThreeAlphaRequest = requests.find((request) => {
    const task = request.task as ConversationTask;
    return task.round === 3 && task.speaker === 'alpha';
  });
  assert.ok(roundThreeAlphaRequest);
  const roundThreeAlphaTask = roundThreeAlphaRequest!.task as ConversationTask;
  assert.deepEqual(roundThreeAlphaTask.conversation.find((turn) => turn.round === 2 && turn.speaker === 'beta'), { round: 2, speaker: 'beta', status: 'success', message: 'beta recovered' });
});