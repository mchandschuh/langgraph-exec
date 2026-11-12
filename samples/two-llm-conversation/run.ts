import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { complete, stderrDebugSink } from 'llm';
import type { DebugSink, LlmRequest, LlmResponse } from 'llm';
import { retryControl, tryControl } from '../../src/controls.js';
import { executeNode, parseNodeDefinition } from '../../src/node.js';
import type { CompletionService, NodeDefinition } from '../../src/node.js';

export const CONVERSATION_ROUNDS = 10 as const;
export const MAX_ATTEMPTS_PER_TURN = 3 as const;
export const CONVERSATION_ID = 'sample-two-llm-conversation' as const;

const SAMPLE_DIR = dirname(fileURLToPath(import.meta.url));
const PARTICIPANTS = ['alpha', 'beta'] as const;

export type Participant = (typeof PARTICIPANTS)[number];
export type TurnStatus = 'success' | 'failure';
export type ConversationTask = Readonly<{
  conversationId: typeof CONVERSATION_ID;
  openingMessage: string;
  round: number;
  speaker: Participant;
  conversation: readonly ConversationTurn[];
  instruction: string;
}>;

export interface ConversationTurn {
  readonly round: number;
  readonly speaker: Participant;
  readonly status: TurnStatus;
  readonly message: string;
  readonly error?: {
    readonly code: string;
    readonly status: LlmResponse['status'];
    readonly attempts: number;
    readonly message: string;
  };
}

export interface ConversationResult {
  readonly conversationId: typeof CONVERSATION_ID;
  readonly openingMessage: string;
  readonly rounds: typeof CONVERSATION_ROUNDS;
  readonly status: 'completed' | 'completed_with_failures';
  readonly turnCount: number;
  readonly successfulTurns: number;
  readonly failedTurns: number;
  readonly retryPolicy: { readonly maxAttemptsPerTurn: typeof MAX_ATTEMPTS_PER_TURN };
  readonly conversation: readonly ConversationTurn[];
}

export interface ConversationOptions {
  readonly completionService?: CompletionService;
  readonly debug?: DebugSink;
}

class ConversationTurnError extends Error {
  readonly responseStatus: LlmResponse['status'];
  readonly code: string;

  constructor(code: string, responseStatus: LlmResponse['status'], message: string) {
    super(message.slice(0, 500));
    this.name = 'ConversationTurnError';
    this.responseStatus = responseStatus;
    this.code = code;
  }
}

function isParticipant(value: unknown): value is Participant {
  return PARTICIPANTS.includes(value as Participant);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedMessage(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 1000) : fallback;
}

function retryable(error: unknown): boolean {
  if (!(error instanceof ConversationTurnError)) return true;
  return error.responseStatus === 'provider_error'
    || error.responseStatus === 'output_invalid'
    || error.responseStatus === 'attempts_exhausted';
}

function responseOutput(response: LlmResponse, participant: Participant, round: number): string {
  if (response.status !== 'success') {
    const error = response.errors[0];
    throw new ConversationTurnError(
      error?.code ?? 'LLM_TURN_FAILED',
      response.status,
      error?.message ?? `The ${participant} completion failed.`,
    );
  }
  if (!response.output || response.output.$type !== 'object' || !isRecord(response.output.value)) {
    throw new ConversationTurnError('OUTPUT_INVALID', 'output_invalid', 'The successful LLM response did not contain a structured object.');
  }
  const value = response.output.value;
  if (!isParticipant(value.speaker) || value.speaker !== participant || value.round !== round || typeof value.message !== 'string' || value.message.length === 0) {
    throw new ConversationTurnError('OUTPUT_SCHEMA_VALIDATION_FAILED', 'output_invalid', 'The LLM response did not match the expected speaker, round, and message.');
  }
  return value.message.slice(0, 1000);
}

function taskFor(
  openingMessage: string,
  round: number,
  speaker: Participant,
  conversation: readonly ConversationTurn[],
): ConversationTask {
  return {
    conversationId: CONVERSATION_ID,
    openingMessage,
    round,
    speaker,
    conversation: [...conversation],
    instruction: speaker === 'alpha'
      ? 'Respond as Alpha to the complete conversation. Address Beta when possible and add one concrete idea.'
      : 'Respond as Beta to the complete conversation. Address Alpha and challenge or refine one concrete idea.',
  };
}

function failureTurn(round: number, speaker: Participant, error: unknown, attempts: number): ConversationTurn {
  const turnError = error instanceof ConversationTurnError ? error : undefined;
  const status = turnError?.responseStatus ?? 'provider_error';
  const code = turnError?.code ?? 'LLM_TURN_FAILED';
  const message = boundedMessage(error instanceof Error ? error.message : undefined, 'The LLM turn failed after bounded retries.');
  return {
    round,
    speaker,
    status: 'failure',
    message: `[${speaker} unavailable after bounded retries]`,
    error: { code, status, attempts: Math.max(1, Math.min(attempts, MAX_ATTEMPTS_PER_TURN)), message },
  };
}

