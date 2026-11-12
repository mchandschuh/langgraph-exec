import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { parseDocument } from 'yaml';

export class DocumentParseError extends Error {
  readonly code = 'DOCUMENT_INVALID' as const;

  constructor(message: string) {
    super(message.slice(0, 500));
    this.name = 'DocumentParseError';
  }
}

export function parseStructuredDocument(source: string, filePath = 'document.yaml'): unknown {
  try {
    if (extname(filePath).toLowerCase() === '.json') return JSON.parse(source) as unknown;
    const document = parseDocument(source, { schema: 'core', strict: true, uniqueKeys: true });
    if (document.errors.length > 0) throw document.errors[0];
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new DocumentParseError(`The document '${filePath}' is not valid JSON/YAML or uses unsupported features.`);
  }
}

export async function readStructuredDocument(filePath: string): Promise<unknown> {
  return parseStructuredDocument(await readFile(filePath, 'utf8'), filePath);
}