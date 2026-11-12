import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Every browser test run gets its own database; production accounts are never used.
const directory = mkdtempSync(join(tmpdir(), 'werewolf-browser-'));
Object.assign(process.env, { PORT: '3199', AUTH_RATE_LIMIT: '1000', DB_PATH: join(directory, 'accounts.db'), MULTI_ACCOUNT: '1', SEED_ACCOUNTS: '1', SKIP_ROLE_REVEAL: '0' });
await import('../../server/index.js');
