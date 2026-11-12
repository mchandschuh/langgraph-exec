import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { CompletionService } from './node.js';
import type { DebugSink } from 'llm';
import { executeNode, parseNodeDefinition } from './node.js';
import { compileGraphFile, GraphDefinitionError } from './graph.js';
import type { ComponentPort, GraphComponent, GraphPort, GraphStateField } from './graph.js';

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
export interface CompiledLoop { readonly definition: LoopDefinition; readonly inspect: Record<string, unknown>; invoke(input: Readonly<Record<string, unknown>>, debug?: DebugSink): Promise<LoopResult> }
export interface LoopCompileOptions { readonly rootDir?: string; readonly components?: Readonly<Record<string, GraphComponent>>; readonly completionService?: CompletionService; readonly debug?: DebugSink }

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
  for (const [name, raw] of Object.entries(source)) { const port = record(raw, `${path}.${name}`); keys(port, ['state', 'type', 'required'], `${path}.${name}`); if (port.required !== undefined && typeof port.required !== 'boolean') throw new LoopDefinitionError(`${path}.${name}.required must be boolean.`); result[identifier(name, `${path}.${name}`)] = { state: identifier(port.state, `${path}.${name}.state`), type: string(port.type, `${path}.${name}.type`), ...(port.required ? { required: true } : {}) }; }
  return result;
}
function parseState(value: unknown): Record<string, GraphStateField> {
  const state = record(value, 'state'); const fields = own(state, 'fields') ? state.fields : state; const source = record(fields, 'state.fields'); const result: Record<string, GraphStateField> = {};
  for (const [name, raw] of Object.entries(source)) { const field = record(raw, `state.fields.${name}`); keys(field, ['type', 'default', 'reducer'], `state.fields.${name}`); const reducer = field.reducer ?? 'replace'; if (!['replace', 'append', 'sum', 'merge'].includes(String(reducer))) throw new LoopDefinitionError(`state.fields.${name}.reducer is unsupported.`); result[identifier(name, `state.fields.${name}`)] = { type: string(field.type, `state.fields.${name}.type`), ...(own(field, 'default') ? { default: field.default } : {}), reducer: reducer as GraphStateField['reducer'] }; }
  return result;
}

export function parseLoopDefinition(source: string): LoopDefinition {
  let value: unknown;
  try { const document = parseDocument(source, { schema: 'core', strict: true, uniqueKeys: true }); if (document.errors.length > 0) throw document.errors[0]; value = document.toJS({ maxAliasCount: 0 }); } catch { throw new LoopDefinitionError('The loop YAML is not valid or uses unsupported YAML features.'); }
  const loop = record(value, 'loop'); keys(loop, ['schema', 'kind', 'name', 'imports', 'state', 'ports', 'body', 'loop'], 'loop'); if (loop.schema !== CONTROL_LOOP_SCHEMA) throw new LoopDefinitionError(`schema must be ${CONTROL_LOOP_SCHEMA}.`); if (loop.kind !== 'control.loop') throw new LoopDefinitionError('kind must be control.loop.');
  const imports: LoopImport[] = []; for (const [index, raw] of array(loop.imports ?? [], 'imports').entries()) { const item = record(raw, `imports[${index}]`); keys(item, ['path', 'alias', 'sha256'], `imports[${index}]`); const sha256 = item.sha256 === undefined ? undefined : string(item.sha256, `imports[${index}].sha256`); if (sha256 && !SHA256.test(sha256)) throw new LoopDefinitionError(`imports[${index}].sha256 must be a lowercase SHA-256 digest.`); imports.push({ path: string(item.path, `imports[${index}].path`), alias: identifier(item.alias, `imports[${index}].alias`), ...(sha256 ? { sha256 } : {}) }); }
  if (new Set(imports.map((item) => item.alias)).size !== imports.length) throw new LoopDefinitionError('Import aliases must be unique.');
  const ports = record(loop.ports, 'ports'); keys(ports, ['inputs', 'outputs'], 'ports'); const body = record(loop.body, 'body'); keys(body, ['component', 'inputs', 'outputs'], 'body');
  const contract = record(loop.loop, 'loop'); keys(contract, ['entry', 'body', 'exit', 'condition', 'counter', 'maxIterations', 'maxSteps', 'onExhaustion'], 'loop'); const onExhaustion = contract.onExhaustion ?? 'error'; if (onExhaustion !== 'error' && onExhaustion !== 'return') throw new LoopDefinitionError('loop.onExhaustion must be error or return.');
  return { schema: CONTROL_LOOP_SCHEMA, kind: 'control.loop', name: identifier(loop.name, 'name'), imports, state: parseState(loop.state), ports: { inputs: parsePorts(ports.inputs, 'ports.inputs'), outputs: parsePorts(ports.outputs, 'ports.outputs') }, body: { component: identifier(body.component, 'body.component'), inputs: Object.fromEntries(Object.entries(record(body.inputs, 'body.inputs')).map(([name, path]) => [identifier(name, `body.inputs.${name}`), string(path, `body.inputs.${name}`)])), outputs: Object.fromEntries(Object.entries(record(body.outputs, 'body.outputs')).map(([name, path]) => [identifier(name, `body.outputs.${name}`), string(path, `body.outputs.${name}`)])) }, loop: { entry: identifier(contract.entry, 'loop.entry'), body: identifier(contract.body, 'loop.body'), exit: string(contract.exit, 'loop.exit'), condition: string(contract.condition, 'loop.condition'), counter: identifier(contract.counter, 'loop.counter'), maxIterations: integer(contract.maxIterations, 'loop.maxIterations', 1, 1000), maxSteps: integer(contract.maxSteps, 'loop.maxSteps', 1, 10000), onExhaustion: onExhaustion as ExhaustionPolicy } };
}

