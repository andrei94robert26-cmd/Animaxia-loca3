import { spawn } from 'node:child_process';

const child = spawn(
  process.execPath,
  ['tests/miner-providers.mjs'],
  { stdio: 'inherit', cwd: process.cwd() }
);

child.on('exit', code => process.exit(code ?? 1));
