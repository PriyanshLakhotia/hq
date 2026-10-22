// Synthetic local help check only. No Amp account or network request.
import { ProcessAmpAdapter } from '../dist/src/amp.js';
import { loadConfig } from '../dist/src/config.js';
import { hashPassword, randomToken } from '../dist/src/security.js';
const config = loadConfig({
  OWNER_PASSWORD_HASH: hashPassword('synthetic runtime check password'), COOKIE_SECRET: randomToken(),
  OAUTH_REDIRECT_URIS: 'https://client.example.invalid/callback',
});
const result = await new ProcessAmpAdapter(config).run({ operation: 'read', threadId: '--help' }, () => {}, AbortSignal.timeout(10000));
if (typeof result !== 'string' || !result.includes('Render a thread as markdown')) throw new Error('Amp CLI startup failed.');
console.log('Compiled Amp worker/CLI runtime check passed.');