function pathValue(value: Readonly<Record<string, unknown>>, path: string): unknown { const parts = path.split('.'); if (parts[0] === 'state') parts.shift(); if (parts[0] === 'input') parts.shift(); let current: unknown = value; for (const part of parts) { if (!isRecord(current) || !own(current, part)) return undefined; current = current[part]; } return current; }
function withinRoot(root: string, candidate: string): boolean { const relativePath = relative(root, candidate); return relativePath !== '' && !relativePath.startsWith('..') && !isAbsolute(relativePath); }
function resolveImport(root: string, base: string, path: string): string { if (isAbsolute(path) || path.split(/[\\/]/).some((part) => part === '..')) throw new LoopDefinitionError(`Import path '${path}' is not trusted.`); const candidate = resolve(base, path); if (!withinRoot(root, candidate)) throw new LoopDefinitionError(`Import path '${path}' escapes the trusted root.`); return candidate; }
function digest(source: string): string { return createHash('sha256').update(source).digest('hex'); }
function nodeComponent(definition: ReturnType<typeof parseNodeDefinition>, completionService?: CompletionService): GraphComponent { return { name: definition.name, inputs: definition.ports.inputs as Readonly<Record<string, ComponentPort>>, outputs: definition.ports.outputs as Readonly<Record<string, ComponentPort>>, async execute(input) { const response = await executeNode(definition, { input }, completionService); if (response.status !== 'success') throw new LoopDefinitionError(response.errors[0]?.message ?? 'Loop body failed.'); return { response: response.output?.value ?? response.output }; } }; }

async function loadBody(path: string, root: string, options: LoopCompileOptions, stack: readonly string[]): Promise<GraphComponent> { const absolute = resolve(path); if (stack.includes(absolute)) throw new LoopDefinitionError(`Loop import cycle detected at '${absolute}'.`); const source = await readFile(absolute, 'utf8'); const parsed = parseDocument(source, { schema: 'core', strict: true }).toJS({ maxAliasCount: 0 }) as Record<string, unknown>; if (parsed.kind === 'node') return nodeComponent(parseNodeDefinition(source), options.completionService); if (parsed.kind === 'graph') { const graph = await compileGraphFile(absolute, { rootDir: root, components: options.components, completionService: options.completionService }); return { name: graph.definition.name, inputs: graph.definition.ports.inputs, outputs: graph.definition.ports.outputs, execute: (input, _state, debug) => graph.invoke(input, debug) }; } const nested = await compileLoopFile(absolute, options, [...stack, absolute]); return { name: nested.definition.name, inputs: nested.definition.ports.inputs, outputs: nested.definition.ports.outputs, execute: async (input, _state, debug) => (await nested.invoke(input, debug)).output }; }

