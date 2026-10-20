import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { AmpService, ampEnvironment, ProcessAmpAdapter, type AmpAdapter } from '../src/amp.js';
import type { AmpEvent, WorkerRequest } from '../src/amp-protocol.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { testEnv } from './helpers.js';

const config = () => loadConfig({ ...testEnv, AMP_ENABLED: 'true', AMP_API_KEY: 'test-value-only', AMP_EXECUTOR: 'orb' });
const remoteThread = 'T-12345678-1234-1234-1234-123456789abc';
class FakeAmp implements AmpAdapter {
  requests: WorkerRequest[] = [];
  pending: { event: (event: AmpEvent) => void; finish: (value: unknown) => void }[] = [];
  markdown = '# Thread\n\nUser: inspect the cache\n\nAssistant: use a cache key.';
  async run(request: WorkerRequest, event: (event: AmpEvent) => void, signal: AbortSignal): Promise<unknown> {
    this.requests.push(request);
    if (request.operation === 'list') return [{ id: remoteThread, title: 'A real upstream title', arbitraryUpstreamField: 42 }];
    if (request.operation === 'read') return this.markdown;
    if (request.operation === 'live') return { activeThreads: [{ id: remoteThread }] };
    return new Promise((resolve, reject) => {
      this.pending.push({ event, finish: resolve });
      signal.addEventListener('abort', () => reject(new Error('monitor stopped')), { once: true });
    });
  }
}

test('Amp dispatch returns immediately, preserves progress, retries once and records the final result', async () => {
  const store = new Store(':memory:');
  const adapter = new FakeAmp();
  const service = new AmpService(store, config(), adapter);
  try {
    const input = { prompt: 'Review the cache implementation', title: 'Cache review', idempotencyKey: 'amp-request-1' };
    const job = await service.start(input);
    assert.equal(job.status, 'running');
    assert.equal(adapter.requests.length, 1);
    adapter.pending[0]!.event({ type: 'system', sessionId: remoteThread });
    adapter.pending[0]!.event({ type: 'assistant', text: 'Checking invalidation.', tools: ['Read'] });
    assert.equal(service.getJob({ jobId: job.id }).latestText, 'Checking invalidation.');
    const retry = await service.start(input);
    assert.equal(retry.id, job.id);
    assert.equal(retry.threadId, remoteThread);
    assert.equal(adapter.requests.length, 1);
    await assert.rejects(() => service.start({ ...input, prompt: 'A different prompt' }), /different input/);
    adapter.pending[0]!.event({ type: 'result', success: true, text: 'Found an invalidation bug.', permissionDenials: ['Bash'] });
    adapter.pending[0]!.finish(null);
    await setImmediate();
    const result = service.getJob({ jobId: job.id });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.latestText, 'Found an invalidation bug.');
    assert.deepEqual(result.permissionDenials, ['Bash']);
    assert(result.finishedAt);
    assert(!('prompt' in service.getJobs().jobs[0]!));
    const continued = await service.start({ prompt: 'Explain the finding', threadId: remoteThread, idempotencyKey: 'amp-continue-1' });
    assert.equal(continued.threadId, remoteThread);
    assert.equal((adapter.requests[1] as any).threadId, remoteThread);
  } finally { await service.close(); store.close(); }
});

test('unknown external threads cannot execute on the MCP host; remote new jobs are bounded', async () => {
  const store = new Store(':memory:');
  const service = new AmpService(store, config(), new FakeAmp());
  try {
    await assert.rejects(() => service.start({ prompt: 'Do work', threadId: remoteThread, idempotencyKey: 'external-work-1' }), /Only remote threads/);
    await assert.rejects(() => service.start({ prompt: 'Do work', threadId: '--help', idempotencyKey: 'invalid-thread-1' }));
    await service.start({ prompt: 'First task', idempotencyKey: 'parallel-work-1' });
    await service.start({ prompt: 'Second task', idempotencyKey: 'parallel-work-2' });
    await assert.rejects(() => service.start({ prompt: 'Third task', idempotencyKey: 'parallel-work-3' }), /Two Amp jobs/);
  } finally { await service.close(); store.close(); }
});

