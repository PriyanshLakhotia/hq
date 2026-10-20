export interface Config {
  port: number;
  publicUrl: URL;
  databasePath: string;
  passwordHash: string;
  cookieSecret: string;
  redirectUris: string[];
  ampEnabled: boolean;
  ampApiKey?: string;
  ampExecutor: 'orb' | 'runner';
  ampRunnerId?: string;
  ampRunnerDir?: string;
  ampProject?: string;
  ampJobTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = new URL(env.PUBLIC_URL || 'http://localhost:8080');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !(loopback && publicUrl.protocol === 'http:')) {
    throw new Error('PUBLIC_URL must use HTTPS, except on localhost.');
  }
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
    throw new Error('PUBLIC_URL must be an origin without a path or credentials.');
  }
  const passwordHash = env.OWNER_PASSWORD_HASH ?? '';
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)) {
    throw new Error('Set OWNER_PASSWORD_HASH using npm run password.');
  }
  const cookieSecret = env.COOKIE_SECRET ?? '';
  if (cookieSecret.length < 32) throw new Error('COOKIE_SECRET must have at least 32 characters.');
  const redirectUris = (env.OAUTH_REDIRECT_URIS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (!redirectUris.length) throw new Error('Set an exact OAUTH_REDIRECT_URIS callback allowlist.');
  for (const uri of redirectUris) {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.hash || url.username || url.password) {
      throw new Error('OAuth callbacks must be absolute HTTPS URLs without fragments or credentials.');
    }
  }
  const ampExecutor = env.AMP_EXECUTOR || 'orb';
  if (ampExecutor !== 'orb' && ampExecutor !== 'runner') throw new Error('AMP_EXECUTOR must be orb or runner.');
  const ampEnabled = env.AMP_ENABLED === 'true';
  if (ampEnabled && !env.AMP_API_KEY) throw new Error('AMP_ENABLED requires AMP_API_KEY.');
  if (ampEnabled && ampExecutor === 'runner' && !env.AMP_RUNNER_ID) throw new Error('Runner execution requires AMP_RUNNER_ID.');
  const port = Number(env.PORT || 8080);
  const ampJobTimeoutMs = Number(env.AMP_JOB_TIMEOUT_MS || 1_800_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  if (!Number.isInteger(ampJobTimeoutMs) || ampJobTimeoutMs < 1000 || ampJobTimeoutMs > 7_200_000) {
    throw new Error('AMP_JOB_TIMEOUT_MS must be 1000–7200000.');
  }
  return {
    port, publicUrl, databasePath: env.DATABASE_PATH || './data/hq.db', passwordHash,
    cookieSecret, redirectUris, ampEnabled, ampExecutor, ampApiKey: env.AMP_API_KEY,
    ampRunnerId: env.AMP_RUNNER_ID, ampRunnerDir: env.AMP_RUNNER_DIR,
    ampProject: env.AMP_PROJECT, ampJobTimeoutMs,
  };
}
