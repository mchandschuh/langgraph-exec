import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { CompletionService, NodeDefinition } from './node.js';
import type { RetryPolicy } from '@langchain/langgraph';
import type { DebugSink } from 'llm';
import { executeNode, parseNodeDefinition } from './node.js';
import { parseStructuredDocument } from './document.js';
import { defaultSchemaRegistry, type SchemaExpression, type SchemaRegistry } from './schema-registry.js';

export const GRAPH_SCHEMA = 'https://schemas.handschuh.dev/langgraph-exec/graph/v1' as const;
type ReducerName = 'replace' | 'append' | 'sum' | 'merge';

export interface GraphImport { readonly path: string; readonly alias: string; readonly sha256?: string }
export interface GraphStateField { readonly type: string; readonly schema?: SchemaExpression; readonly default?: unknown; readonly reducer: ReducerName }
export interface GraphPort { readonly state: string; readonly type: string; readonly schema?: SchemaExpression; readonly required?: boolean }
export interface ComponentPort { readonly type: string; readonly schema?: SchemaExpression; readonly required?: boolean; readonly state?: string }
export interface GraphNodeInstance { readonly id: string; readonly component: string; readonly retryPolicy?: RetryPolicy; readonly timeout?: number }
export interface GraphBinding { readonly from: string; readonly to: string }
export interface GraphEdge { readonly from: string; readonly to: string }
export interface GraphRoute { readonly from: string; readonly selector: string; readonly cases: Readonly<Record<string, string>>; readonly default: string }
export interface GraphDefinition {
  readonly schema: typeof GRAPH_SCHEMA; readonly kind: 'graph'; readonly name: string; readonly imports: readonly GraphImport[];
  readonly state: Readonly<Record<string, GraphStateField>>;
  readonly ports: { readonly inputs: Readonly<Record<string, GraphPort>>; readonly outputs: Readonly<Record<string, GraphPort>> };
  readonly nodes: readonly GraphNodeInstance[]; readonly bindings: readonly GraphBinding[]; readonly edges: readonly GraphEdge[]; readonly routes: readonly GraphRoute[];
}
export interface GraphComponent {
  readonly name: string;
  readonly inputs: Readonly<Record<string, ComponentPort>>;
  readonly outputs: Readonly<Record<string, ComponentPort>>;
  execute(input: Readonly<Record<string, unknown>>, state: Readonly<Record<string, unknown>>, debug?: DebugSink): Promise<Record<string, unknown>>;
}
export interface ComponentNodeAdapterOptions {
  readonly component: GraphComponent;
  readonly resolveInput: (state: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  readonly applyOutput: (output: Record<string, unknown>, state: Readonly<Record<string, unknown>>, input: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly beforeExecute?: (input: Readonly<Record<string, unknown>>, state: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly afterExecute?: (output: Record<string, unknown>, state: Readonly<Record<string, unknown>>, input: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  readonly debug?: DebugSink;
}
export interface GraphCompileOptions { readonly rootDir?: string; readonly components?: Readonly<Record<string, GraphComponent>>; readonly completionService?: CompletionService; readonly debug?: DebugSink; readonly schemaRegistry?: SchemaRegistry }
export interface CompiledRuntime { readonly inspect: Record<string, unknown>; invoke(input: Readonly<Record<string, unknown>>, debug?: DebugSink): Promise<unknown>; stream?(input: Readonly<Record<string, unknown>>, mode?: 'values' | 'updates' | 'debug' | 'tasks'): Promise<AsyncIterable<unknown>> }
export interface CompiledGraph extends CompiledRuntime { readonly definition: GraphDefinition }

export class GraphDefinitionError extends Error {
  readonly code = 'GRAPH_DEFINITION_INVALID' as const;
  constructor(message: string) { super(message.slice(0, 500)); this.name = 'GraphDefinitionError'; }
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REDUCERS = new Set<ReducerName>(['replace', 'append', 'sum', 'merge']);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown, path: string): Record<string, unknown> { if (!isRecord(value)) throw new GraphDefinitionError(`${path} must be an object.`); return value; }
function string(value: unknown, path: string): string { if (typeof value !== 'string' || value.length === 0) throw new GraphDefinitionError(`${path} must be a non-empty string.`); return value; }
function keys(value: Record<string, unknown>, allowed: readonly string[], path: string): void { const accepted = new Set(allowed); for (const key of Object.keys(value)) if (!accepted.has(key)) throw new GraphDefinitionError(`${path}.${key} is not allowed.`); }
function identifier(value: unknown, path: string): string { const result = string(value, path); if (!IDENTIFIER.test(result)) throw new GraphDefinitionError(`${path} must be a valid identifier.`); return result; }
function array(value: unknown, path: string): readonly unknown[] { if (!Array.isArray(value)) throw new GraphDefinitionError(`${path} must be an array.`); return value; }
function integer(value: unknown, path: string, minimum: number, maximum: number): number { if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new GraphDefinitionError(`${path} must be an integer between ${minimum} and ${maximum}.`); return value as number; }

function parsePorts(value: unknown, path: string): Record<string, GraphPort> {
  const source = record(value, path); const result: Record<string, GraphPort> = {};
  for (const [name, raw] of Object.entries(source)) { const port = record(raw, `${path}.${name}`); keys(port, ['state', 'type', 'schema', 'required'], `${path}.${name}`); if (port.required !== undefined && typeof port.required !== 'boolean') throw new GraphDefinitionError(`${path}.${name}.required must be boolean.`); result[identifier(name, `${path}.${name}`)] = { state: identifier(port.state, `${path}.${name}.state`), type: string(port.type, `${path}.${name}.type`), ...(port.schema !== undefined ? { schema: port.schema as SchemaExpression } : {}), ...(port.required ? { required: true } : {}) }; }
  return result;
}
function parseState(value: unknown): Record<string, GraphStateField> {
  const source = record(value, 'state.fields'); const result: Record<string, GraphStateField> = {};
  for (const [name, raw] of Object.entries(source)) { const field = record(raw, `state.fields.${name}`); keys(field, ['type', 'schema', 'default', 'reducer'], `state.fields.${name}`); const reducer = (field.reducer ?? 'replace') as ReducerName; if (!REDUCERS.has(reducer)) throw new GraphDefinitionError(`state.fields.${name}.reducer is unsupported.`); result[identifier(name, `state.fields.${name}`)] = { type: string(field.type, `state.fields.${name}.type`), ...(field.schema !== undefined ? { schema: field.schema as SchemaExpression } : {}), ...(own(field, 'default') ? { default: field.default } : {}), reducer }; }
  return result;
}

export function parseGraphDefinition(source: string, filePath = 'graph.yaml', registry?: SchemaRegistry): GraphDefinition {
  let value: unknown;
  try { value = parseStructuredDocument(source, filePath); } catch { throw new GraphDefinitionError('The graph document is not valid JSON/YAML or uses unsupported features.'); }
  const graph = record(value, 'graph'); keys(graph, ['schema', 'kind', 'name', 'imports', 'state', 'ports', 'nodes', 'bindings', 'edges', 'routes'], 'graph'); if (graph.schema !== GRAPH_SCHEMA) throw new GraphDefinitionError(`schema must be ${GRAPH_SCHEMA}.`); if (graph.kind !== 'graph') throw new GraphDefinitionError('kind must be graph.');
  const imports: GraphImport[] = []; for (const [index, raw] of array(graph.imports ?? [], 'imports').entries()) { const item = record(raw, `imports[${index}]`); keys(item, ['path', 'alias', 'sha256'], `imports[${index}]`); const sha256 = item.sha256 === undefined ? undefined : string(item.sha256, `imports[${index}].sha256`); if (sha256 && !SHA256.test(sha256)) throw new GraphDefinitionError(`imports[${index}].sha256 must be lowercase SHA-256.`); imports.push({ path: string(item.path, `imports[${index}].path`), alias: identifier(item.alias, `imports[${index}].alias`), ...(sha256 ? { sha256 } : {}) }); }
  if (new Set(imports.map((item) => item.alias)).size !== imports.length) throw new GraphDefinitionError('Import aliases must be unique.');
  const ports = record(graph.ports, 'ports'); keys(ports, ['inputs', 'outputs'], 'ports');
  const nodes = array(graph.nodes, 'nodes').map((raw, index) => { const node = record(raw, `nodes[${index}]`); keys(node, ['id', 'component', 'retryPolicy', 'timeout'], `nodes[${index}]`); return { id: identifier(node.id, `nodes[${index}].id`), component: identifier(node.component, `nodes[${index}].component`), ...(node.retryPolicy !== undefined ? { retryPolicy: node.retryPolicy as RetryPolicy } : {}), ...(node.timeout !== undefined ? { timeout: integer(node.timeout, `nodes[${index}].timeout`, 1, 3600000) } : {}) }; });
  if (nodes.length === 0) throw new GraphDefinitionError('nodes must contain at least one node.'); if (new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new GraphDefinitionError('Node identifiers must be unique.');
  const bindings = array(graph.bindings ?? [], 'bindings').map((raw, index) => { const binding = record(raw, `bindings[${index}]`); keys(binding, ['from', 'to'], `bindings[${index}]`); return { from: string(binding.from, `bindings[${index}].from`), to: string(binding.to, `bindings[${index}].to`) }; });
  const edges = array(graph.edges ?? [], 'edges').map((raw, index) => { const edge = record(raw, `edges[${index}]`); keys(edge, ['from', 'to'], `edges[${index}]`); return { from: string(edge.from, `edges[${index}].from`), to: string(edge.to, `edges[${index}].to`) }; });
  const routes = array(graph.routes ?? [], 'routes').map((raw, index) => { const route = record(raw, `routes[${index}]`); keys(route, ['from', 'selector', 'cases', 'default'], `routes[${index}]`); const cases = record(route.cases, `routes[${index}].cases`); const parsedCases: Record<string, string> = {}; for (const [caseName, target] of Object.entries(cases)) parsedCases[caseName] = string(target, `routes[${index}].cases.${caseName}`); return { from: identifier(route.from, `routes[${index}].from`), selector: string(route.selector, `routes[${index}].selector`), cases: parsedCases, default: string(route.default, `routes[${index}].default`) }; });
  const state = record(graph.state, 'state'); const fields = own(state, 'fields') ? state.fields : state;
  const definition = { schema: GRAPH_SCHEMA, kind: 'graph' as const, name: identifier(graph.name, 'name'), imports, state: parseState(fields), ports: { inputs: parsePorts(ports.inputs, 'ports.inputs'), outputs: parsePorts(ports.outputs, 'ports.outputs') }, nodes, bindings, edges, routes };
  if (registry) { registry.assert(graph, GRAPH_SCHEMA, 'graph definition'); for (const [name, field] of Object.entries(definition.state)) if (field.schema) registry.assertSchema(field.schema, `state.fields.${name}.schema`); for (const [groupName, group] of Object.entries(definition.ports)) for (const [name, port] of Object.entries(group)) if (port.schema) registry.assertSchema(port.schema, `ports.${groupName}.${name}.schema`); }
  return definition;
}

function withinRoot(rootDir: string, candidate: string): boolean { const rel = relative(rootDir, candidate); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel); }
function resolveImport(rootDir: string, baseDir: string, importPath: string): string { if (isAbsolute(importPath) || importPath.split(/[\\/]/).some((part) => part === '..')) throw new GraphDefinitionError(`Import path '${importPath}' is not trusted.`); const candidate = resolve(baseDir, importPath); if (!withinRoot(rootDir, candidate)) throw new GraphDefinitionError(`Import path '${importPath}' escapes the trusted root.`); return candidate; }
function digest(content: string): string { return createHash('sha256').update(content).digest('hex'); }
function endpointNode(reference: string): { node: string; port: string } | undefined { const match = /^node\.([A-Za-z][A-Za-z0-9._-]*)\.([A-Za-z][A-Za-z0-9._-]*)$/.exec(reference); return match ? { node: match[1], port: match[2] } : undefined; }
function pathValue(state: Readonly<Record<string, unknown>>, path: string): unknown { const segments = path.split('.'); if (segments[0] === 'state') segments.shift(); let value: unknown = state; for (const segment of segments) { if (!isRecord(value) || !own(value, segment)) return undefined; value = value[segment]; } return value; }
function internalOutputKey(node: string, port: string): string { return `__node__${node}__${port}`; }
function stateField(graph: GraphDefinition, reference: string): string { const match = /^(?:state|input)\.([A-Za-z][A-Za-z0-9._-]*)$/.exec(reference); if (!match) throw new GraphDefinitionError(`Reference '${reference}' must use state.<field> or input.<port>.`); if (reference.startsWith('input.')) { const port = graph.ports.inputs[match[1]]; if (!port) throw new GraphDefinitionError(`Unknown graph input port '${match[1]}'.`); return port.state; } if (!own(graph.state, match[1])) throw new GraphDefinitionError(`Unknown state field '${match[1]}'.`); return match[1]; }

function emitDebug(sink: DebugSink | undefined, event: string, data: Record<string, unknown>): void { if (sink) sink({ event, timestamp: new Date().toISOString(), data }); }
export function adaptComponentToLangGraphNode(options: ComponentNodeAdapterOptions): (state: Readonly<Record<string, unknown>>) => Promise<Record<string, unknown>> {
  return async (state) => {
    const input = options.resolveInput(state);
    const output = await options.component.execute(input, state, options.debug);
    return { ...(options.beforeExecute?.(input, state) ?? {}), ...options.applyOutput(output, state, input), ...(options.afterExecute?.(output, state, input) ?? {}) };
  };
}
export function adaptNodeDefinition(definition: NodeDefinition, service?: CompletionService): GraphComponent { return { name: definition.name, inputs: definition.ports.inputs, outputs: definition.ports.outputs, async execute(input, _state, debug) { const response = await executeNode(definition, { input }, service, debug); if (response.status !== 'success') throw new GraphDefinitionError(response.errors[0]?.message ?? 'Nested node execution failed.'); return { response: response.output?.value ?? response.output }; } }; }
export function adaptCompiledGraph(compiled: CompiledGraph): GraphComponent { return { name: compiled.definition.name, inputs: compiled.definition.ports.inputs, outputs: compiled.definition.ports.outputs, execute: async (input, _state, debug) => { const output = await compiled.invoke(input, debug); if (!isRecord(output)) throw new GraphDefinitionError(`Compiled component '${compiled.definition.name}' returned a non-object output.`); return output; } }; }

function validateGraph(graph: GraphDefinition, components: Readonly<Record<string, GraphComponent>>): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.id)); for (const node of graph.nodes) if (!components[node.component]) throw new GraphDefinitionError(`Component '${node.component}' is not resolved.`);
  for (const port of Object.values(graph.ports.inputs)) if (!own(graph.state, port.state)) throw new GraphDefinitionError(`Input references unknown state '${port.state}'.`); for (const port of Object.values(graph.ports.outputs)) if (!own(graph.state, port.state)) throw new GraphDefinitionError(`Output references unknown state '${port.state}'.`);
  const writes = new Map<string, string[]>();
  const validateSource = (reference: string): void => {
    const source = endpointNode(reference);
    if (!source) { stateField(graph, reference); return; }
    const node = graph.nodes.find((item) => item.id === source.node);
    if (!node || !components[node.component].outputs[source.port]) throw new GraphDefinitionError(`Binding sources unknown output port '${reference}'.`);
  };
  for (const binding of graph.bindings) {
    const target = endpointNode(binding.to);
    if (target) {
      const node = graph.nodes.find((item) => item.id === target.node);
      if (!node) throw new GraphDefinitionError(`Binding targets unknown node '${target.node}'.`);
      if (!components[node.component].inputs[target.port]) throw new GraphDefinitionError(`Binding targets unknown input port '${binding.to}'.`);
      validateSource(binding.from);
    } else if (binding.to.startsWith('state.') || binding.to.startsWith('output.')) {
      const field = binding.to.startsWith('output.') ? graph.ports.outputs[binding.to.slice(7)]?.state : stateField(graph, binding.to);
      if (!field || !graph.state[field]) throw new GraphDefinitionError(`Binding targets unknown output '${binding.to}'.`);
      const source = endpointNode(binding.from);
      if (!source) throw new GraphDefinitionError(`Output binding '${binding.from}' must come from a node port.`);
      validateSource(binding.from);
      const sources = [...(writes.get(field) ?? []), source.node];
      writes.set(field, sources);
      const mutuallyExclusive = graph.routes.some((route) => {
        const branchNodes = new Set([...Object.values(route.cases), route.default]);
        return sources.every((nodeId) => branchNodes.has(nodeId));
      });
      if (sources.length > 1 && graph.state[field].reducer === 'replace' && !mutuallyExclusive) throw new GraphDefinitionError(`State field '${field}' has conflicting replace writes.`);
    } else throw new GraphDefinitionError(`Binding destination '${binding.to}' is invalid.`);
  }
  const adjacency = new Map<string, Set<string>>([...nodeIds, START, END].map((id) => [id, new Set()])); const addEdge = (from: string, to: string) => { if (from !== START && from !== END && !nodeIds.has(from)) throw new GraphDefinitionError(`Edge references unknown source '${from}'.`); if (to !== START && to !== END && !nodeIds.has(to)) throw new GraphDefinitionError(`Edge references unknown target '${to}'.`); if (from === END) throw new GraphDefinitionError('END cannot have outgoing edges.'); adjacency.get(from)?.add(to); }; for (const edge of graph.edges) addEdge(edge.from, edge.to); for (const route of graph.routes) { if (!nodeIds.has(route.from)) throw new GraphDefinitionError(`Route references unknown source '${route.from}'.`); stateField(graph, route.selector); for (const target of [...Object.values(route.cases), route.default]) addEdge(route.from, target); }
  const indegree = new Map([...adjacency.keys()].map((id) => [id, 0])); for (const targets of adjacency.values()) for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1); const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id); let visited = 0; while (queue.length) { const current = queue.shift()!; visited += 1; for (const target of adjacency.get(current) ?? []) { const degree = (indegree.get(target) ?? 0) - 1; indegree.set(target, degree); if (degree === 0) queue.push(target); } } if (visited !== adjacency.size) throw new GraphDefinitionError('Graph contains an arbitrary cycle.');
  const reachable = new Set<string>([START]); const walk = (from: string): void => { for (const target of adjacency.get(from) ?? []) if (!reachable.has(target)) { reachable.add(target); walk(target); } }; walk(START); for (const id of nodeIds) if (!reachable.has(id)) throw new GraphDefinitionError(`Node '${id}' is unreachable from START.`); const canEnd = new Set<string>([END]); let changed = true; while (changed) { changed = false; for (const [from, targets] of adjacency) if (!canEnd.has(from) && [...targets].some((target) => canEnd.has(target))) { canEnd.add(from); changed = true; } } for (const id of nodeIds) if (!canEnd.has(id)) throw new GraphDefinitionError(`Node '${id}' cannot reach END.`);
}
function reducer(field: GraphStateField): (left: unknown, right: unknown) => unknown { if (field.reducer === 'append') return (left, right) => [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [right])]; if (field.reducer === 'sum') return (left, right) => Number(left ?? 0) + Number(right ?? 0); if (field.reducer === 'merge') return (left, right) => ({ ...(isRecord(left) ? left : {}), ...(isRecord(right) ? right : {}) }); return (_left, right) => right; }

