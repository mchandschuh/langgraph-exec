import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const require = createRequire(import.meta.url);

export type JsonSchema = Record<string, unknown>;
export type SchemaExpression = string | JsonSchema;

export interface SchemaRegistryOptions {
  readonly directories?: readonly string[];
  readonly registryFile?: string;
  readonly includeDefaults?: boolean;
}

export interface RegisteredSchema {
  readonly id: string;
  readonly path: string;
  readonly schema: JsonSchema;
}

export interface SchemaValidationIssue {
  readonly instancePath: string;
  readonly message: string;
}

export class SchemaRegistryError extends Error {
  readonly code = 'SCHEMA_REGISTRY_INVALID' as const;

  constructor(message: string) {
    super(message.slice(0, 500));
    this.name = 'SchemaRegistryError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultDirectories(): string[] {
  const llmEntry = require.resolve('llm');
  return [
    resolve(new URL('../schemas', import.meta.url).pathname),
    resolve(dirname(llmEntry), '../schemas'),
  ];
}

function defaultRegistryFile(): string {
  return process.env.LANGGRAPH_EXEC_SCHEMA_REGISTRY
    ?? join(homedir(), '.langgraph-exec', 'schemas', 'registry', 'paths.txt');
}

async function schemaFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await schemaFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.schema.json')) files.push(child);
  }
  return files;
}

async function configuredDirectories(filePath: string): Promise<string[]> {
  if (!existsSync(filePath)) return [];
  const source = await readFile(filePath, 'utf8');
  return source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => isAbsolute(line) ? line : resolve(dirname(filePath), line));
}

function formatErrors(errors: ErrorObject[] | null | undefined): SchemaValidationIssue[] {
  return (errors ?? []).slice(0, 10).map((error) => ({
    instancePath: error.instancePath,
    message: error.message ?? 'Schema validation failed.',
  }));
}

export class SchemaRegistry {
  private readonly ajv: Ajv2020;
  private readonly schemas = new Map<string, RegisteredSchema>();
  private readonly validators = new Map<string, ValidateFunction>();

  private constructor() {
    this.ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  }

  static async load(options: SchemaRegistryOptions = {}): Promise<SchemaRegistry> {
    const registry = new SchemaRegistry();
    const directories = [
      ...(options.includeDefaults === false ? [] : defaultDirectories()),
      ...(options.directories ?? []),
      ...(options.registryFile === undefined && options.directories !== undefined ? [] : await configuredDirectories(options.registryFile ?? defaultRegistryFile())),
    ];
    const uniqueDirectories = [...new Set(directories.map((directory) => resolve(directory)))];
    for (const directory of uniqueDirectories) {
      for (const filePath of await schemaFiles(directory)) await registry.addFile(filePath);
    }
    return registry;
  }

  async addFile(filePath: string): Promise<void> {
    let schema: unknown;
    try {
      schema = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } catch {
      throw new SchemaRegistryError(`Schema file '${filePath}' is not valid JSON.`);
    }
    if (!isRecord(schema) || typeof schema.$id !== 'string' || schema.$id.length === 0) {
      throw new SchemaRegistryError(`Schema file '${filePath}' must declare a non-empty $id.`);
    }
    const id = schema.$id;
    if (this.schemas.has(id)) throw new SchemaRegistryError(`Duplicate schema id '${id}' in '${filePath}'.`);
    try {
      this.ajv.addSchema(schema, id);
    } catch (error) {
      throw new SchemaRegistryError(`Schema '${id}' could not be compiled: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    this.schemas.set(id, { id, path: filePath, schema });
  }

  list(): readonly RegisteredSchema[] {
    return [...this.schemas.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  has(id: string): boolean {
    return this.schemas.has(id);
  }

  validate(value: unknown, expression: SchemaExpression): SchemaValidationIssue[] {
    const validator = this.validator(expression);
    return validator(value) ? [] : formatErrors(validator.errors);
  }

  assert(value: unknown, expression: SchemaExpression, path: string): void {
    const issues = this.validate(value, expression);
    if (issues.length > 0) {
      const detail = issues.map((issue) => `${issue.instancePath || '/'} ${issue.message}`).join('; ');
      throw new SchemaRegistryError(`${path} does not satisfy its schema: ${detail}`);
    }
  }

  private validator(expression: SchemaExpression): ValidateFunction {
    const key = typeof expression === 'string' ? expression : JSON.stringify(expression);
    const existing = this.validators.get(key);
    if (existing) return existing;
    let validator: ValidateFunction;
    try {
      validator = typeof expression === 'string'
        ? this.ajv.getSchema(expression) ?? (() => { throw new Error(`Unknown schema '${expression}'.`); })()
        : this.ajv.compile(expression);
    } catch (error) {
      throw new SchemaRegistryError(error instanceof Error ? error.message : 'Schema expression could not be compiled.');
    }
    this.validators.set(key, validator);
    return validator;
  }
}

let defaultRegistryPromise: Promise<SchemaRegistry> | undefined;

export function defaultSchemaRegistry(): Promise<SchemaRegistry> {
  defaultRegistryPromise ??= SchemaRegistry.load();
  return defaultRegistryPromise;
}

export function resetDefaultSchemaRegistry(): void {
  defaultRegistryPromise = undefined;
}