import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeDefinitionError, executeNode, inspectNode, parseNodeDefinition } from '../node.js';
import { GraphDefinitionError, compileGraphFile } from '../graph.js';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');
type PackageMetadata = { readonly name: string; readonly version: string };

async function packageMetadata(): Promise<PackageMetadata> {
  return JSON.parse(await readFile(packagePath, 'utf8')) as PackageMetadata;
}

function help(): number {
  console.log(`Usage: langgraph-exec <command> [options]

Commands:
  validate <component.yml>             Validate a direct node or graph offline.
  inspect <component.yml> [options]    Inspect a direct node or graph offline.
  run <component.yml> --input <file>   Execute a direct node or graph.

Inspect options:
  --resolved                         Include normalized contract details.
  --format json                      Emit JSON (the default).

Options:
  --help, -h                         Show this help.
  --version, -v                      Show the package version.

The validate and inspect commands never initialize an LLM provider. The run
command returns a bounded response envelope as JSON.`);
  return 0;
}

async function loadNode(path: string) {
  return parseNodeDefinition(await readFile(resolve(path), 'utf8'));
}

async function loadComponent(path: string) {
  const source = await readFile(resolve(path), 'utf8');
  return source.includes('kind: graph') ? compileGraphFile(path) : parseNodeDefinition(source);
}

function commandError(error: unknown): string {
  if (error instanceof NodeDefinitionError || error instanceof GraphDefinitionError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 500);
  return 'The command failed.';
}

function hasOnlyOptions(args: readonly string[], allowed: readonly string[]): boolean {
  return args.every((arg) => allowed.includes(arg));
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return help();
  if (args[0] === '--version' || args[0] === '-v') {
    console.log((await packageMetadata()).version);
    return 0;
  }

  const command = args[0];
  try {
    if (command === 'validate') {
      if (args.length !== 2) {
        console.error('Usage: langgraph-exec validate <component.yml>');
        return 2;
      }
      const component = await loadComponent(args[1]);
      console.log(`Valid ${'definition' in component ? component.definition.kind : 'node'}: ${'definition' in component ? component.definition.name : component.name}`);
      return 0;
    }
    if (command === 'inspect') {
      if (args.length < 2 || !hasOnlyOptions(args.slice(2), ['--resolved', '--format', 'json'])) {
        console.error('Usage: langgraph-exec inspect <component.yml> [--resolved] [--format json]');
        return 2;
      }
      const component = await loadComponent(args[1]);
      const inspected = 'inspect' in component ? component.inspect : inspectNode(component);
      if (args.includes('--resolved')) inspected.resolution = { defaultsAppliedAtExecution: true, providerAccess: 'none' };
      console.log(JSON.stringify(inspected, null, 2));
      return 0;
    }
    if (command === 'run') {
      if (args.length !== 4 || args[2] !== '--input') {
        console.error('Usage: langgraph-exec run <component.yml> --input <input.json>');
        return 2;
      }
      const component = await loadComponent(args[1]);
      const input = JSON.parse(await readFile(resolve(args[3]), 'utf8')) as Parameters<typeof executeNode>[1];
      const response = 'invoke' in component
        ? { schema: 'https://schemas.handschuh.dev/langgraph-exec/response/v1', status: 'success', output: await component.invoke(input.input ?? {}), errors: [] }
        : await executeNode(component, input);
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