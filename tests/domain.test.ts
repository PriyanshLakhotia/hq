import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, MemoryDriver } from '../src/store.js';
import { Domain } from '../src/domain.js';

async function fixture() {
  const store = new Store();
  const domain = new Domain(store, () => new Date('2026-10-20T10:00:00Z'));
  await domain.initialize();
  return { store, domain };
}

test('lists keep counts, quantities, completion/reopening, and opaque pagination', async () => {
  const { store, domain } = await fixture();
  try {
    assert.deepEqual((await domain.getLists()).map(list => list.name).sort(), ['Shopping', 'TODO']);
    const items = await domain.addItems({ list: 'shopping', items: [{ title: 'Milk', quantity: '2 cartons' }, { title: 'Bread' }] });
    const first = await domain.getItems({ list: 'shopping', limit: 1 });
    assert(first.nextCursor);
    const second = await domain.getItems({ list: 'shopping', limit: 1, cursor: first.nextCursor });
    assert.notEqual(second.items[0]!.id, first.items[0]!.id);
    assert.equal(second.nextCursor, null);
    await domain.updateItem({ itemId: items[0]!.id, status: 'done' });
    await domain.updateItem({ itemId: items[0]!.id, status: 'done' });
    assert.equal((await domain.getItems({ list: 'shopping' })).total, 1);
    assert.equal((await domain.getItems({ list: 'shopping', status: 'done' })).total, 1);
    await domain.updateItem({ itemId: items[0]!.id, status: 'open' });
    assert.equal((await domain.getItems({ list: 'shopping' })).total, 2);
    await assert.rejects(() => domain.archiveList({ list: 'todo' }), /always available/);
    await assert.rejects(() => domain.getItems({ cursor: 'invalid' }), /Invalid list cursor/);
  } finally { await store.close(); }
});

test('concurrent retries and conflicting keys preserve atomic writes and counters', async () => {
  const { store, domain } = await fixture();
  try {
    const input = { items: [{ title: 'Renew passport', dueDate: '2026-11-01' }], idempotencyKey: 'stable-request-1' };
    const [one, two] = await Promise.all([domain.addItems(input), domain.addItems(input)]);
    assert.deepEqual(one, two);
    assert.equal((await domain.getItems()).total, 1);
    await assert.rejects(() => domain.addItems({ ...input, items: [{ title: 'Different' }] }), /different input/);
    await assert.rejects(() => domain.addItems({ items: [{ title: 'Bad date', dueDate: '2026-02-30' }] }));
    await assert.rejects(() => store.transaction(async tx => { tx.put('test', 'rollback', { value: 1 }); throw new Error('rollback'); }));
    assert.equal(await store.get('test', 'rollback'), undefined);
    await Promise.all(Array.from({ length: 8 }, (_, i) => domain.addItems({ items: [{ title: `Task ${i}` }] })));
    assert.equal((await domain.getItems()).total, 9);
  } finally { await store.close(); }
});

test('name uniqueness is transactional and archiving preserves items', async () => {
  const { store, domain } = await fixture();
  try {
    const results = await Promise.allSettled([domain.createList({ name: 'Work   tasks' }), domain.createList({ name: 'work tasks' })]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const list = (await domain.getLists()).find(list => !list.builtIn)!;
    await domain.addItems({ list: list.id, items: [{ title: 'Review cache' }] });
    await domain.archiveList({ list: list.id });
    assert.equal((await domain.getLists()).length, 2);
    await assert.rejects(() => domain.addItems({ list: list.id, items: [{ title: 'Another' }] }), /Restore/);
    await domain.archiveList({ list: list.id, archived: false });
    assert.equal((await domain.getItems({ list: 'WORK TASKS' })).total, 1);
  } finally { await store.close(); }
});

test('new server objects reuse shared storage and initialization preserves item counters', async () => {
  const driver = new MemoryDriver();
  const first = new Store(driver);
  const domain = new Domain(first);
  await domain.initialize();
  const [item] = await domain.addItems({ items: [{ title: 'Retained task' }] });
  await first.close();
  const second = new Store(driver);
  const restarted = new Domain(second);
  await restarted.initialize();
  assert.equal((await restarted.getItems()).items[0]!.id, item!.id);
  assert.equal((await restarted.getLists()).find(list => list.id === 'todo')!.openItems, 1);
  await second.close();
});
