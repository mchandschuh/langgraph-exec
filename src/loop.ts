import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { CompletionService } from './node.js';
import type { DebugSink } from 'llm';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { executeNode, parseNodeDefinition } from './node.js';
import { adaptCompiledGraph, adaptNodeDefinition, compileGraphFile, GraphDefinitionError } from './graph.js';
import type { CompiledRuntime, ComponentPort, GraphComponent, GraphPort, GraphStateField } from './graph.js';
import { parseStructuredDocument } from './document.js';
import { defaultSchemaRegistry, type SchemaExpression, type SchemaRegistry } from './schema-registry.js';

export const CONTROL_LOOP_SCHEMA = 'https://schemas.handschuh.dev/langgraph-exec/control-loop/v1' as const;
export const LOOP_SCHEMA = CONTROL_LOOP_SCHEMA;

export type ExhaustionPolicy = 'error' | 'return';
export type LoopStatus = 'success' | 'iteration_exhausted' | 'step_budget_exhausted' | 'body_error';

export interface LoopImport { readonly path: string; readonly alias: string; readonly sha256?: string }
export interface LoopBody { readonly component: string; readonly inputs: Readonly<Record<string, string>>; readonly outputs: Readonly<Record<string, string>> }
export interface LoopContract {
  readonly entry: string;
  readonly body: string;
  readonly exit: string;
  readonly condition: string;
  readonly counter: string;
  readonly maxIterations: number;
  readonly maxSteps: number;
  readonly onExhaustion: ExhaustionPolicy;
}
export interface LoopDefinition {
  readonly schema: typeof CONTROL_LOOP_SCHEMA;
  readonly kind: 'control.loop';
  readonly name: string;
  readonly imports: readonly LoopImport[];
  readonly state: Readonly<Record<string, GraphStateField>>;
  readonly ports: { readonly inputs: Readonly<Record<string, GraphPort>>; readonly outputs: Readonly<Record<string, GraphPort>> };
  readonly body: LoopBody;
  readonly loop: LoopContract;
}
export interface LoopResult { readonly status: LoopStatus; readonly output: Readonly<Record<string, unknown>>; readonly iterations: number; readonly steps: number; readonly error?: string }
export interface CompiledLoop extends CompiledRuntime { readonly definition: LoopDefinition; invoke(input: Readonly<Record<string, unknown>>, debug?: DebugSink): Promise<LoopResult> }
export interface LoopCompileOptions { readonly rootDir?: string; readonly components?: Readonly<Record<string, GraphComponent>>; readonly completionService?: CompletionService; readonly debug?: DebugSink; readonly schemaRegistry?: SchemaRegistry }

export class LoopDefinitionError extends Error {
  readonly code = 'LOOP_DEFINITION_INVALID' as const;
  constructor(message: string) { super(message.slice(0, 500)); this.name = 'LoopDefinitionError'; }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown, path: string): Record<string, unknown> { if (!isRecord(value)) throw new LoopDefinitionError(`${path} must be an object.`); return value; }
function string(value: unknown, path: string): string { if (typeof value !== 'string' || value.length === 0) throw new LoopDefinitionError(`${path} must be a non-empty string.`); return value; }
function identifier(value: unknown, path: string): string { const result = string(value, path); if (!IDENTIFIER.test(result)) throw new LoopDefinitionError(`${path} must be a valid identifier.`); return result; }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { const accepted = new Set(allowed); for (const key of Object.keys(value)) if (!accepted.has(key)) throw new LoopDefinitionError(`${path}.${key} is not allowed.`); }
function array(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value)) throw new LoopDefinitionError(`${path} must be an array.`); return value; }
function integer(value: unknown, path: string, min: number, max: number): number { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new LoopDefinitionError(`${path} must be an integer between ${min} and ${max}.`); return value as number; }

