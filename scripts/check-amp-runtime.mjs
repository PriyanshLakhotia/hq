// Local-only harness: public thread-ID validation rejects --help. No account call.
import { ProcessAmpAdapter } from '../dist/src/amp.js';
import { loadConfig } from '../dist/src/config.js';
import { hashPassword, randomToken } from '../dist/src/security.js';

const config = loadConfig({
  OWNER_PASSWORD_HASH: hashPassword('synthetic runtime check password'),
  COOKIE_SECRET: randomToken(),
  OAUTH_REDIRECT_URIS: 'https://client.example.invalid/oauth/callback',
});
const output = await new ProcessAmpAdapter(config).run(
  { operation: 'read', threadId: '--help' }, () => {}, AbortSignal.timeout(10000),
);
if (typeof output !== 'string' || !output.includes('Render a thread as markdown')) {
  throw new Error('Installed Amp CLI did not return its local help.');
}
console.log('Compiled Amp worker and installed CLI runtime check passed.');
