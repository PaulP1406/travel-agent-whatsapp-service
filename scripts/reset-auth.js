import { rm } from 'node:fs/promises';
import { config } from '../src/config.js';

const targets = [config.authDataPath, '.wwebjs_cache'];

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
