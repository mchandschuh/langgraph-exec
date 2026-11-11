#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = resolve(repositoryRoot, 'package.json');
const localPrefix = resolve(process.env.HOME ?? '', '.local');

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited with code ${code ?? 'unknown'}.`)));
  });
}

const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
if (packageJson.name !== 'langgraph-exec') throw new Error('This installer must run from the langgraph-exec repository.');
if (!packageJson.bin || typeof packageJson.bin !== 'object') throw new Error('package.json must declare at least one bin entry.');
await lstat(repositoryRoot);

console.log(`Installing ${packageJson.name}@${packageJson.version} from ${repositoryRoot}`);
await run('corepack', ['yarn', 'install']);
await run('corepack', ['yarn', 'build']);
await run('npm', ['--prefix', localPrefix, 'link', repositoryRoot]);

for (const binary of Object.keys(packageJson.bin)) {
  await run('sh', ['-c', `command -v ${JSON.stringify(binary)} && ${JSON.stringify(binary)} --help`]);
}

console.log(`Registered ${packageJson.name}@${packageJson.version} in ${localPrefix}.`);