import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Config } from './config.js';
import { Store } from './store.js';
import { Domain } from './domain.js';
import { OAuthProvider, SCOPES } from './oauth.js';
import { createMcpServer, type ExtraTool } from './mcp.js';
import { homePage } from './pages.js';

export function createApp(config: Config, store: Store, extraTools: ExtraTool[] = []) {
  const app = express();
  const oauth = new OAuthProvider(store, config);
  const domain = new Domain(store, () => new Date(), config.timeZone);
  app.disable('x-powered-by');
  app.use(hostHeaderValidation([config.publicUrl.hostname, '127.0.0.1', 'localhost']));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    if (config.publicUrl.protocol === 'https:') res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb' }));
  app.get('/', (_req, res) => res.type('html').send(homePage()));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.use(mcpAuthRouter({ provider: oauth, issuerUrl: config.publicUrl, resourceServerUrl: oauth.resource, scopesSupported: SCOPES, resourceName: 'HQ personal tools' }));
  app.get('/oauth/consent', (req, res) => oauth.showConsent(req, res));
  app.post('/oauth/consent', rateLimit({ windowMs: 900_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }), (req, res) => oauth.submitConsent(req, res));
  const bearer = requireBearerAuth({ verifier: oauth, expectedResource: oauth.resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauth.resource) });
  const mcpLimit = rateLimit({ windowMs: 60_000, limit: 240, keyGenerator: req => req.auth!.clientId, standardHeaders: 'draft-8', legacyHeaders: false });
  app.use('/mcp', bearer, mcpLimit, (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== config.publicUrl.origin) { res.status(403).json({ error: 'Untrusted Origin' }); return; }
    next();
  });
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer(domain, req.auth!.scopes, extraTools);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ error: 'Stateless MCP accepts POST requests.' }));
  app.use(((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    // Never log request bodies, Authorization headers, OAuth codes, or upstream output.
    if (status === 500) console.error('HQ request failed. No request content was logged.');
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request body' });
  }) satisfies ErrorRequestHandler);
  return { app, oauth, domain };
}