function buildCompiledGraph(graph: GraphDefinition, components: Readonly<Record<string, GraphComponent>>): CompiledGraph {
  validateGraph(graph, components);
  const channels: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(graph.state)) channels[name] = Annotation({ reducer: reducer(field), default: () => field.default });
  channels.__events = Annotation({ reducer: (left: readonly Record<string, unknown>[], right: readonly Record<string, unknown>[]) => [...left, ...right], default: () => [] });
  for (const binding of graph.bindings) { const source = endpointNode(binding.from); if (source) channels[internalOutputKey(source.node, source.port)] = Annotation({ reducer: (_left: unknown, right: unknown) => right, default: () => undefined }); }
  const builder = new StateGraph(Annotation.Root(channels as never) as never) as any;
  for (const node of graph.nodes) {
    const component = components[node.component];
    const action = adaptComponentToLangGraphNode({
      component,
      resolveInput: (state) => {
        const input: Record<string, unknown> = {};
      for (const binding of graph.bindings) {
        const target = endpointNode(binding.to);
        if (target?.node === node.id) {
          const source = endpointNode(binding.from);
          input[target.port] = source ? state[internalOutputKey(source.node, source.port)] : pathValue(state, `state.${stateField(graph, binding.from)}`);
        }
      }
        return input;
      },
      applyOutput: (result) => {
        const update: Record<string, unknown> = {};
      for (const binding of graph.bindings) {
        const source = endpointNode(binding.from);
        if (source?.node !== node.id) continue;
        const value = result[source.port];
        update[internalOutputKey(source.node, source.port)] = value;
        if (binding.to.startsWith('output.')) update[graph.ports.outputs[binding.to.slice(7)].state] = graph.state[graph.ports.outputs[binding.to.slice(7)].state].reducer === 'append' ? [value] : value;
        else if (binding.to.startsWith('state.')) update[binding.to.slice(6)] = value;
      }
        return update;
      },
      afterExecute: (result, _state, input) => ({ __events: [{ event: 'graph.node.input', data: { graph: graph.name, node: node.id, component: node.component, ports: input } }, { event: 'graph.node.output', data: { graph: graph.name, node: node.id, component: node.component, ports: result } }] }),
    });
    const policy = { ...(node.retryPolicy ? { retryPolicy: node.retryPolicy } : {}), ...(node.timeout ? { timeout: node.timeout } : {}) };
    builder.addNode(node.id, action, policy);
  }
  for (const edge of graph.edges) builder.addEdge(edge.from === START ? START : edge.from, edge.to === END ? END : edge.to);
  for (const route of graph.routes) { const pathMap: Record<string, string> = { ...route.cases, __default: route.default }; builder.addConditionalEdges(route.from, (state: Record<string, unknown>) => Object.prototype.hasOwnProperty.call(pathMap, String(pathValue(state, route.selector))) ? String(pathValue(state, route.selector)) : '__default', pathMap); }
  const compiled = builder.compile({ checkpointer: false });
  const makeInitial = (input: Readonly<Record<string, unknown>>) => { const initial: Record<string, unknown> = {}; for (const [name, field] of Object.entries(graph.state)) initial[name] = field.default; for (const [portName, port] of Object.entries(graph.ports.inputs)) if (Object.prototype.hasOwnProperty.call(input, portName)) initial[port.state] = input[portName]; return initial; };
  return {
    definition: graph,
    inspect: { schema: graph.schema, kind: graph.kind, name: graph.name, imports: graph.imports, state: graph.state, ports: graph.ports, nodes: graph.nodes, bindings: graph.bindings, edges: graph.edges, routes: graph.routes },
    async invoke(input, debugSink = undefined) {
      const initial = makeInitial(input);
      for (const [portName, port] of Object.entries(graph.ports.inputs)) if (Object.prototype.hasOwnProperty.call(input, portName)) emitDebug(debugSink, 'graph.port.flow', { graph: graph.name, from: `input.${portName}`, to: `state.${port.state}`, value: input[portName] });
      const state = await compiled.invoke(initial);
      for (const event of (state.__events as Array<{ event: string; data: Record<string, unknown> }> | undefined) ?? []) emitDebug(debugSink, event.event, event.data);
      const output: Record<string, unknown> = {};
      for (const [portName, port] of Object.entries(graph.ports.outputs)) { output[portName] = state[port.state]; emitDebug(debugSink, 'graph.port.flow', { graph: graph.name, from: `state.${port.state}`, to: `output.${portName}`, value: output[portName] }); }
      return output;
    },
    async stream(input, mode = 'updates') { return compiled.stream(makeInitial(input), { streamMode: mode }); },
  };
}