function validateLoop(definition: LoopDefinition, body: GraphComponent): void { if (definition.loop.entry !== definition.loop.body) throw new LoopDefinitionError('loop.entry and loop.body must identify the declared body node.'); if (definition.loop.exit === definition.loop.body) throw new LoopDefinitionError('loop.exit must be distinct from loop.body.'); if (!definition.state[definition.loop.counter]) throw new LoopDefinitionError(`Loop counter state '${definition.loop.counter}' is not declared.`); if (!definition.state[definition.loop.condition]) throw new LoopDefinitionError(`Loop condition state '${definition.loop.condition}' is not declared.`); if (definition.state[definition.loop.counter].type !== 'integer') throw new LoopDefinitionError('Loop counter state must be integer.'); if (definition.state[definition.loop.condition].type !== 'boolean') throw new LoopDefinitionError('Loop condition state must be boolean.'); for (const [name, path] of Object.entries(definition.body.inputs)) { if (!body.inputs[name]) throw new LoopDefinitionError(`Loop body input '${name}' is not declared by the component.`); if (!path.startsWith('state.') && !path.startsWith('input.')) throw new LoopDefinitionError(`Loop body input '${name}' must reference state or input.`); } for (const [name, path] of Object.entries(definition.body.outputs)) { if (!body.outputs[name]) throw new LoopDefinitionError(`Loop body output '${name}' is not declared by the component.`); if (!path.startsWith('state.')) throw new LoopDefinitionError(`Loop body output '${name}' must write state.`); const field = path.slice(6); if (!definition.state[field]) throw new LoopDefinitionError(`Loop body output '${name}' writes unknown state '${field}'.`); } }

export async function compileLoopFile(filePath: string, options: LoopCompileOptions = {}, stack: readonly string[] = []): Promise<CompiledLoop> { const absolute = resolve(filePath); const root = resolve(options.rootDir ?? dirname(absolute)); const source = await readFile(absolute, 'utf8'); const definition = parseLoopDefinition(source); const components: Record<string, GraphComponent> = { ...(options.components ?? {}) }; for (const item of definition.imports) { const child = resolveImport(root, dirname(absolute), item.path); const childSource = await readFile(child, 'utf8'); if (item.sha256 && (await digest(childSource)) !== item.sha256) throw new LoopDefinitionError(`Digest mismatch for import '${item.path}'.`); components[item.alias] = await loadBody(child, root, options, [...stack, absolute]); } const body = components[definition.body.component]; if (!body) throw new LoopDefinitionError(`Loop body component '${definition.body.component}' is not resolved.`); validateLoop(definition, body); return { definition, inspect: { schema: definition.schema, kind: definition.kind, name: definition.name, imports: definition.imports, state: definition.state, ports: definition.ports, body: definition.body, loop: definition.loop, resolution: { providerAccess: 'none', bounded: true } }, async invoke(input, debug) { const emit = (event: string, data: Record<string, unknown>) => { if (debug) debug({ event, timestamp: new Date().toISOString(), data }); }; const state: Record<string, unknown> = {}; for (const [name, field] of Object.entries(definition.state)) state[name] = field.default; for (const [name, port] of Object.entries(definition.ports.inputs)) if (own(input as Record<string, unknown>, name)) state[port.state] = input[name]; let iterations = 0; let steps = 0; emit('loop.start', { loop: definition.name, maxIterations: definition.loop.maxIterations, maxSteps: definition.loop.maxSteps, onExhaustion: definition.loop.onExhaustion }); while (true) { if (state[definition.loop.condition] === true) { const result = { status: 'success' as const, output: Object.fromEntries(Object.entries(definition.ports.outputs).map(([name, port]) => [name, state[port.state]])), iterations, steps }; emit('loop.exit', result); return result; } if (iterations >= definition.loop.maxIterations) { const result = { status: 'iteration_exhausted' as const, output: Object.fromEntries(Object.entries(definition.ports.outputs).map(([name, port]) => [name, state[port.state]])), iterations, steps, ...(definition.loop.onExhaustion === 'error' ? { error: 'Loop maximum iterations exhausted.' } : {}) }; emit('loop.exhaustion', result); return result; } if (steps >= definition.loop.maxSteps) { const result = { status: 'step_budget_exhausted' as const, output: Object.fromEntries(Object.entries(definition.ports.outputs).map(([name, port]) => [name, state[port.state]])), iterations, steps, error: 'Graph maximum step budget exhausted.' }; emit('loop.exhaustion', result); return result; } const bodyInput: Record<string, unknown> = {}; for (const [name, path] of Object.entries(definition.body.inputs)) bodyInput[name] = pathValue(state, path); emit('loop.iteration.input', { loop: definition.name, iteration: iterations + 1, step: steps + 1, body: definition.body.component, ports: bodyInput }); try { const result = await body.execute(bodyInput, state, debug); for (const [name, path] of Object.entries(definition.body.outputs)) state[path.slice(6)] = result[name]; emit('loop.iteration.output', { loop: definition.name, iteration: iterations + 1, step: steps + 1, body: definition.body.component, ports: result }); } catch (error) { const result = { status: 'body_error' as const, output: {}, iterations, steps, error: error instanceof Error ? error.message.slice(0, 500) : 'Loop body failed.' }; emit('loop.body_error', result); return result; } iterations += 1; steps += 1; } } }; }