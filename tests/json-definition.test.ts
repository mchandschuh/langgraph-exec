import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseNodeDefinition } from '../src/node.js';
import { parseGraphDefinition } from '../src/graph.js';
import { parseLoopDefinition } from '../src/loop.js';

const fixture = (name: string) => join(process.cwd(), 'tests', 'fixtures', name);

test('node JSON and YAML definitions normalize to equivalent contracts', async () => {
  const yaml = await readFile(fixture('valid-node.yaml'), 'utf8');
  const node = parseNodeDefinition(yaml, 'valid-node.yaml');
  const json = JSON.stringify({ ...node, parameters: node.parameters, ports: node.ports, bindings: node.bindings });
  const parsed = parseNodeDefinition(json, 'valid-node.json');
  assert.deepEqual(parsed, node);
});

test('graph and control-loop JSON documents use the same parsers as YAML', async () => {
  const graphYaml = await readFile(fixture('graphs/fixed-dag.yml'), 'utf8');
  const graph = parseGraphDefinition(graphYaml, 'fixed-dag.yml');
  assert.deepEqual(parseGraphDefinition(JSON.stringify(graph), 'fixed-dag.json'), graph);

  const loopYaml = await readFile(fixture('loops/early-exit.yml'), 'utf8');
  const loop = parseLoopDefinition(loopYaml, 'early-exit.yml');
  assert.deepEqual(parseLoopDefinition(JSON.stringify(loop), 'early-exit.json'), loop);
});