async function loadNodes(): Promise<Readonly<Record<Participant, NodeDefinition>>> {
  const [alphaSource, betaSource] = await Promise.all([
    readFile(resolve(SAMPLE_DIR, 'alpha.yml'), 'utf8'),
    readFile(resolve(SAMPLE_DIR, 'beta.yml'), 'utf8'),
  ]);
  return {
    alpha: parseNodeDefinition(alphaSource),
    beta: parseNodeDefinition(betaSource),
  };
}

async function loadSchemas(): Promise<Readonly<Record<'taskSchema' | 'outputSchema', Readonly<Record<string, unknown>>>>> {
  const [taskSource, outputSource] = await Promise.all([
    readFile(resolve(SAMPLE_DIR, 'task.schema.json'), 'utf8'),
    readFile(resolve(SAMPLE_DIR, 'output.schema.json'), 'utf8'),
  ]);
  return {
    taskSchema: JSON.parse(taskSource) as Readonly<Record<string, unknown>>,
    outputSchema: JSON.parse(outputSource) as Readonly<Record<string, unknown>>,
  };
}

function defaultCompletionService(): CompletionService {
  return async (request: LlmRequest, debug?: DebugSink) => (await complete(request, {
    configurationRoot: SAMPLE_DIR,
    debug,
  })) as LlmResponse;
}

async function executeTurn(
  node: NodeDefinition,
  openingMessage: string,
  round: number,
  speaker: Participant,
  conversation: readonly ConversationTurn[],
  service: CompletionService,
  debug?: DebugSink,
): Promise<ConversationTurn> {
  const task = taskFor(openingMessage, round, speaker, conversation);
  const schemas = await loadSchemas();
  let lastError: unknown;
  let attempts = 0;
  const attempted = await tryControl(task, async (input) => {
    const result = await retryControl(input, async (retryInput, attempt) => {
      attempts = attempt;
      try {
        const response = await executeNode(node, { parameters: schemas, input: { task: retryInput } }, service, debug);
        return responseOutput(response, speaker, round);
      } catch (error) {
        lastError = error;
        throw error;
      }
    }, MAX_ATTEMPTS_PER_TURN, retryable, debug);
    if (result.status !== 'success') {
      if (lastError) throw lastError;
      throw new ConversationTurnError('LLM_TURN_FAILED', result.status === 'failure' ? 'provider_error' : 'attempts_exhausted', result.error ?? 'The LLM turn exhausted its retry budget.');
    }
    return result.output as string;
  }, debug);

  if (attempted.status === 'success') return { round, speaker, status: 'success', message: attempted.output as string };
  return failureTurn(round, speaker, lastError ?? new ConversationTurnError('LLM_TURN_FAILED', 'attempts_exhausted', attempted.error ?? 'The LLM turn failed.'), attempts);
}

export async function runConversation(openingMessage: string, options: ConversationOptions = {}): Promise<ConversationResult> {
  if (typeof openingMessage !== 'string' || openingMessage.trim().length === 0) throw new Error('An opening conversation message is required.');
  const nodes = await loadNodes();
  const service = options.completionService ?? defaultCompletionService();
  const conversation: ConversationTurn[] = [];

  for (let round = 1; round <= CONVERSATION_ROUNDS; round += 1) {
    for (const speaker of PARTICIPANTS) {
      conversation.push(await executeTurn(nodes[speaker], openingMessage.trim(), round, speaker, conversation, service, options.debug));
    }
  }

  const failedTurns = conversation.filter((turn) => turn.status === 'failure').length;
  return {
    conversationId: CONVERSATION_ID,
    openingMessage: openingMessage.trim(),
    rounds: CONVERSATION_ROUNDS,
    status: failedTurns === 0 ? 'completed' : 'completed_with_failures',
    turnCount: conversation.length,
    successfulTurns: conversation.length - failedTurns,
    failedTurns,
    retryPolicy: { maxAttemptsPerTurn: MAX_ATTEMPTS_PER_TURN },
    conversation,
  };
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const debugEnabled = args.includes('--debug');
  const cleanArgs = args.filter((arg) => arg !== '--debug');
  if (cleanArgs.length !== 1 || cleanArgs[0] === '--help' || cleanArgs[0] === '-h') {
    console.error('Usage: yarn tsx samples/two-llm-conversation/run.ts [--debug] <opening-message>');
    return cleanArgs.length === 1 && (cleanArgs[0] === '--help' || cleanArgs[0] === '-h') ? 0 : 2;
  }
  try {
    const result = await runConversation(cleanArgs[0]!, { debug: debugEnabled ? stderrDebugSink() : undefined });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message.slice(0, 500) : 'The conversation failed.');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}