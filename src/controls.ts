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

export interface JoinContract { readonly branches: readonly string[]; readonly reducers: Readonly<Record<string, 'replace' | 'append' | 'sum' | 'merge'>> }

export function executeJoin(branches: Readonly<Record<string, unknown>>, contract: JoinContract, debug?: DebugSink): JoinedResult {
  const reducers = contract.reducers;
  return joinParallel(branches, contract.branches, (current, next, branch) => {
    const key = Object.entries(branches[branch] as Record<string, unknown>).find(([, value]) => value === next)?.[0];
    const reducer = key ? reducers[key] : undefined;
    if (!reducer || reducer === 'replace') return next;
    if (reducer === 'append') return [...(Array.isArray(current) ? current : []), ...(Array.isArray(next) ? next : [next])];
    if (reducer === 'sum') return Number(current ?? 0) + Number(next ?? 0);
    return { ...(current && typeof current === 'object' ? current : {}), ...(next && typeof next === 'object' ? next : {}) };
  }, debug);
}

export interface SwitchContract { readonly selector: string; readonly cases: Readonly<Record<string, string>>; readonly default: string }
export function selectControlRoute(input: Readonly<Record<string, unknown>>, contract: SwitchContract, debug?: DebugSink): { status: 'selected'; route: string; value: unknown } {
  const parts = contract.selector.split('.'); let value: unknown = input;
  for (const part of parts) { if (!value || typeof value !== 'object' || !(part in value)) { value = undefined; break; } value = (value as Record<string, unknown>)[part]; }
  const route = Object.prototype.hasOwnProperty.call(contract.cases, String(value)) ? contract.cases[String(value)] : contract.default;
  if (!route) throw new ControlNodeError('SWITCH_DEFAULT_MISSING', 'control.switch requires a default route.');
  emit(debug, 'control.switch.selected', { selector: contract.selector, value, route });
  return { status: 'selected', route, value };
}

export async function mapControl<TInput, TOutput>(items: readonly TInput[], mapper: (item: TInput, index: number, debug?: DebugSink) => Promise<TOutput>, maxItems: number, debug?: DebugSink): Promise<{ status: 'success' | 'item_limit_exceeded'; values: readonly TOutput[]; error?: string }> {
  if (!Number.isInteger(maxItems) || maxItems < 0) throw new ControlNodeError('MAP_LIMIT_INVALID', 'maxItems must be a non-negative integer.');
  if (items.length > maxItems) return { status: 'item_limit_exceeded', values: [], error: 'Map item limit exceeded.' };
  emit(debug, 'control.map.start', { items: items.length, maxItems });
  const values = await Promise.all(items.map((item, index) => mapper(item, index, debug)));
  emit(debug, 'control.map.success', { items: values.length, output: values });
  return { status: 'success', values };
}

export async function tryControl<TInput, TOutput>(input: TInput, execute: (input: TInput, debug?: DebugSink) => Promise<TOutput>, debug?: DebugSink): Promise<{ status: 'success' | 'failure'; output?: TOutput; error?: string }> {
  emit(debug, 'control.try.start', { input });
  try { const output = await execute(input, debug); emit(debug, 'control.try.success', { output }); return { status: 'success', output }; }
  catch (error) { const message = error instanceof Error ? error.message.slice(0, 500) : 'Control try body failed.'; emit(debug, 'control.try.failure', { error: message }); return { status: 'failure', error: message }; }
}

export async function retryControl<TInput, TOutput>(input: TInput, execute: (input: TInput, attempt: number, debug?: DebugSink) => Promise<TOutput>, maxAttempts: number, retryable: (error: unknown) => boolean = () => true, debug?: DebugSink): Promise<{ status: 'success' | 'exhausted' | 'failure'; output?: TOutput; attempts: number; error?: string }> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ControlNodeError('RETRY_LIMIT_INVALID', 'maxAttempts must be a positive integer.');
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    emit(debug, 'control.retry.attempt', { attempt, maxAttempts });
    try { const output = await execute(input, attempt, debug); emit(debug, 'control.retry.success', { attempt }); return { status: 'success', output, attempts: attempt }; }
    catch (error) { const message = error instanceof Error ? error.message.slice(0, 500) : 'Retry body failed.'; emit(debug, 'control.retry.failure', { attempt, error: message }); if (!retryable(error)) return { status: 'failure', attempts: attempt, error: message }; if (attempt === maxAttempts) return { status: 'exhausted', attempts: attempt, error: 'Retry attempt limit exhausted.' }; }
  }
  return { status: 'exhausted', attempts: maxAttempts, error: 'Retry attempt limit exhausted.' };
}

export async function timeoutControl<TInput, TOutput>(input: TInput, execute: (input: TInput, signal: AbortSignal, debug?: DebugSink) => Promise<TOutput>, timeoutMs: number, debug?: DebugSink): Promise<{ status: 'success' | 'timeout' | 'failure'; output?: TOutput; error?: string }> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ControlNodeError('TIMEOUT_LIMIT_INVALID', 'timeoutMs must be a positive integer.');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  emit(debug, 'control.timeout.start', { timeoutMs });
  try {
    const result = await Promise.race([
      execute(input, controller.signal, debug).then((output) => ({ status: 'success' as const, output })),
      new Promise<{ status: 'timeout' }>((resolve) => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'timeout' }); }, timeoutMs); }),
    ]);
    emit(debug, `control.timeout.${result.status}`, result);
    return result;
  } catch (error) { const result = { status: 'failure' as const, error: error instanceof Error ? error.message.slice(0, 500) : 'Timed component failed.' }; emit(debug, 'control.timeout.failure', result); return result; }
  finally { if (timer) clearTimeout(timer); }
}