import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), '../../package.json');

type PackageMetadata = { readonly name: string; readonly version: string };

async function packageMetadata(): Promise<PackageMetadata> {
  return JSON.parse(await readFile(packagePath, 'utf8')) as PackageMetadata;
}

function help(): number {
  console.log(`Usage: langgraph-exec <command> [options]

Commands:
  validate <component.yml>  Validate a YAML node or graph definition.
  inspect <component.yml>   Inspect a resolved YAML node or graph definition.
  run <component.yml>       Execute a YAML node or graph with an input document.

Options:
  --help, -h                Show this help.
  --version, -v             Show the package version.

Phase 1 direct LLM execution is specified by .docs/work-items/WI-0001 and is not
implemented in this repository scaffold yet. validate, inspect, and run are
reserved command boundaries for that implementation.`);
  return 0;
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') return help();
  if (args[0] === '--version' || args[0] === '-v') {
    console.log((await packageMetadata()).version);
    return 0;
  }

  const command = args[0];
  if (command === 'validate' || command === 'inspect' || command === 'run') {
    console.error(`The '${command}' command is reserved for the Phase 1 implementation in WI-0001.`);
    return 2;
  }

  console.error(`Unknown command: ${command}`);
  console.error('Run langgraph-exec --help for usage.');
  return 2;
}