test('stopping observation is explicit and startup never silently retries interrupted work', async () => {
  const store = new Store(':memory:');
  const service = new AmpService(store, config(), new FakeAmp());
  try {
    const job = await service.start({ prompt: 'Inspect service', idempotencyKey: 'stop-request-1' });
    const stopped = await service.stopMonitor({ jobId: job.id });
    assert.equal(stopped.status, 'interrupted');
    assert.match(stopped.message!, /Remote work may still be running/);
    store.put('amp_jobs', job.id, { ...job, status: 'running' });
    const adapter = new FakeAmp();
    const restarted = new AmpService(store, config(), adapter);
    assert.equal(restarted.getJob({ jobId: job.id }).status, 'interrupted');
    assert.match(restarted.getJob({ jobId: job.id }).message!, /restarted/);
    assert.equal(adapter.requests.length, 0);
    await restarted.close();
  } finally { await service.close(); store.close(); }
});

test('thread retrieval preserves source evidence and revision-bound history pagination', async () => {
  const store = new Store(':memory:');
  const adapter = new FakeAmp();
  adapter.markdown = 'First question\n'.repeat(100) + 'LATEST RESPONSE';
  const service = new AmpService(store, config(), adapter);
  try {
    const listing = await service.listThreads({ limit: 3, offset: 6 });
    assert.equal(listing.requestedLimit, 3);
    assert.equal((listing.data as any)[0].arbitraryUpstreamField, 42);
    assert.match(listing.statusMeaning, /Saved metadata only/);
    const latest = await service.readThread({ threadId: remoteThread, maxChars: 500 });
    assert(latest.excerpt.endsWith('LATEST RESPONSE'));
    assert(latest.olderCursor);
    const older = await service.readThread({ threadId: remoteThread, cursor: latest.olderCursor!, revision: latest.revision, maxChars: 500 });
    assert(older.range.start < latest.range.start);
    adapter.markdown += '\nAnother response';
    await assert.rejects(() => service.readThread({ threadId: remoteThread, cursor: latest.olderCursor!, revision: latest.revision }), /changed/);
    const live = await service.liveStatus();
    assert.match(live.schema, /absent thread is not proof of completion/);
  } finally { await service.close(); store.close(); }
});

test('missing final results and transport failure never claim successful execution', async () => {
  const store = new Store(':memory:');
  const adapter: AmpAdapter = { run: async (_request, event) => { event({ type: 'assistant', text: 'Still working' }); return null; } };
  const service = new AmpService(store, config(), adapter);
  try {
    const job = await service.start({ prompt: 'Work', idempotencyKey: 'no-result-work-1' });
    await setImmediate();
    assert.equal(service.getJob({ jobId: job.id }).status, 'interrupted');
    assert.match(service.getJob({ jobId: job.id }).message!, /without a final Amp result/);
  } finally { await service.close(); store.close(); }
});

test('disabled Amp fails clearly, and workers receive no HQ credentials', async () => {
  const store = new Store(':memory:');
  const disabled = new AmpService(store, loadConfig(testEnv));
  try {
    await assert.rejects(() => disabled.listThreads(), /Amp is disabled/);
    const env = ampEnvironment(config(), { OWNER_PASSWORD_HASH: 'must-not-leak', COOKIE_SECRET: 'must-not-leak', GOOGLE_APPLICATION_CREDENTIALS: '/secret.json', PATH: '/usr/bin', HTTPS_PROXY: 'http://proxy:8080' });
    assert.equal(env.OWNER_PASSWORD_HASH, undefined);
    assert.equal(env.COOKIE_SECRET, undefined);
    assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
    assert.equal(env.AMP_API_KEY, 'test-value-only');
  } finally { await disabled.close(); store.close(); }
});

test('real isolated worker can start the pinned CLI and return a bounded local help response', async () => {
  // Direct adapter harness only: --help is rejected by all public thread-ID schemas.
  // This exercises fork/IPC/CLI without making an Amp account or network request.
  const adapter = new ProcessAmpAdapter(loadConfig(testEnv));
  const output = await adapter.run({ operation: 'read', threadId: '--help' }, () => {}, AbortSignal.timeout(10_000));
  assert.equal(typeof output, 'string');
  assert.match(output as string, /Render a thread as markdown/);
});
