import { parseDocument } from 'yaml';
import { complete, REQUEST_SCHEMA, RESPONSE_SCHEMA } from 'llm';
import type { DebugSink, LlmRequest, LlmResponse, Thinking } from 'llm';

export const NODE_SCHEMA = 'https://schemas.handschuh.dev/langgraph-exec/node/v1' as const;
export const NODE_IMPLEMENTATION = 'llm.complete' as const;

type Primitive = boolean | number | string;
export type ParameterType = 'string' | 'number' | 'integer' | 'boolean';

export interface ParameterDefinition {
  readonly type: ParameterType;
  readonly default?: Primitive;
  readonly required?: boolean;
}

export interface PortDefinition {
  readonly type: string;
  readonly required?: boolean;
}

export interface NodeDefinition {
  readonly schema: typeof NODE_SCHEMA;
  readonly kind: 'node';
  readonly name: string;
  readonly implementation: typeof NODE_IMPLEMENTATION;
  readonly parameters: Readonly<Record<string, ParameterDefinition>>;
  readonly ports: {
    readonly inputs: Readonly<Record<string, PortDefinition>>;
    readonly outputs: Readonly<Record<string, PortDefinition>>;
  };
  readonly bindings: Readonly<Record<RequestField, string>>;
}

export interface NodeInput {
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly input?: Readonly<Record<string, unknown>>;
}

export type CompletionService = (request: LlmRequest, debug?: DebugSink) => Promise<LlmResponse>;

function debug(sink: DebugSink | undefined, event: string, data: Record<string, unknown>): void {
  if (!sink) return;
  sink({ event, timestamp: new Date().toISOString(), data });
}

export class NodeDefinitionError extends Error {
  readonly code = 'NODE_DEFINITION_INVALID' as const;

  constructor(message: string) {
    super(message.slice(0, 500));
    this.name = 'NodeDefinitionError';
  }
}

const REQUEST_FIELDS = [
  'provider',
  'model',
  'thinking',
  'maxFailedAttempts',
  'maxIterations',
  'task',
  'systemPrompt',
  'taskSchema',
  'outputSchema',
] as const;

type RequestField = (typeof REQUEST_FIELDS)[number];

const PARAMETER_TYPES = new Set<ParameterType>(['string', 'number', 'integer', 'boolean']);
const THINKING_VALUES = new Set<Thinking>(['minimal', 'low', 'medium', 'high', 'xhigh']);
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]*$/;
const PROVIDER = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new NodeDefinitionError(`${path} must be an object.`);
  return value;
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new NodeDefinitionError(`${path}.${key} is not allowed.`);
  }
}

function assertString(value: unknown, path: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    throw new NodeDefinitionError(`${path} must be a${nonEmpty ? ' non-empty' : ''} string.`);
  }
  return value;
}

function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new NodeDefinitionError(`${path} must be a boolean.`);
  return value;
}

function assertParameterValue(value: unknown, type: ParameterType, path: string): Primitive {
  if (type === 'string') return assertString(value, path, false);
  if (type === 'boolean') return assertBoolean(value, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new NodeDefinitionError(`${path} must be a finite number.`);
  }
  if (type === 'integer' && !Number.isInteger(value)) {
    throw new NodeDefinitionError(`${path} must be an integer.`);
  }
  return value;
}

function parseParameterDefinitions(value: unknown): Record<string, ParameterDefinition> {
  const record = assertRecord(value, 'parameters');
  const result: Record<string, ParameterDefinition> = {};
  for (const [name, rawDefinition] of Object.entries(record)) {
    if (!IDENTIFIER.test(name)) throw new NodeDefinitionError(`parameters.${name} is not a valid parameter name.`);
    const definition = assertRecord(rawDefinition, `parameters.${name}`);
    assertKeys(definition, ['type', 'default', 'required'], `parameters.${name}`);
    const type = assertString(definition.type, `parameters.${name}.type`) as ParameterType;
    if (!PARAMETER_TYPES.has(type)) throw new NodeDefinitionError(`parameters.${name}.type is unsupported.`);
    const required = definition.required === undefined ? false : assertBoolean(definition.required, `parameters.${name}.required`);
    const parsed: ParameterDefinition = { type, ...(required ? { required: true } : {}) };
    result[name] = own(definition, 'default')
      ? { ...parsed, default: assertParameterValue(definition.default, type, `parameters.${name}.default`) }
      : parsed;
  }
  return result;
}

