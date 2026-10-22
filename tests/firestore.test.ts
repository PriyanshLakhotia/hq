import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';
import { Store } from '../src/store.js';
import { FirestoreDriver } from '../src/firestore.js';
import { Domain } from '../src/domain.js';
import { fixture, connect } from './helpers.js';
import { AmpService, type AmpAdapter } from '../src/amp.js';
import { loadConfig } from '../src/config.js';
import { testEnv } from './helpers.js';

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
function stores() {
  if (!emulator || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator)) throw new Error('Integration tests require a local Firestore emulator.');
  const root = `test_${randomBytes(6).toString('hex')}`;
  // The emulator accepts a synthetic owner token; no real account or metadata call.
  const authClient = new OAuth2Client();
  authClient.setCredentials({ access_token: 'owner', expiry_date: Date.now() + 3_600_000 });
  const clients = [new Firestore({ projectId: 'demo-hq', preferRest: true, authClient: authClient as any }),
    new Firestore({ projectId: 'demo-hq', preferRest: true, authClient: authClient as any })];
  return clients.map(client => new Store(new FirestoreDriver(client, root)));
}

test('Firestore: independent servers preserve data, unique names, concurrent retries and counters', { skip: !emulator }, async () => {
  const [a, b] = stores() as [Store, Store];
  try {
    const first = new Domain(a); const second = new Domain(b);
    await Promise.all([first.initialize(), second.initialize()]);
    const unique = await Promise.allSettled([first.createList({ name: 'Work' }), second.createList({ name: 'WORK' })]);
    assert.equal(unique.filter(r => r.status === 'fulfilled').length, 1);
    const request = { list: 'work', items: [{ title: 'Exactly once' }], idempotencyKey: 'firestore-retry-1' };
    const [one, two] = await Promise.all([first.addItems(request), second.addItems(request)]);
    assert.deepEqual(one, two);
    assert.equal((await second.getItems({ list: 'work' })).total, 1);
    await Promise.all([first.addItems({ items: [{ title: 'One' }] }), second.addItems({ items: [{ title: 'Two' }] })]);
    assert.equal((await second.getItems()).total, 2);
    const page = await second.getItems({ limit: 1 });
    assert.equal((await first.getItems({ cursor: page.nextCursor!, limit: 1 })).nextCursor, null);
    await first.updateItem({ itemId: one[0]!.id, status: 'done' });
    assert.equal((await second.getItems({ list: 'work', status: 'done' })).total, 1);
    await assert.rejects(() => a.transaction(async tx => { tx.put('testing', 'rollback', { value: 1 }); throw new Error('rollback'); }));
    assert.equal(await b.get('testing', 'rollback'), undefined);
  } finally { await a.close(); await b.close(); }
});

test('Firestore: OAuth grants survive instance replacement and concurrent refresh replay revokes the family', { skip: !emulator }, async () => {
  const [a, b] = stores() as [Store, Store];
  let first = await fixture(a); let second: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const { client, tokens } = await connect(first);
    await first.close();
    second = await fixture(b);
    assert.equal((await second.oauth.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
    const registered = (await second.oauth.clientsStore.getClient(client.client_id))!;
    const race = await Promise.allSettled([
      second.oauth.exchangeRefreshToken(registered, tokens.refresh_token),
      second.oauth.exchangeRefreshToken(registered, tokens.refresh_token),
    ]);
    assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
    const winner = race.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ access_token: string }>;
    await assert.rejects(() => second!.oauth.verifyAccessToken(winner.value.access_token));
  } finally { if (second) await second.close(); else await b.close(); }
});

test('Firestore: concurrent task delivery across instances claims a job once', { skip: !emulator }, async () => {
  const [a, b] = stores() as [Store, Store];
  let calls = 0;
  const adapter: AmpAdapter = { run: async (_request, event) => { calls++; event({ type: 'result', success: true, text: 'Done' }); return null; } };
  const settings = loadConfig({ ...testEnv, AMP_ENABLED: 'true', AMP_API_KEY: 'test-value-only' });
  const one = new AmpService(a, settings, adapter); const two = new AmpService(b, settings, adapter);
  try {
    const job = await one.start({ prompt: 'Review', idempotencyKey: 'firestore-job-1' });
    await Promise.allSettled([one.runQueued(job.id), two.runQueued(job.id)]);
    assert.equal(calls, 1);
    assert.equal((await two.getJob({ jobId: job.id })).status, 'succeeded');
    assert.equal(await b.get('amp_control', 'worker'), undefined);
  } finally { await one.close(); await two.close(); await a.close(); await b.close(); }
});
