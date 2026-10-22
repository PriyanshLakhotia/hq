import { test } from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { digest } from '../src/security.js';
import { OAuthProvider } from '../src/oauth.js';
import { fixture, register, consent, token, connect, testEnv } from './helpers.js';

test('discovery advertises the exact protected resource and anonymous requests fail closed', async () => {
  const f = await fixture();
  try {
    const res = await f.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
    const metadata = await (await f.request('/.well-known/oauth-protected-resource/mcp')).json() as any;
    assert.equal(metadata.resource, f.oauth.resource.href);
    const auth = await (await f.request('/.well-known/oauth-authorization-server')).json() as any;
    assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      httpRequest(f.base, { headers: { host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
    });
    assert.equal(invalidHost, 403);
    assert.equal((await f.request('/healthz')).status, 200);
  } finally { await f.close(); }
});

test('registration rejects unapproved callbacks; PKCE, client and redirect binding protect single-use codes', async () => {
  const f = await fixture();
  try {
    const bad = await f.request('/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://attacker.example/callback'] }) });
    assert.equal(bad.status, 400);
    const client = await register(f, '<script>untrusted name</script>', true);
    const other = await register(f, 'Another client');
    const auth = await consent(f, client);
    assert.equal(auth.redirect.searchParams.get('state'), 'test-state');
    assert(!auth.page.includes('<script>untrusted'));
    assert.equal((await token(f, other, auth.code, auth.verifier)).status, 400);
    assert.equal((await token(f, client, auth.code, 'wrong-verifier')).status, 400);
    assert.equal((await token(f, client, auth.code, auth.verifier, { redirect_uri: 'https://attacker.example' })).status, 400);
    assert.equal((await token(f, client, auth.code, auth.verifier, { resource: 'https://attacker.example/mcp' })).status, 400);
    const response = await token(f, client, auth.code, auth.verifier);
    assert.equal(response.status, 200);
    const tokens = await response.json() as any;
    assert.equal((await token(f, client, auth.code, auth.verifier)).status, 400);
    const stored = JSON.stringify(await Promise.all(['oauth_clients', 'oauth_codes', 'oauth_access', 'oauth_refresh', 'oauth_families'].map(ns => f.store.all(ns))));
    for (const secret of [tokens.access_token, tokens.refresh_token, auth.code, client.client_secret]) assert(!stored.includes(secret));
    const reloaded = new OAuthProvider(f.store, f.config);
    assert.equal((await reloaded.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
    assert.equal((await reloaded.clientsStore.getClient(client.client_id))!.client_secret, client.client_secret);
  } finally { await f.close(); }
});

test('consent requires browser binding and a matching CSRF token', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request('/oauth/consent?request=forged')).status, 400);
    const res = await f.request('/oauth/consent', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: 'forged', csrf: 'forged', password: 'not-secret' }) });
    assert.equal(res.status, 403);
    const client = await register(f);
    const redirectAttack = await f.request('/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: 'https://attacker.example/callback', response_type: 'code' }));
    assert.equal(redirectAttack.status, 400);
    assert.equal(redirectAttack.headers.get('location'), null);
  } finally { await f.close(); }
});

test('official MCP client can initialize, list tools, write, read and receive domain validation', async () => {
  const f = await fixture();
  const client = new Client({ name: 'integration-test', version: '1.0' });
  try {
    const { tokens } = await connect(f);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.base), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
      ['hq_status', 'lists_get', 'list_create', 'list_archive', 'items_add', 'items_get', 'item_update'].sort());
    assert.equal((await client.callTool({ name: 'items_add', arguments: { list: 'shopping', items: [{ title: 'Bread' }], idempotencyKey: 'http-write-1' } })).isError, undefined);
    const read = await client.callTool({ name: 'items_get', arguments: { list: 'shopping' } });
    assert.equal((read.structuredContent as any).data.items[0].title, 'Bread');
    const invalid = await client.callTool({ name: 'item_update', arguments: { itemId: 'not-an-item', status: 'done' } });
    assert.equal(invalid.isError, true);
    assert.equal(client.getServerCapabilities()?.prompts, undefined);
    const status = await client.callTool({ name: 'hq_status', arguments: {} });
    assert.deepEqual((status.structuredContent as any).data.features, ['lists', 'amp']);
    const origin = await f.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(origin.status, 403);
  } finally { await client.close(); await f.close(); }
});