function parsePorts(value: unknown): NodeDefinition['ports'] {
  const ports = assertRecord(value, 'ports');
  assertKeys(ports, ['inputs', 'outputs'], 'ports');
  const parsePortGroup = (group: unknown, path: string): Record<string, PortDefinition> => {
    const record = assertRecord(group, path);
    const result: Record<string, PortDefinition> = {};
    for (const [name, rawPort] of Object.entries(record)) {
      if (!IDENTIFIER.test(name)) throw new NodeDefinitionError(`${path}.${name} is not a valid port name.`);
      const port = assertRecord(rawPort, `${path}.${name}`);
      assertKeys(port, ['type', 'required'], `${path}.${name}`);
      const type = assertString(port.type, `${path}.${name}.type`);
      const required = port.required === undefined ? false : assertBoolean(port.required, `${path}.${name}.required`);
      result[name] = { type, ...(required ? { required: true } : {}) };
    }
    return result;
  };
  const inputs = parsePortGroup(ports.inputs, 'ports.inputs');
  const outputs = parsePortGroup(ports.outputs, 'ports.outputs');
  if (Object.keys(outputs).length === 0) throw new NodeDefinitionError('ports.outputs must declare at least one port.');
  return { inputs, outputs };
}

function parseBindings(value: unknown, parameters: Readonly<Record<string, ParameterDefinition>>): Record<RequestField, string> {
  const bindings = assertRecord(value, 'bindings');
  assertKeys(bindings, REQUEST_FIELDS, 'bindings');
  const result: Partial<Record<RequestField, string>> = {};
  for (const [rawField, rawSource] of Object.entries(bindings)) {
    const field = rawField as RequestField;
    const source = assertString(rawSource, `bindings.${field}`);
    const parameterMatch = /^parameter\.([A-Za-z][A-Za-z0-9._-]*)$/.exec(source);
    const inputMatch = /^input\.([A-Za-z][A-Za-z0-9._-]*)(?:\.[A-Za-z][A-Za-z0-9._-]*)*$/.exec(source);
    if (parameterMatch && !own(parameters, parameterMatch[1])) {
      throw new NodeDefinitionError(`bindings.${field} references undeclared parameter '${parameterMatch[1]}'.`);
    }
    if (!parameterMatch && !inputMatch) {
      throw new NodeDefinitionError(`bindings.${field} must reference parameter.<name> or input.<path>.`);
    }
    result[field] = source;
  }
  if (!result.task || !result.systemPrompt) throw new NodeDefinitionError('bindings must declare task and systemPrompt.');
  return result as Record<RequestField, string>;
}

export function parseNodeDefinition(source: string): NodeDefinition {
  let value: unknown;
  try {
    const document = parseDocument(source, { schema: 'core', strict: true, uniqueKeys: true });
    if (document.errors.length > 0) throw document.errors[0];
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new NodeDefinitionError('The node YAML is not valid or uses unsupported YAML features.');
  }
  const node = assertRecord(value, 'node');
  assertKeys(node, ['schema', 'kind', 'name', 'implementation', 'parameters', 'ports', 'bindings'], 'node');
  if (node.schema !== NODE_SCHEMA) throw new NodeDefinitionError(`schema must be ${NODE_SCHEMA}.`);
  if (node.kind !== 'node') throw new NodeDefinitionError('kind must be node.');
  const name = assertString(node.name, 'name');
  if (!IDENTIFIER.test(name)) throw new NodeDefinitionError('name contains unsupported characters.');
  if (node.implementation !== NODE_IMPLEMENTATION) throw new NodeDefinitionError(`implementation must be ${NODE_IMPLEMENTATION}.`);
  const parameters = parseParameterDefinitions(node.parameters);
  const ports = parsePorts(node.ports);
  const bindings = parseBindings(node.bindings, parameters);
  return { schema: NODE_SCHEMA, kind: 'node', name, implementation: NODE_IMPLEMENTATION, parameters, ports, bindings };
}