function parsePorts(value: unknown, path: string): Record<string, GraphPort> {
  const source = record(value, path); const result: Record<string, GraphPort> = {};
  for (const [name, raw] of Object.entries(source)) { const port = record(raw, `${path}.${name}`); keys(port, ['state', 'type', 'schema', 'required'], `${path}.${name}`); if (port.required !== undefined && typeof port.required !== 'boolean') throw new LoopDefinitionError(`${path}.${name}.required must be boolean.`); result[identifier(name, `${path}.${name}`)] = { state: identifier(port.state, `${path}.${name}.state`), type: string(port.type, `${path}.${name}.type`), ...(port.schema !== undefined ? { schema: port.schema as SchemaExpression } : {}), ...(port.required ? { required: true } : {}) }; }
  return result;
}
function parseState(value: unknown): Record<string, GraphStateField> {
  const state = record(value, 'state'); const fields = own(state, 'fields') ? state.fields : state; const source = record(fields, 'state.fields'); const result: Record<string, GraphStateField> = {};
  for (const [name, raw] of Object.entries(source)) { const field = record(raw, `state.fields.${name}`); keys(field, ['type', 'schema', 'default', 'reducer'], `state.fields.${name}`); const reducer = field.reducer ?? 'replace'; if (!['replace', 'append', 'sum', 'merge'].includes(String(reducer))) throw new LoopDefinitionError(`state.fields.${name}.reducer is unsupported.`); result[identifier(name, `state.fields.${name}`)] = { type: string(field.type, `state.fields.${name}.type`), ...(field.schema !== undefined ? { schema: field.schema as SchemaExpression } : {}), ...(own(field, 'default') ? { default: field.default } : {}), reducer: reducer as GraphStateField['reducer'] }; }
  return result;
}

export function parseLoopDefinition(source: string, filePath = 'loop.yaml', registry?: SchemaRegistry): LoopDefinition {
  let value: unknown;
  try { value = parseStructuredDocument(source, filePath); } catch { throw new LoopDefinitionError('The loop document is not valid JSON/YAML or uses unsupported features.'); }
  const loop = record(value, 'loop'); keys(loop, ['schema', 'kind', 'name', 'imports', 'state', 'ports', 'body', 'loop'], 'loop'); if (loop.schema !== CONTROL_LOOP_SCHEMA) throw new LoopDefinitionError(`schema must be ${CONTROL_LOOP_SCHEMA}.`); if (loop.kind !== 'control.loop') throw new LoopDefinitionError('kind must be control.loop.');
  const imports: LoopImport[] = []; for (const [index, raw] of array(loop.imports ?? [], 'imports').entries()) { const item = record(raw, `imports[${index}]`); keys(item, ['path', 'alias', 'sha256'], `imports[${index}]`); const sha256 = item.sha256 === undefined ? undefined : string(item.sha256, `imports[${index}].sha256`); if (sha256 && !SHA256.test(sha256)) throw new LoopDefinitionError(`imports[${index}].sha256 must be a lowercase SHA-256 digest.`); imports.push({ path: string(item.path, `imports[${index}].path`), alias: identifier(item.alias, `imports[${index}].alias`), ...(sha256 ? { sha256 } : {}) }); }
  if (new Set(imports.map((item) => item.alias)).size !== imports.length) throw new LoopDefinitionError('Import aliases must be unique.');
  const ports = record(loop.ports, 'ports'); keys(ports, ['inputs', 'outputs'], 'ports'); const body = record(loop.body, 'body'); keys(body, ['component', 'inputs', 'outputs'], 'body');
  const contract = record(loop.loop, 'loop'); keys(contract, ['entry', 'body', 'exit', 'condition', 'counter', 'maxIterations', 'maxSteps', 'onExhaustion'], 'loop'); const onExhaustion = contract.onExhaustion ?? 'error'; if (onExhaustion !== 'error' && onExhaustion !== 'return') throw new LoopDefinitionError('loop.onExhaustion must be error or return.');
  const definition = { schema: CONTROL_LOOP_SCHEMA, kind: 'control.loop' as const, name: identifier(loop.name, 'name'), imports, state: parseState(loop.state), ports: { inputs: parsePorts(ports.inputs, 'ports.inputs'), outputs: parsePorts(ports.outputs, 'ports.outputs') }, body: { component: identifier(body.component, 'body.component'), inputs: Object.fromEntries(Object.entries(record(body.inputs, 'body.inputs')).map(([name, path]) => [identifier(name, `body.inputs.${name}`), string(path, `body.inputs.${name}`)])), outputs: Object.fromEntries(Object.entries(record(body.outputs, 'body.outputs')).map(([name, path]) => [identifier(name, `body.outputs.${name}`), string(path, `body.outputs.${name}`)])) }, loop: { entry: identifier(contract.entry, 'loop.entry'), body: identifier(contract.body, 'loop.body'), exit: string(contract.exit, 'loop.exit'), condition: string(contract.condition, 'loop.condition'), counter: identifier(contract.counter, 'loop.counter'), maxIterations: integer(contract.maxIterations, 'loop.maxIterations', 1, 1000), maxSteps: integer(contract.maxSteps, 'loop.maxSteps', 1, 10000), onExhaustion: onExhaustion as ExhaustionPolicy } };
  if (registry) registry.assert(loop, CONTROL_LOOP_SCHEMA, 'loop definition');
  return definition;
}