test('read-only scope cannot invoke writes, and token expiry is enforced', async () => {
  const f = await fixture();
  const client = new Client({ name: 'read-test', version: '1.0' });
  try {
    const { tokens } = await connect(f, 'hq:read');
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.base), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert(names.includes('items_get'));
    assert(!names.includes('items_add'));
    const denied = await client.callTool({ name: 'items_add', arguments: { items: [{ title: 'Denied write' }] } });
    assert.equal(denied.isError, true);
    assert.equal((await f.domain.getItems()).total, 0);
    const grant = await f.store.get<any>('oauth_access', digest(tokens.access_token));
    await f.store.put('oauth_access', digest(tokens.access_token), { ...grant, expiresAt: Date.now() - 1 });
    assert.equal((await f.request('/mcp', { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  } finally { await client.close(); await f.close(); }
});

test('refresh rotates, rejects scope escalation and revokes the token family on replay', async () => {
  const f = await fixture();
  try {
    const { client, tokens } = await connect(f, 'hq:read');
    const refresh = (raw: string, scope?: string) => f.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: raw, ...(scope ? { scope } : {}) }) });
    assert.equal((await refresh(tokens.refresh_token, 'hq:read hq:write')).status, 400);
    const response = await refresh(tokens.refresh_token);
    assert.equal(response.status, 200);
    const rotated = await response.json() as any;
    assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    assert.equal((await refresh(tokens.refresh_token)).status, 400);
    await assert.rejects(() => f.oauth.verifyAccessToken(rotated.access_token));
    assert.equal((await refresh(rotated.refresh_token)).status, 400);
  } finally { await f.close(); }
});

test('revocation is client-bound and invalidates connected token families', async () => {
  const f = await fixture();
  try {
    const { client, tokens } = await connect(f);
    const other = await register(f);
    await f.oauth.revokeToken(other as any, { token: tokens.access_token });
    assert.equal((await f.oauth.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
    const revoke = await f.request('/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, token: tokens.refresh_token }) });
    assert.equal(revoke.status, 200);
    await assert.rejects(() => f.oauth.verifyAccessToken(tokens.access_token));
    assert.equal(testEnv.OAUTH_REDIRECT_URIS.startsWith('https:'), true);
  } finally { await f.close(); }
});

test('consent refuses wrong passwords and missing browser binding, and permits the registered redirect through CSP', async () => {
  const f = await fixture();
  try {
    const client = await register(f);
    const { createHash } = await import('node:crypto');
    const verifier = 'v'.repeat(43);
    const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: testEnv.OAUTH_REDIRECT_URIS, response_type: 'code', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const authorization = await f.request('/authorize?' + query);
    const cookie = authorization.headers.get('set-cookie')!.split(';')[0]!;
    const location = authorization.headers.get('location')!;
    assert.equal((await f.request(location)).status, 400);
    const response = await f.request(location, { headers: { cookie } });
    assert.match(response.headers.get('content-security-policy')!, /form-action 'self' https:\/\/chatgpt.com;/);
    const page = await response.text();
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1]!;
    const pending = new URL(location, f.base).searchParams.get('request')!;
    const post = (tokenValue: string, passwordValue: string) => f.request('/oauth/consent', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: pending, csrf: tokenValue, password: passwordValue, decision: 'allow' }) });
    assert.equal((await post('é'.repeat(43), 'wrong')).status, 403);
    assert.equal((await post(csrf, 'wrong password')).status, 401);
    assert.equal((await f.store.all('oauth_codes')).length, 0);
    assert.equal((await f.store.all('oauth_access')).length, 0);
  } finally { await f.close(); }
});

test('OAuth grants survive new server instances using the shared database', async () => {
  const { Store, MemoryDriver } = await import('../src/store.js');
  const driver = new MemoryDriver();
  let f = await fixture(new Store(driver));
  try {
    const { client, tokens } = await connect(f);
    await f.domain.addItems({ items: [{ title: 'Persist across restart' }] });
    await f.close();
    f = await fixture(new Store(driver));
    assert.equal((await f.oauth.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
    assert.equal((await f.oauth.clientsStore.getClient(client.client_id))?.client_id, client.client_id);
    assert.equal((await f.domain.getItems()).items[0]?.title, 'Persist across restart');
    const refreshed = await f.oauth.exchangeRefreshToken((await f.oauth.clientsStore.getClient(client.client_id))!, tokens.refresh_token);
    assert(refreshed.access_token);
  } finally { await f.close(); }
});
