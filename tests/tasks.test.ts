import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { CloudTaskQueue, googleInternalVerifier } from '../src/tasks.js';
import { createApp } from '../src/app.js';
import { AmpService, TaskBusyError } from '../src/amp.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { testEnv } from './helpers.js';
const settings = () => loadConfig({ ...testEnv, PUBLIC_URL: 'https://hq.example.invalid', STORAGE_BACKEND: 'firestore', GOOGLE_CLOUD_PROJECT: 'demo-hq',
  JOB_BACKEND: 'cloudtasks', CLOUD_TASKS_QUEUE: 'projects/demo-hq/locations/us-central1/queues/hq-amp', TASKS_SERVICE_ACCOUNT: 'hq-tasks@demo-hq.iam.gserviceaccount.com' });

test('Cloud Run fails closed on ephemeral storage, manual dispatch, emulator configuration and unbounded timeouts', () => {
  assert.throws(() => loadConfig({ ...testEnv, K_SERVICE: 'hq', STORAGE_BACKEND: 'memory' }), /requires Firestore/);
  assert.throws(() => loadConfig({ ...testEnv, K_SERVICE: 'hq', GOOGLE_CLOUD_PROJECT: 'demo-hq', JOB_BACKEND: 'manual' }), /durable Cloud Tasks/);
  assert.throws(() => loadConfig({ ...testEnv, K_SERVICE: 'hq', GOOGLE_CLOUD_PROJECT: 'demo-hq', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8787' }), /emulator/);
  assert.throws(() => loadConfig({ ...testEnv, AMP_JOB_TIMEOUT_MS: '1800001' }), /1000–1200000/);
  assert.throws(() => loadConfig({ ...testEnv, AMP_DAILY_BUDGET_SECONDS: '100' }), /daily Amp limits/);
  assert.throws(() => loadConfig({ ...testEnv, JOB_BACKEND: 'cloudtasks' }), /Cloud Tasks requires/);
});

test('task payloads contain only an ID, a deterministic name, bounded deadline and the expected OIDC audience', async () => {
  const cfg = settings(); const requests: any[] = [];
  const client = { createTask: async (request: unknown) => { requests.push(request); } };
  const queue = new CloudTaskQueue(cfg, client as any);
  const id = '12345678-1234-1234-1234-123456789abc';
  await queue.enqueue(id); await queue.enqueue(id);
  assert.equal(requests[0].task.name, requests[1].task.name);
  assert.deepEqual(JSON.parse(requests[0].task.httpRequest.body.toString()), { jobId: id });
  assert.equal(requests[0].task.dispatchDeadline.seconds, 720);
  assert.equal(requests[0].task.httpRequest.oidcToken.audience, cfg.publicUrl.origin);
  assert.equal(requests[0].task.httpRequest.url, 'https://hq.example.invalid/internal/amp/run');
  await new CloudTaskQueue(cfg, { createTask: async () => { throw { code: 6 }; } } as any).enqueue(id);
  await assert.rejects(() => new CloudTaskQueue(cfg, { createTask: async () => { throw { code: 7 }; } } as any).enqueue(id), /scheduling is unavailable/);
});

test('internal verifier delegates signature/audience checks and restricts the verified service-account email', async () => {
  const cfg = settings(); let verified = false; let email = cfg.tasksServiceAccount; let observed: any;
  const client = { verifyIdToken: async (value: unknown) => { observed = value; return { getPayload: () => ({ email_verified: verified, email }) }; } };
  const verify = googleInternalVerifier(cfg, client as any);
  assert.equal(await verify('opaque-token'), false);
  verified = true; email = 'attacker@other.iam.gserviceaccount.com'; assert.equal(await verify('opaque-token'), false);
  email = cfg.tasksServiceAccount; assert.equal(await verify('opaque-token'), true);
  assert.equal(observed.audience, cfg.publicUrl.origin);
  assert.equal(await googleInternalVerifier(cfg, { verifyIdToken: async () => { throw new Error('bad signature'); } } as any)('bad'), false);
});

test('worker routes reject forged task headers and await work before acknowledging delivery', async () => {
  const store = new Store(); const cfg = loadConfig(testEnv); const amp = new AmpService(store, cfg);
  let calls = 0; let busy = false;
  amp.runQueued = async () => { calls++; if (busy) throw new TaskBusyError('busy'); };
  amp.maintain = async () => ({ recovered: 0, checked: 0 });
  const { app } = await createApp(cfg, store, [], { amp, verify: async token => token === 'verified-test-identity' });
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const base = `http://127.0.0.1:${(http.address() as any).port}`;
  const post = (path: string, auth?: string, body = { jobId: '12345678-1234-1234-1234-123456789abc' }) => fetch(base + path, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-cloudtasks-taskname': 'forged-header', ...(auth ? { authorization: `Bearer ${auth}` } : {}),
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/internal/amp/run')).status, 401);
    assert.equal((await post('/internal/amp/run', 'not-a-google-identity')).status, 401);
    assert.equal(calls, 0);
    assert.equal((await post('/internal/amp/run', 'verified-test-identity', { jobId: 'bad' })).status, 400);
    assert.equal((await post('/internal/amp/run', 'verified-test-identity')).status, 204);
    busy = true; assert.equal((await post('/internal/amp/run', 'verified-test-identity')).status, 503);
    assert.equal((await post('/internal/maintenance', 'verified-test-identity')).status, 200);
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await store.close(); }
});