function pathValue(value: Readonly<Record<string, unknown>>, path: string): unknown { const parts = path.split('.'); if (parts[0] === 'state') parts.shift(); if (parts[0] === 'input') parts.shift(); let current: unknown = value; for (const part of parts) { if (!isRecord(current) || !own(current, part)) return undefined; current = current[part]; } return current; }
function withinRoot(root: string, candidate: string): boolean { const relativePath = relative(root, candidate); return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath); }
function resolveImport(root: string, base: string, path: string): string { if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..')) throw new LoopDefinitionError(`Import path '${path}' is not trusted.`); const candidate = resolve(base, path); if (!withinRoot(root, candidate)) throw new LoopDefinitionError(`Import path '${path}' escapes the trusted root.`); return candidate; }
function digest(source: string): string { return createHash('sha256').update(source).digest('hex'); }
async function loadBody(path: string, root: string, options: LoopCompileOptions, stack: readonly string[], registry: SchemaRegistry): Promise<GraphComponent> { const absolute = resolve(path); if (stack.includes(absolute)) throw new LoopDefinitionError(`Loop body import cycle detected at '${path}'.`); const source = await readFile(absolute, 'utf8'); const parsed = parseStructuredDocument(source, absolute) as Record<string, unknown>; if (parsed.kind === 'node') return adaptNodeDefinition(parseNodeDefinition(source, absolute, registry), options.completionService); if (parsed.kind === 'graph') return adaptCompiledGraph(await compileGraphFile(absolute, { rootDir: root, components: options.components, completionService: options.completionService })); const nested = await compileLoopFile(absolute, options, [...stack, absolute]); return { name: nested.definition.name, inputs: nested.definition.ports.inputs, outputs: nested.definition.ports.outputs, execute: async (input, _state, debug) => (await nested.invoke(input, debug)).output }; }

function validateLoop(definition: LoopDefinition, body: GraphComponent): void { if (definition.loop.entry !== definition.loop.body) throw new LoopDefinitionError('loop.entry and loop.body must identify the declared body node.'); if (definition.loop.exit === definition.loop.body) throw new LoopDefinitionError('loop.exit must be distinct from loop.body.'); if (!definition.state[definition.loop.counter]) throw new LoopDefinitionError(`Loop counter state '${definition.loop.counter}' is not declared.`); if (!definition.state[definition.loop.condition]) throw new LoopDefinitionError(`Loop condition state '${definition.loop.condition}' is not declared.`); if (definition.state[definition.loop.counter].type !== 'integer') throw new LoopDefinitionError('Loop counter state must be integer.'); if (definition.state[definition.loop.condition].type !== 'boolean') throw new LoopDefinitionError('Loop condition state must be boolean.'); for (const [name, path] of Object.entries(definition.body.inputs)) { if (!body.inputs[name]) throw new LoopDefinitionError(`Loop body input '${name}' is not declared by the component.`); if (!path.startsWith('state.') && !path.startsWith('input.')) throw new LoopDefinitionError(`Loop body input '${name}' must reference state or input.`); } for (const [name, path] of Object.entries(definition.body.outputs)) { if (!body.outputs[name]) throw new LoopDefinitionError(`Loop body output '${name}' is not declared by the component.`); if (!path.startsWith('state.')) throw new LoopDefinitionError(`Loop body output '${name}' must write state.`); const field = path.slice(6); if (!definition.state[field]) throw new LoopDefinitionError(`Loop body output '${name}' writes unknown state '${field}'.`); } }

export async function compileLoopFile(filePath: string, options: LoopCompileOptions = {}, stack: readonly string[] = []): Promise<CompiledLoop> {
  const absolute = resolve(filePath);
  const root = resolve(options.rootDir ?? dirname(absolute));
  const source = await readFile(absolute, 'utf8');
  const registry = options.schemaRegistry ?? await defaultSchemaRegistry();
  const definition = parseLoopDefinition(source, absolute, registry);
  const components: Record<string, GraphComponent> = { ...(options.components ?? {}) };
  for (const item of definition.imports) {
    const child = resolveImport(root, dirname(absolute), item.path);
    const childSource = await readFile(child, 'utf8');
    if (item.sha256 && (await digest(childSource)) !== item.sha256) throw new LoopDefinitionError(`Digest mismatch for import '${item.path}'.`);
    components[item.alias] = await loadBody(child, root, options, [...stack, absolute], registry);
  }
  const body = components[definition.body.component];
  if (!body) throw new LoopDefinitionError(`Loop body component '${definition.body.component}' is not resolved.`);
  validateLoop(definition, body);

  const channels: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(definition.state)) channels[name] = Annotation({ reducer: (_left: unknown, right: unknown) => right, default: () => field.default });
  channels.__iterations = Annotation({ reducer: (_left: unknown, right: unknown) => right, default: () => 0 });
  channels.__steps = Annotation({ reducer: (_left: unknown, right: unknown) => right, default: () => 0 });
  channels.__bodyError = Annotation({ reducer: (_left: unknown, right: unknown) => right, default: () => undefined });
  channels.__events = Annotation({ reducer: (left: readonly Record<string, unknown>[], right: readonly Record<string, unknown>[]) => [...left, ...right], default: () => [] });
  const builder = new StateGraph(Annotation.Root(channels as never) as never) as any;
  const bodyNode = async (state: Record<string, unknown>) => {
    if (state.__iterations as number >= definition.loop.maxIterations || state.__steps as number >= definition.loop.maxSteps) return {};
    const bodyInput: Record<string, unknown> = {};
    for (const [name, path] of Object.entries(definition.body.inputs)) bodyInput[name] = pathValue(state, path);
    try {
      const iteration = Number(state.__iterations ?? 0) + 1;
      const step = Number(state.__steps ?? 0) + 1;
      const result = await body.execute(bodyInput, state, options.debug);
      const update: Record<string, unknown> = { __iterations: iteration, __steps: step, __events: [{ event: 'loop.iteration.input', data: { loop: definition.name, iteration, step, body: definition.body.component, ports: bodyInput } }] };
      for (const [name, path] of Object.entries(definition.body.outputs)) update[path.slice(6)] = result[name];
      (update.__events as Record<string, unknown>[]).push({ event: 'loop.iteration.output', data: { loop: definition.name, iteration, step, body: definition.body.component, ports: result } });
      return update;
    } catch (error) {
      const iteration = Number(state.__iterations ?? 0) + 1;
      const step = Number(state.__steps ?? 0) + 1;
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Loop body failed.';
      return { __bodyError: message, __steps: step, __events: [{ event: 'loop.iteration.input', data: { loop: definition.name, iteration, step, body: definition.body.component, ports: bodyInput } }, { event: 'loop.body_error', data: { loop: definition.name, iteration, step, body: definition.body.component, error: message } }] };
    }
  };
  builder.addNode(definition.loop.body, bodyNode);
  builder.addEdge(START, definition.loop.body);
  builder.addConditionalEdges(definition.loop.body, (state: Record<string, unknown>) => {
    if (state.__bodyError) return 'body_error';
    if (state[definition.loop.condition] === true) return END;
    if ((state.__iterations as number) >= definition.loop.maxIterations) return END;
    if ((state.__steps as number) >= definition.loop.maxSteps) return END;
    return definition.loop.body;
  }, { [definition.loop.body]: definition.loop.body, body_error: END, [END]: END });
  const compiled = builder.compile();

  return {
    definition,
    inspect: { schema: definition.schema, kind: definition.kind, name: definition.name, imports: definition.imports, state: definition.state, ports: definition.ports, body: definition.body, loop: definition.loop, resolution: { providerAccess: 'none', bounded: true, backend: 'langgraph-stategraph' } },
    async invoke(input, debug) {
      const initial: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(definition.state)) initial[name] = field.default;
      for (const [name, port] of Object.entries(definition.ports.inputs)) if (own(input as Record<string, unknown>, name)) initial[port.state] = input[name];
      const state = await compiled.invoke(initial, { recursionLimit: definition.loop.maxSteps + 2 });
      const iterations = Number(state.__iterations ?? 0);
      const steps = Number(state.__steps ?? 0);
      const output = Object.fromEntries(Object.entries(definition.ports.outputs).map(([name, port]) => [name, state[port.state]]));
      const status: LoopStatus = state.__bodyError ? 'body_error' : state[definition.loop.condition] === true ? 'success' : iterations >= definition.loop.maxIterations ? 'iteration_exhausted' : 'step_budget_exhausted';
      const result: LoopResult = { status, output, iterations, steps, ...(state.__bodyError ? { error: state.__bodyError as string } : {}), ...(status === 'iteration_exhausted' && definition.loop.onExhaustion === 'error' ? { error: 'Loop maximum iterations exhausted.' } : {}), ...(status === 'step_budget_exhausted' ? { error: 'Graph maximum step budget exhausted.' } : {}) };
      debug?.({ event: 'loop.start', timestamp: new Date().toISOString(), data: { loop: definition.name, maxIterations: definition.loop.maxIterations, maxSteps: definition.loop.maxSteps, onExhaustion: definition.loop.onExhaustion } });
      for (const event of (state.__events as Array<{ event: string; data: Record<string, unknown> }> | undefined) ?? []) debug?.({ event: event.event, timestamp: new Date().toISOString(), data: event.data });
      debug?.({ event: status === 'success' ? 'loop.exit' : status === 'body_error' ? 'loop.body_error' : 'loop.exhaustion', timestamp: new Date().toISOString(), data: result });
      return result;
    },
    async stream(input, mode = 'updates') {
      const initial: Record<string, unknown> = {};
      for (const [name, field] of Object.entries(definition.state)) initial[name] = field.default;
      for (const [name, port] of Object.entries(definition.ports.inputs)) if (own(input as Record<string, unknown>, name)) initial[port.state] = input[name];
      return compiled.stream(initial, { streamMode: mode });
    },
  };
}

export async function validateLoopFile(filePath: string, options: Pick<LoopCompileOptions, 'rootDir' | 'schemaRegistry'> = {}): Promise<LoopDefinition> {
  const absolute = resolve(filePath);
  const source = await readFile(absolute, 'utf8');
  const registry = options.schemaRegistry ?? await defaultSchemaRegistry();
  return parseLoopDefinition(source, absolute, registry);
}
