import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDefinitionError, executeNode, inspectNode, parseNodeDefinition } from '../node.js';
import { GraphDefinitionError, compileGraphFile } from '../graph.js';
import { LoopDefinitionError, compileLoopFile } from '../loop.js';
import { stderrDebugSink } from 'llm';
import { readStructuredDocument } from '../document.js';
import { SchemaRegistry } from '../schema-registry.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
type PackageMetadata = { readonly name: string; readonly version: string };

async function packageMetadata(): Promise<PackageMetadata> {
  return JSON.parse(await readFile(packagePath, 'utf8')) as PackageMetadata;
}

function help(): number {
  console.log(`Usage: langgraph-exec <command> [options]

Commands:
  validate <component.yml>             Validate a node, graph, or bounded loop offline.
  inspect <component.yml> [options]    Inspect a node, graph, or bounded loop offline.
  run <component.yml> --input <file>   Execute a node, graph, or bounded loop.
  schemas                              List schemas available to the local registry.

Inspect options:
  --resolved                         Include normalized contract details.
  --format json                      Emit JSON (the default).

Options:
  --help, -h                         Show this help.
  --version, -v                      Show the package version.
  --debug                            Emit JSONL execution diagnostics on stderr.
  --schema-registry <file>           Read additional schema directories from a registry file.

The validate and inspect commands never initialize an LLM provider. The run
command returns a bounded response envelope as JSON.`);
  return 0;
}

async function loadNode(path: string, registry: SchemaRegistry) {
  return parseNodeDefinition(await readFile(resolve(path), 'utf8'), resolve(path), registry);
}

async function loadComponent(path: string, registry: SchemaRegistry) {
  const source = await readFile(resolve(path), 'utf8');
  const parsed = await readStructuredDocument(resolve(path)) as Record<string, unknown>;
  if (parsed.kind === 'control.loop') return compileLoopFile(path, { schemaRegistry: registry });
  return parsed.kind === 'graph' ? compileGraphFile(path, { schemaRegistry: registry }) : parseNodeDefinition(source, resolve(path), registry);
}

function commandError(error: unknown): string {
  if (error instanceof NodeDefinitionError || error instanceof GraphDefinitionError || error instanceof LoopDefinitionError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'The command failed.';
}

function hasOnlyOptions(args: readonly string[], allowed: readonly string[]): boolean {
  return args.every((arg) => allowed.includes(arg));
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const debugEnabled = args.includes('--debug');
  const registryIndex = args.indexOf('--schema-registry');
  const registryFile = registryIndex >= 0 ? args[registryIndex + 1] : undefined;
  const cleanArgs = args.filter((arg, index) => arg !== '--debug' && (registryIndex < 0 || (index !== registryIndex && index !== registryIndex + 1)));
  if (cleanArgs.length === 0 || cleanArgs[0] === '--help' || cleanArgs[0] === '-h') return help();
  if (cleanArgs[0] === '--version' || cleanArgs[0] === '-v') {
    console.log((await packageMetadata()).version);
    return 0;
  }

  const command = cleanArgs[0];
  const debug = debugEnabled ? stderrDebugSink() : undefined;
  try {
    const registry = await SchemaRegistry.load({ registryFile });
    if (command === 'schemas') {
      console.log(JSON.stringify(registry.list().map(({ id, path }) => ({ id, path })), null, 2));
      return 0;
    }
    if (command === 'validate') {
      if (cleanArgs.length !== 2) {
        console.error('Usage: langgraph-exec validate <component.yml>');
        return 2;
      }
      const component = await loadComponent(cleanArgs[1], registry);
      console.log(`Valid ${'definition' in component ? component.definition.kind : 'node'}: ${'definition' in component ? component.definition.name : component.name}`);
      return 0;
    }
    if (command === 'inspect') {
      if (cleanArgs.length < 2 || !hasOnlyOptions(cleanArgs.slice(2), ['--resolved', '--format', 'json'])) {
        console.error('Usage: langgraph-exec inspect <component.yml> [--resolved] [--format json]');
        return 2;
      }
      const component = await loadComponent(cleanArgs[1], registry);
      const inspected = 'inspect' in component ? component.inspect : inspectNode(component);
      if (cleanArgs.includes('--resolved')) inspected.resolution = { ...(inspected.resolution as Record<string, unknown> | undefined), defaultsAppliedAtExecution: true, providerAccess: 'none' };
      console.log(JSON.stringify(inspected, null, 2));
      return 0;
    }
    if (command === 'run') {
      if (cleanArgs.length !== 4 || cleanArgs[2] !== '--input') {
        console.error('Usage: langgraph-exec run <component.yml> --input <input.json>');
        return 2;
      }
      const component = await loadComponent(cleanArgs[1], registry);
      const input = JSON.parse(await readFile(resolve(cleanArgs[3]), 'utf8')) as Parameters<typeof executeNode>[1];
      const response = 'invoke' in component
        ? ('definition' in component && component.definition.kind === 'control.loop'
          ? await component.invoke(input.input ?? {}, debug)
          : { schema: 'https://schemas.handschuh.dev/langgraph-exec/response/v1', status: 'success', output: await component.invoke(input.input ?? {}, debug), errors: [] })
        : await executeNode(component, input, undefined, debug);
      console.log(JSON.stringify(response, null, 2));
      return response.status === 'success' ? 0 : 1;
    }
    console.error(`Unknown command: ${command}`);
    console.error('Run langgraph-exec --help for usage.');
    return 2;
  } catch (error) {
    console.error(commandError(error));
    return 1;
  }
}