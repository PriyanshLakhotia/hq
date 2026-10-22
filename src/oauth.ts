import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Config } from './config.js';
import { digest, randomToken, verifyPassword } from './security.js';
import { Store, type Reader, type Transaction } from './store.js';
import { consentPage } from './pages.js';

export const SCOPES = ['hq:read', 'hq:write', 'amp:read', 'amp:execute'];
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86_400;
interface Grant { clientId: string; scopes: string[]; resource: string; family: string; expiresAt: number }
interface Code extends Grant { challenge: string; redirectUri: string }
interface Refresh extends Grant { used: boolean }
interface Pending { clientId: string; scopes: string[]; challenge: string; redirectUri: string; state?: string; resource: string; browserHash: string; expiresAt: number }
interface StoredClient { client: OAuthClientInformationFull; encryptedSecret?: string }

export class OAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resource: URL;
  constructor(readonly store: Store, readonly config: Config) {
    this.resource = new URL('/mcp', config.publicUrl);
    this.clientsStore = {
      getClient: async clientId => {
        const stored = await store.get<StoredClient>('oauth_clients', clientId);
        if (!stored) return undefined;
        return { ...stored.client, ...(stored.encryptedSecret ? { client_secret: this.decrypt(stored.encryptedSecret) } : {}) };
      },
      registerClient: async client => {
        if (!client.redirect_uris.length || client.redirect_uris.some(uri => !config.redirectUris.includes(uri))) {
          throw new InvalidClientMetadataError('Every callback must appear exactly in OAUTH_REDIRECT_URIS.');
        }
        if (!['none', 'client_secret_post'].includes(client.token_endpoint_auth_method ?? 'client_secret_post')) {
          throw new InvalidClientMetadataError('Supported authentication methods: none, client_secret_post.');
        }
        if (client.grant_types?.some(grant => !['authorization_code', 'refresh_token'].includes(grant))) {
          throw new InvalidClientMetadataError('Only authorization_code and refresh_token grants are supported.');
        }
        if (client.response_types?.some(type => type !== 'code')) throw new InvalidClientMetadataError('Only code responses are supported.');
        const full: OAuthClientInformationFull = { ...client, client_id: randomToken(), client_id_issued_at: Math.floor(Date.now() / 1000) };
        const { client_secret, ...publicClient } = full;
        await store.put('oauth_clients', full.client_id, { client: publicClient, encryptedSecret: client_secret ? this.encrypt(client_secret) : undefined } satisfies StoredClient);
        return full;
      },
    };
  }
  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(this.config.cookieSecret).digest(), iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
  }
  private decrypt(value: string) {
    const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
    const cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(this.config.cookieSecret).digest(), iv!);
    cipher.setAuthTag(tag!);
    return Buffer.concat([cipher.update(ciphertext!), cipher.final()]).toString('utf8');
  }
  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidTargetError('Tokens are only issued for this MCP resource.');
  }
  private checkScopes(scopes: string[]) {
    if (!scopes.length || scopes.some(scope => !SCOPES.includes(scope))) throw new InvalidScopeError('Unknown or empty scope.');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource);
    const scopes = params.scopes?.length ? [...new Set(params.scopes)] : ['hq:read', 'hq:write', 'amp:read', ...(this.config.ampEnabled ? ['amp:execute'] : [])];
    this.checkScopes(scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('Invalid S256 challenge.');
    const request = randomToken();
    const browser = randomToken();
    await this.store.put('oauth_pending', digest(request), {
      clientId: client.client_id, scopes, challenge: params.codeChallenge, redirectUri: params.redirectUri,
      state: params.state, resource: this.resource.href, browserHash: digest(browser), expiresAt: Date.now() + 600_000,
    } satisfies Pending);
    res.cookie('hq_consent', browser, { httpOnly: true, secure: this.config.publicUrl.protocol === 'https:', sameSite: 'lax', path: '/oauth/consent', maxAge: 600_000 });
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(request)}`);
  }
  private async pending(req: Request): Promise<{ request: string; pending: Pending; csrf: string } | undefined> {
    const request = req.method === 'POST' ? req.body?.request : req.query.request;
    if (typeof request !== 'string' || request.length > 100) return undefined;
    const pending = await this.store.get<Pending>('oauth_pending', digest(request));
    const cookie = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith('hq_consent='))?.slice('hq_consent='.length);
    if (!pending || pending.expiresAt < Date.now() || !cookie || digest(cookie) !== pending.browserHash) return undefined;
    const csrf = createHmac('sha256', this.config.cookieSecret).update(`${request}:${cookie}`).digest('base64url');
    return { request, pending, csrf };
  }
  async showConsent(req: Request, res: Response) {
    const context = await this.pending(req);
    if (!context) { res.status(400).send('Consent request expired. Start connecting again.'); return; }
    const client = await this.clientsStore.getClient(context.pending.clientId);
    res.type('html').send(consentPage({ request: context.request, csrf: context.csrf, clientName: client?.client_name || 'MCP client', callback: context.pending.redirectUri, scopes: context.pending.scopes }));
  }
  async submitConsent(req: Request, res: Response) {
    const context = await this.pending(req);
    const csrf = req.body?.csrf;
    if (!context || typeof csrf !== 'string' || Buffer.byteLength(csrf) !== Buffer.byteLength(context.csrf) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(context.csrf))) {
      res.status(403).send('Invalid consent request. Start connecting again.'); return;
    }
    // Origin is defense in depth. The random browser binding and form CSRF token are required too.
    if (req.headers.origin && req.headers.origin !== this.config.publicUrl.origin) {
      res.status(403).send('Invalid origin.'); return;
    }
    const redirect = new URL(context.pending.redirectUri);
    if (context.pending.state !== undefined) redirect.searchParams.set('state', context.pending.state);
    if (req.body?.decision === 'deny') {
      await this.store.delete('oauth_pending', digest(context.request));
      redirect.searchParams.set('error', 'access_denied');
      res.redirect(303, redirect.href); return;
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length > 1024 || !verifyPassword(password, this.config.passwordHash)) {
      res.status(401).send('Incorrect password. Go back to retry or restart the connection.'); return;
    }
    const code = randomToken();
    await this.store.transaction(async tx => {
      if (!await tx.get('oauth_pending', digest(context.request))) throw new InvalidGrantError('Consent was already used.');
      tx.delete('oauth_pending', digest(context.request));
      tx.put('oauth_codes', digest(code), {
        clientId: context.pending.clientId, scopes: context.pending.scopes, resource: context.pending.resource,
        challenge: context.pending.challenge, redirectUri: context.pending.redirectUri,
        family: randomToken(), expiresAt: Date.now() + 120_000,
      } satisfies Code);
    });
    res.clearCookie('hq_consent', { path: '/oauth/consent' });
    redirect.searchParams.set('code', code);
    res.redirect(303, redirect.href);
  }
  private async code(client: OAuthClientInformationFull, raw: string, reader: Reader = this.store): Promise<Code> {
    const code = await reader.get<Code>('oauth_codes', digest(raw));
    if (!code || code.clientId !== client.client_id || code.expiresAt < Date.now()) throw new InvalidGrantError('Invalid or expired authorization code.');
    return code;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, raw: string) { return (await this.code(client, raw)).challenge; }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, raw: string, _verifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    return this.store.transaction(async tx => {
      const code = await this.code(client, raw, tx);
      if (redirectUri !== code.redirectUri) throw new InvalidGrantError('The exact original redirect_uri is required.');
      tx.delete('oauth_codes', digest(raw));
      tx.put('oauth_families', code.family, { revoked: false, expiresAt: Date.now() + REFRESH_SECONDS * 1000 });
      return this.issue(code, tx);
    });
  }
  private issue(grant: Grant, tx: Transaction): OAuthTokens {
    const access = randomToken();
    const refresh = randomToken();
    tx.put('oauth_access', digest(access), { ...grant, expiresAt: Date.now() + ACCESS_SECONDS * 1000 });
    tx.put('oauth_refresh', digest(refresh), { ...grant, expiresAt: Date.now() + REFRESH_SECONDS * 1000, used: false } satisfies Refresh);
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ACCESS_SECONDS, scope: grant.scopes.join(' ') };
  }
  private revokeFamily(family: string, tx: Transaction) {
    tx.put('oauth_families', family, { revoked: true, expiresAt: Date.now() + REFRESH_SECONDS * 1000 });
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, raw: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    // Revocation on replay must commit, even though the OAuth request fails.
    const result = await this.store.transaction(async tx => {
      const refresh = await tx.get<Refresh>('oauth_refresh', digest(raw));
      if (!refresh || refresh.clientId !== client.client_id || refresh.expiresAt < Date.now()) return undefined;
      const family = await tx.get<{ revoked: boolean }>('oauth_families', refresh.family);
      if (!family || family.revoked) return undefined;
      if (refresh.used) { this.revokeFamily(refresh.family, tx); return undefined; }
      const requested = scopes ?? refresh.scopes;
      this.checkScopes(requested);
      if (requested.some(scope => !refresh.scopes.includes(scope))) throw new InvalidScopeError('Refresh cannot increase granted scope.');
      refresh.used = true;
      tx.put('oauth_refresh', digest(raw), refresh);
      tx.put('oauth_families', refresh.family, { revoked: false, expiresAt: Date.now() + REFRESH_SECONDS * 1000 });
      return this.issue({ ...refresh, scopes: requested }, tx);
    });
    if (!result) throw new InvalidGrantError('Refresh token expired, revoked, or reused. Reconnect the client.');
    return result;
  }
  async verifyAccessToken(raw: string): Promise<AuthInfo> {
    const grant = await this.store.get<Grant>('oauth_access', digest(raw));
    if (!grant || grant.expiresAt < Date.now() || grant.resource !== this.resource.href) throw new InvalidTokenError('Invalid or expired access token.');
    const family = await this.store.get<{ revoked: boolean }>('oauth_families', grant.family);
    if (!family || family.revoked) throw new InvalidTokenError('Authorization was revoked. Reconnect the client.');
    return { token: raw, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(grant.expiresAt / 1000), resource: this.resource };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await this.store.transaction(async tx => {
      const grant = await this.store.get<Grant>('oauth_access', digest(request.token)) ?? await tx.get<Grant>('oauth_refresh', digest(request.token));
      if (grant?.clientId === client.client_id) this.revokeFamily(grant.family, tx);
    });
  }
}