async function loadComponent(filePath: string, rootDir: string, options: GraphCompileOptions, stack: readonly string[], registry: SchemaRegistry): Promise<GraphComponent> { const absolute = resolve(filePath); if (stack.includes(absolute)) throw new GraphDefinitionError(`Component import cycle detected at '${absolute}'.`); const source = await readFile(absolute, 'utf8'); const parsed = parseStructuredDocument(source, absolute) as Record<string, unknown>; if (parsed.kind === 'node') return adaptNodeDefinition(parseNodeDefinition(source, absolute, registry), options.completionService); const definition = parseGraphDefinition(source, absolute, registry); const components: Record<string, GraphComponent> = { ...(options.components ?? {}) }; for (const item of definition.imports) { const childPath = resolveImport(rootDir, dirname(absolute), item.path); const childSource = await readFile(childPath, 'utf8'); if (item.sha256 && digest(childSource) !== item.sha256) throw new GraphDefinitionError(`Digest mismatch for import '${item.path}'.`); components[item.alias] = await loadComponent(childPath, rootDir, options, [...stack, absolute], registry); } return adaptCompiledGraph(buildCompiledGraph(definition, components)); }
export async function compileGraphFile(filePath: string, options: GraphCompileOptions = {}): Promise<CompiledGraph> { const absolute = resolve(filePath); const rootDir = resolve(options.rootDir ?? dirname(absolute)); const source = await readFile(absolute, 'utf8'); const registry = options.schemaRegistry ?? await defaultSchemaRegistry(); const definition = parseGraphDefinition(source, absolute, registry); const components: Record<string, GraphComponent> = { ...(options.components ?? {}) }; for (const item of definition.imports) { const childPath = resolveImport(rootDir, dirname(absolute), item.path); const childSource = await readFile(childPath, 'utf8'); if (item.sha256 && digest(childSource) !== item.sha256) throw new GraphDefinitionError(`Digest mismatch for import '${item.path}'.`); components[item.alias] = await loadComponent(childPath, rootDir, options, [absolute], registry); } return buildCompiledGraph(definition, components); }
export function componentRegistry(components: Readonly<Record<string, GraphComponent>>): Readonly<Record<string, GraphComponent>> { return components; }