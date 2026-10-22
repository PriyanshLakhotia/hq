import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { loadConfig } from '../src/config.js';
import { hashPassword, randomToken } from '../src/security.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

export const password = 'a test password long enough';
export const testEnv = {
  OWNER_PASSWORD_HASH: hashPassword(password),
  COOKIE_SECRET: 'test-cookie-secret-at-least-32-characters',
  OAUTH_REDIRECT_URIS: 'https://chatgpt.com/connector_platform_oauth_redirect',
};
export async function fixture(store = new Store(':memory:')) {
  const config = loadConfig(testEnv);
  const { app, oauth, domain } = await createApp(config, store);
  const http = app.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const port = (http.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const request = (path: string, init?: RequestInit) => fetch(base + path, { ...init, redirect: 'manual' });
  const close = async () => { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); };
  return { store, config, oauth, domain, request, base, close };
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function register(f: Fixture, name = 'Test MCP client', confidential = false) {
  const res = await f.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: name, redirect_uris: [testEnv.OAUTH_REDIRECT_URIS], token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }) });
  if (res.status !== 201) throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
  return await res.json() as { client_id: string; client_secret?: string };
}
export async function consent(f: Fixture, client: { client_id: string }, scope = 'hq:read hq:write') {
  const verifier = randomToken();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: testEnv.OAUTH_REDIRECT_URIS, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', state: 'test-state', scope, resource: f.oauth.resource.href });
  const authorize = await f.request('/authorize?' + query);
  const cookie = authorize.headers.get('set-cookie')!.split(';')[0]!;
  const location = authorize.headers.get('location')!;
  const page = await (await f.request(location, { headers: { cookie } })).text();
  const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
  const pending = new URL(location, f.base).searchParams.get('request')!;
  const res = await f.request('/oauth/consent', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: new URLSearchParams({ request: pending, csrf, password, decision: 'allow' }) });
  const redirect = new URL(res.headers.get('location')!);
  return { code: redirect.searchParams.get('code')!, verifier, redirect, page };
}
export async function token(f: Fixture, client: { client_id: string; client_secret?: string }, code: string, verifier: string, extras: Record<string, string> = {}) {
  return f.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', ...client, code, code_verifier: verifier, redirect_uri: testEnv.OAUTH_REDIRECT_URIS, resource: f.oauth.resource.href, ...extras }) });
}
export async function connect(f: Fixture, scope = 'hq:read hq:write') {
  const client = await register(f);
  const authorization = await consent(f, client, scope);
  const response = await token(f, client, authorization.code, authorization.verifier);
  if (response.status !== 200) throw new Error(`Token failed: ${response.status} ${await response.text()}`);
  return { client, tokens: await response.json() as { access_token: string; refresh_token: string; scope: string } };
}
