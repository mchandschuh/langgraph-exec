import type { DebugSink } from 'llm';

export const CONTROL_NODE_TYPES = {
  parallel: 'control.parallel',
  join: 'control.join',
  switch: 'control.switch',
  map: 'control.map',
  try: 'control.try',
  retry: 'control.retry',
  timeout: 'control.timeout',
  return: 'control.return',
  fail: 'control.fail',
} as const;

export class ControlNodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message.slice(0, 500)); this.name = 'ControlNodeError'; this.code = code; }
}

function emit(debug: DebugSink | undefined, event: string, data: Record<string, unknown>): void {
  debug?.({ event, timestamp: new Date().toISOString(), data });
}

export interface ParallelBranch<TInput, TOutput> {
  readonly id: string;
  readonly execute: (input: TInput, debug?: DebugSink) => Promise<TOutput>;
}

export interface ParallelResult<TOutput> {
  readonly status: 'success' | 'branch_error' | 'branch_limit_exceeded';
  readonly branches: Readonly<Record<string, TOutput>>;
  readonly error?: { readonly branch: string; readonly message: string };
}

export async function executeParallel<TInput, TOutput>(
  input: TInput,
  branches: readonly ParallelBranch<TInput, TOutput>[],
  maxBranches: number,
  debug?: DebugSink,
): Promise<ParallelResult<TOutput>> {
  if (!Number.isInteger(maxBranches) || maxBranches < 1) throw new ControlNodeError('PARALLEL_LIMIT_INVALID', 'maxBranches must be a positive integer.');
  if (branches.length > maxBranches) return { status: 'branch_limit_exceeded', branches: {}, error: { branch: '*', message: 'Parallel branch limit exceeded.' } };
  if (new Set(branches.map((branch) => branch.id)).size !== branches.length) throw new ControlNodeError('PARALLEL_BRANCH_DUPLICATE', 'Parallel branch identifiers must be unique.');
  emit(debug, 'control.parallel.start', { branchCount: branches.length, maxBranches, branches: branches.map((branch) => branch.id) });
  const entries = await Promise.all(branches.map(async (branch) => {
    emit(debug, 'control.parallel.branch.start', { branch: branch.id });
    try { const value = await branch.execute(input, debug); emit(debug, 'control.parallel.branch.success', { branch: branch.id, output: value }); return [branch.id, { value }] as const; }
    catch (error) { const message = error instanceof Error ? error.message.slice(0, 500) : 'Parallel branch failed.'; emit(debug, 'control.parallel.branch.failure', { branch: branch.id, error: message }); return [branch.id, { error: message }] as const; }
  }));
  const failed = entries.find(([, result]) => 'error' in result);
  if (failed) return { status: 'branch_error', branches: {}, error: { branch: failed[0], message: (failed[1] as { error: string }).error } };
  return { status: 'success', branches: Object.fromEntries(entries.map(([id, result]) => [id, (result as { value: TOutput }).value])) };
}

export interface JoinedResult { readonly status: 'success' | 'missing_branch' | 'merge_error'; readonly value: Record<string, unknown>; readonly error?: string }

export function joinParallel(
  branches: Readonly<Record<string, unknown>>,
  requiredBranches: readonly string[],
  reducer: (current: unknown, next: unknown, branch: string) => unknown = (_current, next) => next,
  debug?: DebugSink,
): JoinedResult {
  for (const branch of requiredBranches) if (!Object.prototype.hasOwnProperty.call(branches, branch)) return { status: 'missing_branch', value: {}, error: `Missing parallel branch '${branch}'.` };
  try {
    const value: Record<string, unknown> = {};
    for (const branch of requiredBranches) {
      const output = branches[branch];
      if (!output || typeof output !== 'object' || Array.isArray(output)) throw new ControlNodeError('JOIN_OUTPUT_INVALID', `Branch '${branch}' output must be an object.`);
      for (const [key, item] of Object.entries(output as Record<string, unknown>)) value[key] = Object.prototype.hasOwnProperty.call(value, key) ? reducer(value[key], item, branch) : item;
    }
    emit(debug, 'control.join.success', { branches: requiredBranches, output: value });
    return { status: 'success', value };
  } catch (error) { return { status: 'merge_error', value: {}, error: error instanceof Error ? error.message : 'Parallel join failed.' }; }
}