export interface Config {
  port: number;
  timeZone: string;
  publicUrl: URL;
  storageBackend: 'memory' | 'firestore';
  firestoreProject?: string;
  firestoreDatabase: string;
  firestorePrefix: string;
  jobBackend: 'manual' | 'cloudtasks';
  tasksQueue?: string;
  tasksServiceAccount?: string;
  ampMaxJobsPerDay: number;
  ampDailyBudgetSeconds: number;
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
  const ampJobTimeoutMs = Number(env.AMP_JOB_TIMEOUT_MS || 600_000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  if (!Number.isInteger(ampJobTimeoutMs) || ampJobTimeoutMs < 1000 || ampJobTimeoutMs > 1_200_000) {
    throw new Error('AMP_JOB_TIMEOUT_MS must be 1000–1200000.');
  }
  const timeZone = env.TIME_ZONE || 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone }).format(); } catch { throw new Error('TIME_ZONE must be an IANA time zone.'); }
  const storageBackend = env.STORAGE_BACKEND || (env.K_SERVICE ? 'firestore' : 'memory');
  if (storageBackend !== 'memory' && storageBackend !== 'firestore') throw new Error('STORAGE_BACKEND must be memory or firestore.');
  if (env.K_SERVICE && storageBackend !== 'firestore') throw new Error('Cloud Run requires Firestore; memory storage is development-only.');
  const firestoreProject = env.GOOGLE_CLOUD_PROJECT;
  if (storageBackend === 'firestore' && !firestoreProject) throw new Error('Firestore requires GOOGLE_CLOUD_PROJECT.');
  if (env.K_SERVICE && env.FIRESTORE_EMULATOR_HOST) throw new Error('Cloud Run must not use a Firestore emulator.');
  const jobBackend = env.JOB_BACKEND || (env.K_SERVICE ? 'cloudtasks' : 'manual');
  if (jobBackend !== 'manual' && jobBackend !== 'cloudtasks') throw new Error('JOB_BACKEND must be manual or cloudtasks.');
  if (env.K_SERVICE && jobBackend !== 'cloudtasks') throw new Error('Cloud Run requires durable Cloud Tasks delivery.');
  const tasksQueue = env.CLOUD_TASKS_QUEUE;
  const tasksServiceAccount = env.TASKS_SERVICE_ACCOUNT;
  if (jobBackend === 'cloudtasks' && (!tasksQueue || !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/queues\/[a-zA-Z0-9_-]+$/.test(tasksQueue)
      || !tasksServiceAccount || !/^[a-zA-Z0-9_-]+@[a-zA-Z0-9-]+\.iam\.gserviceaccount\.com$/.test(tasksServiceAccount)
      || publicUrl.protocol !== 'https:')) throw new Error('Cloud Tasks requires a queue resource, TASKS_SERVICE_ACCOUNT and HTTPS PUBLIC_URL.');
  const ampMaxJobsPerDay = Number(env.AMP_MAX_JOBS_PER_DAY || 10);
  const ampDailyBudgetSeconds = Number(env.AMP_DAILY_BUDGET_SECONDS || 1800);
  if (!Number.isInteger(ampMaxJobsPerDay) || ampMaxJobsPerDay < 1 || ampMaxJobsPerDay > 100
      || !Number.isInteger(ampDailyBudgetSeconds) || ampDailyBudgetSeconds < ampJobTimeoutMs / 1000 || ampDailyBudgetSeconds > 86_400) {
    throw new Error('Invalid daily Amp limits; the daily time budget must cover at least one job timeout.');
  }
  const firestorePrefix = env.FIRESTORE_PREFIX || 'hq';
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,60}$/.test(firestorePrefix)) throw new Error('Invalid FIRESTORE_PREFIX.');
  return {
    timeZone, port, publicUrl, storageBackend, firestoreProject, firestoreDatabase: env.FIRESTORE_DATABASE || '(default)', firestorePrefix,
    jobBackend, tasksQueue, tasksServiceAccount, ampMaxJobsPerDay, ampDailyBudgetSeconds, passwordHash,
    cookieSecret, redirectUris, ampEnabled, ampExecutor, ampApiKey: env.AMP_API_KEY,
    ampRunnerId: env.AMP_RUNNER_ID, ampRunnerDir: env.AMP_RUNNER_DIR,
    ampProject: env.AMP_PROJECT, ampJobTimeoutMs,
  };
}
