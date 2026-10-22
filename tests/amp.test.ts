import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { AmpService, TaskBusyError, ampEnvironment, ProcessAmpAdapter, type AmpAdapter, type AmpJob } from '../src/amp.js';
import type { AmpEvent, WorkerRequest } from '../src/amp-protocol.js';
import type { TaskQueue } from '../src/tasks.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { testEnv } from './helpers.js';
const config = (extra = {}) => loadConfig({ ...testEnv, AMP_ENABLED: 'true', AMP_API_KEY: 'test-value-only', ...extra });
const remoteThread = 'T-12345678-1234-1234-1234-123456789abc';
class FakeQueue implements TaskQueue {
  ids = new Set<string>(); unavailable = false;
  async enqueue(id: string) { if (this.unavailable) throw new Error('unavailable'); this.ids.add(id); }
}
class FakeAmp implements AmpAdapter {
  calls: WorkerRequest[] = [];
  pending: { event: (event: AmpEvent) => void; finish: () => void }[] = [];
  markdown = '# Conversation\n'.repeat(100) + 'LATEST';
  async run(request: WorkerRequest, event: (event: AmpEvent) => void, signal: AbortSignal) {
    this.calls.push(request);
    if (request.operation === 'list') return [{ id: remoteThread, upstreamField: 42 }];
    if (request.operation === 'read') return this.markdown;
    if (request.operation === 'live') return { activeThreads: [remoteThread] };
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ event, finish: resolve });
      signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true });
    });
  }
}
async function until(fn: () => boolean) { for (let i = 0; i < 100; i++) { if (fn()) return; await setImmediate(); } throw new Error('Expected state not reached'); }

test('dispatch persists without starting work; duplicate task delivery executes at most once', async () => {
  const store = new Store(); const adapter = new FakeAmp(); const queue = new FakeQueue();
  const service = new AmpService(store, config(), adapter, queue);
  try {
    const input = { prompt: 'Review cache', idempotencyKey: 'durable-request-1' };
    const job = await service.start(input);
    assert.equal(job.status, 'queued'); assert.equal(adapter.calls.length, 0);
    assert.equal((await service.start(input)).id, job.id); assert.equal(queue.ids.size, 1);
    const worker = service.runQueued(job.id);
    await until(() => adapter.pending.length === 1);
    await assert.rejects(() => new AmpService(store, config(), adapter, queue).runQueued(job.id), TaskBusyError);
    adapter.pending[0]!.event({ type: 'system', sessionId: remoteThread });
    adapter.pending[0]!.event({ type: 'result', success: true, text: 'Cache reviewed.', permissionDenials: ['Bash'] });
    adapter.pending[0]!.finish(); await worker;
    const done = await service.getJob({ jobId: job.id });
    assert.equal(done.status, 'succeeded'); assert.equal(done.latestText, 'Cache reviewed.');
    assert.deepEqual(done.permissionDenials, ['Bash']);
    await service.runQueued(job.id); assert.equal(adapter.calls.length, 1);
    assert.equal(await store.get('amp_control', 'worker'), undefined);
    const next = await service.start({ prompt: 'Explain results', threadId: remoteThread, idempotencyKey: 'followup-request-1' });
    assert.equal(next.status, 'queued');
    await assert.rejects(() => service.start({ prompt: 'Other', threadId: remoteThread, idempotencyKey: 'followup-request-2' }), /already has/);
    await service.stopMonitor({ jobId: next.id });
  } finally { await service.close(); await store.close(); }
});

test('queue outages leave a durable outbox that maintenance can recover after a restart', async () => {
  const store = new Store(); const queue = new FakeQueue(); queue.unavailable = true;
  const adapter = new FakeAmp(); const first = new AmpService(store, config(), adapter, queue);
  const job = await first.start({ prompt: 'Review', idempotencyKey: 'outbox-request-1' });
  assert.equal(job.dispatchState, 'pending'); await first.close();
  queue.unavailable = false;
  const restarted = new AmpService(store, config(), adapter, queue);
  assert.equal((await restarted.getJob({ jobId: job.id })).status, 'queued');
  await restarted.maintain(); assert(queue.ids.has(job.id));
  assert.equal((await restarted.getJob({ jobId: job.id })).dispatchState, 'scheduled');
  assert.equal(adapter.calls.length, 0);
  await restarted.close(); await store.close();
});

test('expired worker leases become unknown/interrupted and never resubmit the Amp prompt', async () => {
  const store = new Store(); const queue = new FakeQueue(); const adapter = new FakeAmp();
  const service = new AmpService(store, config(), adapter, queue);
  const job = await service.start({ prompt: 'Inspect', idempotencyKey: 'stale-request-1' });
  await store.put('amp_jobs', job.id, { ...job, status: 'running', startedAt: new Date(Date.now() - 1_000_000).toISOString(), lease: 'old-worker', leaseUntil: Date.now() - 1 });
  await service.runQueued(job.id);
  assert.equal((await service.getJob({ jobId: job.id })).status, 'interrupted');
  assert.equal(adapter.calls.length, 0);
  await service.close(); await store.close();
});

