import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDefinitionError, executeNode, inspectNode, parseNodeDefinition } from '../node.js';
import { GraphDefinitionError, compileGraphFile } from '../graph.js';
import { LoopDefinitionError, compileLoopFile } from '../loop.js';
import { stderrDebugSink } from 'llm';

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

Inspect options:
  --resolved                         Include normalized contract details.
  --format json                      Emit JSON (the default).

Options:
  --help, -h                         Show this help.
  --version, -v                      Show the package version.
  --debug                            Emit JSONL execution diagnostics on stderr.

The validate and inspect commands never initialize an LLM provider. The run
command returns a bounded response envelope as JSON.`);
  return 0;
}

async function loadNode(path: string) {
  return parseNodeDefinition(await readFile(resolve(path), 'utf8'));
}

async function loadComponent(path: string) {
  const source = await readFile(resolve(path), 'utf8');
  if (source.includes('kind: loop')) return compileLoopFile(path);
  return source.includes('kind: graph') ? compileGraphFile(path) : parseNodeDefinition(source);
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
  const cleanArgs = args.filter((arg) => arg !== '--debug');
  if (cleanArgs.length === 0 || cleanArgs[0] === '--help' || cleanArgs[0] === '-h') return help();
  if (cleanArgs[0] === '--version' || cleanArgs[0] === '-v') {
    console.log((await packageMetadata()).version);
    return 0;
  }

  const command = cleanArgs[0];
  const debug = debugEnabled ? stderrDebugSink() : undefined;
  try {
    if (command === 'validate') {
      if (cleanArgs.length !== 2) {
        console.error('Usage: langgraph-exec validate <component.yml>');
        return 2;
      }
      const component = await loadComponent(cleanArgs[1]);
      console.log(`Valid ${'definition' in component ? component.definition.kind : 'node'}: ${'definition' in component ? component.definition.name : component.name}`);
      return 0;
    }
    if (command === 'inspect') {
      if (cleanArgs.length < 2 || !hasOnlyOptions(cleanArgs.slice(2), ['--resolved', '--format', 'json'])) {
        console.error('Usage: langgraph-exec inspect <component.yml> [--resolved] [--format json]');
        return 2;
      }
      const component = await loadComponent(cleanArgs[1]);
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
      const component = await loadComponent(cleanArgs[1]);
      const input = JSON.parse(await readFile(resolve(cleanArgs[3]), 'utf8')) as Parameters<typeof executeNode>[1];
      const response = 'invoke' in component
        ? ('definition' in component && component.definition.kind === 'loop'
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