function valueAtPath(record: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = record;
  for (const segment of path.split('.')) {
    if (!isRecord(value) || !own(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}

function resolveParameters(definition: NodeDefinition, input: NodeInput): Record<string, Primitive> {
  const overrides = input.parameters ?? {};
  if (!isRecord(overrides)) throw new NodeDefinitionError('input.parameters must be an object.');
  for (const name of Object.keys(overrides)) {
    if (!own(definition.parameters, name)) throw new NodeDefinitionError(`input.parameters.${name} is not declared by the node.`);
  }
  const resolved: Record<string, Primitive> = {};
  for (const [name, parameter] of Object.entries(definition.parameters)) {
    const value = own(overrides, name) ? overrides[name] : parameter.default;
    if (value === undefined) {
      if (parameter.required) throw new NodeDefinitionError(`Required parameter '${name}' is missing.`);
      continue;
    }
    resolved[name] = assertParameterValue(value, parameter.type, `input.parameters.${name}`);
  }
  return resolved;
}

function validateRequestValue(field: RequestField, value: unknown): void {
  if (field === 'task' || field === 'systemPrompt' || field === 'provider' || field === 'model' || field === 'taskSchema' || field === 'outputSchema') {
    assertString(value, `resolved request.${field}`);
  } else if (field === 'thinking') {
    if (typeof value !== 'string' || !THINKING_VALUES.has(value as Thinking)) throw new NodeDefinitionError('resolved request.thinking is unsupported.');
  } else {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new NodeDefinitionError(`resolved request.${field} must be an integer.`);
    const minimum = field === 'maxIterations' ? 1 : 0;
    if (value < minimum || value > 10) throw new NodeDefinitionError(`resolved request.${field} must be between ${minimum} and 10.`);
  }
  if (field === 'provider' && !PROVIDER.test(value as string)) throw new NodeDefinitionError('resolved request.provider is invalid.');
  if (field === 'model' && !MODEL.test(value as string)) throw new NodeDefinitionError('resolved request.model is invalid.');
}

export function resolveRequest(definition: NodeDefinition, input: NodeInput): LlmRequest {
  if (!isRecord(input)) throw new NodeDefinitionError('Execution input must be an object.');
  const parameters = resolveParameters(definition, input);
  const inputValues = input.input ?? {};
  if (!isRecord(inputValues)) throw new NodeDefinitionError('input.input must be an object.');
  const request: Record<string, unknown> = { schema: REQUEST_SCHEMA };
  for (const [field, source] of Object.entries(definition.bindings) as [RequestField, string][]) {
    const value = source.startsWith('parameter.')
      ? parameters[source.slice('parameter.'.length)]
      : valueAtPath(inputValues, source.slice('input.'.length));
    if (value === undefined) throw new NodeDefinitionError(`Binding '${field}' could not resolve '${source}'.`);
    validateRequestValue(field, value);
    request[field] = value;
  }
  return request as unknown as LlmRequest;
}

function providerFailure(): LlmResponse {
  return {
    schema: RESPONSE_SCHEMA,
    status: 'provider_error',
    output: null,
    failedAttempts: 1,
    iterations: 0,
    errors: [{ code: 'PROVIDER_REQUEST_FAILED', message: 'The provider request failed before a usable response was returned.', phase: 'provider' }],
  };
}

function inputFailure(error: unknown): LlmResponse {
  return {
    schema: RESPONSE_SCHEMA,
    status: 'input_invalid',
    output: null,
    failedAttempts: 0,
    iterations: 0,
    errors: [{
      code: 'REQUEST_INVALID',
      message: error instanceof NodeDefinitionError ? error.message : 'The node input was invalid.',
      phase: 'request',
    }],
  };
}

export const defaultCompletionService: CompletionService = async (request, debugSink) => (await complete(request, { debug: debugSink })) as LlmResponse;

export async function executeNode(
  definition: NodeDefinition,
  input: NodeInput,
  service: CompletionService = defaultCompletionService,
  debugSink?: DebugSink,
): Promise<LlmResponse> {
  let request: LlmRequest;
  try {
    request = resolveRequest(definition, input);
  } catch (error) {
    return inputFailure(error);
  }
  debug(debugSink, 'node.input', { node: definition.name, implementation: definition.implementation, input: input.input ?? {}, parameters: input.parameters ?? {} });
  try {
    const response = await service(request, debugSink);
    debug(debugSink, 'node.output', { node: definition.name, implementation: definition.implementation, output: response });
    return response;
  } catch {
    const response = providerFailure();
    debug(debugSink, 'node.output', { node: definition.name, implementation: definition.implementation, output: response });
    return response;
  }
}

export function inspectNode(definition: NodeDefinition): Record<string, unknown> {
  return {
    schema: definition.schema,
    kind: definition.kind,
    name: definition.name,
    implementation: definition.implementation,
    parameters: definition.parameters,
    ports: definition.ports,
    bindings: definition.bindings,
  };
}