test('shared daily limits, queued cancellation and worker slot protect cost across instances', async () => {
  const store = new Store(); const queue = new FakeQueue(); const adapter = new FakeAmp();
  const settings = config({ AMP_MAX_JOBS_PER_DAY: '2' });
  const a = new AmpService(store, settings, adapter, queue); const b = new AmpService(store, settings, adapter, queue);
  const one = await a.start({ prompt: 'First', idempotencyKey: 'budget-request-1' });
  const two = await b.start({ prompt: 'Second', idempotencyKey: 'budget-request-2' });
  await assert.rejects(() => a.start({ prompt: 'Third', idempotencyKey: 'budget-request-3' }), /Daily/);
  const worker = a.runQueued(one.id); await until(() => adapter.pending.length === 1);
  await assert.rejects(() => b.runQueued(two.id), TaskBusyError);
  await b.stopMonitor({ jobId: two.id }); await b.runQueued(two.id);
  assert.equal(adapter.calls.length, 1);
  adapter.pending[0]!.event({ type: 'result', success: true, text: 'Done' }); adapter.pending[0]!.finish(); await worker;
  const usage = await store.get<{ jobs: number; seconds: number }>('amp_usage', new Date().toISOString().slice(0, 10));
  assert.equal(usage?.jobs, 2); assert(usage!.seconds < 10);
  await a.close(); await b.close(); await store.close();
});

test('external threads, disabled Amp and missing final results fail safely', async () => {
  const store = new Store();
  const adapter: AmpAdapter = { run: async () => null };
  const service = new AmpService(store, config(), adapter, new FakeQueue());
  await assert.rejects(() => service.start({ prompt: 'Continue', threadId: remoteThread, idempotencyKey: 'external-request-1' }), /Only remote/);
  const job = await service.start({ prompt: 'Work', idempotencyKey: 'noresult-request-1' });
  await service.runQueued(job.id); assert.equal((await service.getJob({ jobId: job.id })).status, 'interrupted');
  const disabled = new AmpService(store, loadConfig(testEnv)); await assert.rejects(() => disabled.listThreads(), /disabled/);
  await disabled.close(); await service.close(); await store.close();
});

test('fresh history remains revision-aware, bounded and distinct from live status', async () => {
  const store = new Store(); const adapter = new FakeAmp(); const service = new AmpService(store, config(), adapter);
  const listing = await service.listThreads(); assert.equal((listing.data as any)[0].upstreamField, 42);
  const latest = await service.readThread({ threadId: remoteThread, maxChars: 500 }); assert(latest.excerpt.endsWith('LATEST'));
  const older = await service.readThread({ threadId: remoteThread, cursor: latest.olderCursor!, revision: latest.revision, maxChars: 500 });
  assert(older.range.start < latest.range.start);
  adapter.markdown += 'changed'; await assert.rejects(() => service.readThread({ threadId: remoteThread, revision: latest.revision }), /changed/);
  assert.match((await service.liveStatus()).schema, /not proof of completion/);
  await service.close(); await store.close();
});

test('isolated workers exclude Google/HQ credentials and the real installed CLI can start', async () => {
  const env = ampEnvironment(config(), { OWNER_PASSWORD_HASH: 'private', COOKIE_SECRET: 'private', GOOGLE_APPLICATION_CREDENTIALS: '/secret.json', HTTPS_PROXY: 'http://proxy:8080' });
  assert.equal(env.OWNER_PASSWORD_HASH, undefined); assert.equal(env.COOKIE_SECRET, undefined); assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(env.HTTPS_PROXY, 'http://proxy:8080'); assert.equal(env.AMP_API_KEY, 'test-value-only');
  const output = await new ProcessAmpAdapter(loadConfig(testEnv)).run({ operation: 'read', threadId: '--help' }, () => {}, AbortSignal.timeout(10_000));
  assert.match(output as string, /Render a thread as markdown/);
});

test('late deliveries expire without executing, and a worker cannot exceed an earlier admission reservation', async () => {
  const store = new Store(); const queue = new FakeQueue(); const adapter = new FakeAmp();
  const initial = new AmpService(store, config(), adapter, queue);
  const old = await initial.start({ prompt: 'Old task', idempotencyKey: 'expired-request-1' });
  await store.put('amp_jobs', old.id, { ...await store.get<AmpJob>('amp_jobs', old.id), createdAt: new Date(Date.now() - 24 * 3_600_000).toISOString() });
  await initial.runQueued(old.id); assert.equal(adapter.calls.length, 0);
  assert.equal((await initial.getJob({ jobId: old.id })).status, 'interrupted');
  const shortService = new AmpService(store, config({ AMP_JOB_TIMEOUT_MS: '1000' }), adapter, queue);
  const short = await shortService.start({ prompt: 'Bounded task', idempotencyKey: 'bounded-request-1' });
  const raised = new AmpService(store, config({ AMP_JOB_TIMEOUT_MS: '1200000' }), adapter, queue);
  const before = Date.now();
  await raised.runQueued(short.id);
  assert(Date.now() - before < 5000);
  assert.equal((await raised.getJob({ jobId: short.id })).status, 'interrupted');
  assert.equal(adapter.calls.length, 1);
  await initial.close(); await shortService.close(); await raised.close(); await store.close();
});
