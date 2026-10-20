import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { hashPassword, verifyPassword } from '../src/security.js';

export const testEnv = {
  OWNER_PASSWORD_HASH: hashPassword('a test password long enough'),
  COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters',
  OAUTH_REDIRECT_URIS: 'https://chatgpt.com/connector_platform_oauth_redirect',
};

test('passwords require strong length and verify without storing plaintext', () => {
  assert.throws(() => hashPassword('short'));
  assert(verifyPassword('a test password long enough', testEnv.OWNER_PASSWORD_HASH));
  assert(!verifyPassword('incorrect', testEnv.OWNER_PASSWORD_HASH));
});

test('configuration fails closed for missing auth, insecure origins and bad callbacks', () => {
  assert.throws(() => loadConfig({}));
  assert.equal(loadConfig(testEnv).publicUrl.origin, 'http://localhost:8080');
  assert.throws(() => loadConfig({ ...testEnv, PUBLIC_URL: 'http://example.com' }));
  assert.throws(() => loadConfig({ ...testEnv, PUBLIC_URL: 'https://example.com/mcp' }));
  assert.throws(() => loadConfig({ ...testEnv, OAUTH_REDIRECT_URIS: 'https://example.com/#fragment' }));
  assert.throws(() => loadConfig({ ...testEnv, AMP_ENABLED: 'true' }));
});
