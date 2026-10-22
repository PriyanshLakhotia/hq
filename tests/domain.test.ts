import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Domain } from '../src/domain.js';

const fixture = () => {
  const store = new Store(':memory:');
  const time = new Date('2026-10-20T10:00:00Z');
  const domain = new Domain(store, () => time);
  return { store, domain };
};

test('default lists, batch additions, exact IDs, completion, restoration and pagination', () => {
  const { store, domain } = fixture();
  try {
    assert.deepEqual(domain.getLists().map(list => list.name).sort(), ['Shopping', 'TODO']);
    const created = domain.addItems({ list: ' shopping ', items: [{ title: 'Oat milk', quantity: '2 cartons' }, { title: 'Bananas' }] });
    assert.equal(domain.getItems({ list: 'shopping', limit: 1 }).nextCursor, '1');
    assert.equal(domain.getItems({ list: 'Shopping', limit: 1, cursor: '1' }).items.length, 1);
    domain.updateItem({ itemId: created[0]!.id, status: 'done' });
    assert.equal(domain.getItems({ list: 'shopping' }).total, 1);
    assert.equal(domain.getItems({ list: 'shopping', status: 'done' }).total, 1);
    domain.updateItem({ itemId: created[0]!.id, status: 'open' });
    assert.equal(domain.getItems({ list: 'shopping' }).total, 2);
    assert.throws(() => domain.updateItem({ itemId: 'milk', status: 'done' }), /Item not found/);
    assert.throws(() => domain.archiveList({ list: 'TODO' }), /always available/);
  } finally { store.close(); }
});

test('write retries are atomic, reject key reuse and validate calendar dates', () => {
  const { store, domain } = fixture();
  try {
    const input = { items: [{ title: 'Renew passport', dueDate: '2026-11-01' }], idempotencyKey: 'stable-request-1' };
    assert.deepEqual(domain.addItems(input), domain.addItems(input));
    assert.equal(domain.getItems().total, 1);
    assert.throws(() => domain.addItems({ ...input, items: [{ title: 'Different task' }] }), /different input/);
    assert.throws(() => domain.addItems({ items: [{ title: 'Invalid', dueDate: '2026-02-30' }] }));
    assert.equal(domain.getItems().total, 1);
    assert.throws(() => store.transaction(() => { store.put('test', 'rollback', { value: 1 }); throw new Error('rollback'); }));
    assert.equal(store.get('test', 'rollback'), undefined);
  } finally { store.close(); }
});

test('custom lists normalize names and archive without losing their items', () => {
  const { store, domain } = fixture();
  try {
    const list = domain.createList({ name: 'Work   ideas' });
    assert.throws(() => domain.createList({ name: 'work ideas' }), /already exists/);
    domain.addItems({ list: list.id, items: [{ title: 'Try resumable uploads' }] });
    domain.archiveList({ list: list.id });
    assert.equal(domain.getLists().length, 2);
    assert.throws(() => domain.addItems({ list: list.id, items: [{ title: 'Another' }] }), /Restore/);
    domain.archiveList({ list: list.id, archived: false });
    assert.equal(domain.getItems({ list: 'work ideas' }).total, 1);
  } finally { store.close(); }
});

test('lists and item state persist after reopening SQLite', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hq-test-'));
  const path = join(directory, 'test.db');
  let store = new Store(path);
  try {
    const domain = new Domain(store);
    const list = domain.createList({ name: 'Work' });
    const [item] = domain.addItems({ list: list.id, items: [{ title: 'Review the cache', priority: 'high', dueDate: '2026-11-01' }] });
    domain.updateItem({ itemId: item!.id, status: 'done' });
    store.close();
    store = new Store(path);
    const result = new Domain(store).getItems({ list: 'Work', status: 'done' });
    assert.equal(result.total, 1);
    assert.equal(result.items[0]!.id, item!.id);
    assert.equal(result.items[0]!.title, 'Review the cache');
    assert.equal(result.items[0]!.priority, 'high');
    assert.equal(result.items[0]!.dueDate, '2026-11-01');
    assert(result.items[0]!.completedAt);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
