import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const release = Object.freeze({
  version,
  revision: process.env.APP_REVISION || 'development',
  builtAt: process.env.APP_BUILD_DATE || null,
});
