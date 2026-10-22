import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().min(8).max(160).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date in YYYY-MM-DD format.');
const pagination = { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().regex(/^\d{1,8}$/).optional() };
export const schemas = {
  list_create: z.object({ name: text(80), description: z.string().trim().max(400).default(''), idempotencyKey: key }),
  lists_get: z.object({ includeArchived: z.boolean().default(false) }),
  list_archive: z.object({ list: text(100), archived: z.boolean().default(true), idempotencyKey: key }),
  items_add: z.object({ list: text(100).default('TODO'), items: z.array(z.object({
    title: text(300), quantity: z.string().trim().max(80).optional(),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    dueDate: date.optional(), notes: z.string().trim().max(1000).default(''),
  })).min(1).max(30), idempotencyKey: key }),
  items_get: z.object({ list: text(100).default('TODO'), status: z.enum(['open', 'done', 'all']).default('open'), ...pagination }),
  item_update: z.object({ itemId: text(100), title: text(300).optional(),
    status: z.enum(['open', 'done']).optional(), priority: z.enum(['low', 'normal', 'high']).optional(),
    dueDate: date.nullable().optional(), quantity: z.string().trim().max(80).nullable().optional(),
    notes: z.string().trim().max(1000).optional(), idempotencyKey: key,
  }).refine(value => ['title', 'status', 'priority', 'dueDate', 'quantity', 'notes'].some(k => k in value), 'Provide an update.'),

};

type Input<K extends keyof typeof schemas> = z.input<(typeof schemas)[K]>;
export interface List { id: string; name: string; description: string; archived: boolean; builtIn: boolean; createdAt: string }
export interface Item { id: string; listId: string; title: string; status: 'open' | 'done'; priority: 'low' | 'normal' | 'high'; dueDate?: string | null; quantity?: string | null; notes: string; createdAt: string; updatedAt: string; completedAt?: string }
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function page<T>(values: T[], limit: number, cursor?: string) {
  const offset = Number(cursor || 0);
  return { total: values.length, items: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
}

export class Domain {
  constructor(readonly store: Store, private now = () => new Date()) {
    for (const [listId, name] of [['todo', 'TODO'], ['shopping', 'Shopping']] as const) {
      if (!store.get('lists', listId)) store.put('lists', listId, {
        id: listId, name, description: '', archived: false, builtIn: true, createdAt: this.now().toISOString(),
      } satisfies List);
    }
  }
  private list(reference: string): List {
    const list = this.store.get<List>('lists', reference)
      ?? this.store.all<List>('lists').find(value => normalize(value.name) === normalize(reference));
    if (!list) throw new Error('List not found. Use lists_get to find its name or ID.');
    return list;
  }
  createList(input: Input<'list_create'>) {
    const value = schemas.list_create.parse(input);
    return this.store.write('list_create', value.idempotencyKey, value, () => {
      if (this.store.all<List>('lists').some(list => normalize(list.name) === normalize(value.name))) throw new Error('A list with that name already exists.');
      const list: List = { id: id('list'), name: value.name, description: value.description, archived: false, builtIn: false, createdAt: this.now().toISOString() };
      this.store.put('lists', list.id, list);
      return list;
    });
  }
  getLists(input: Input<'lists_get'> = {}) {
    const { includeArchived } = schemas.lists_get.parse(input);
    const items = this.store.all<Item>('items');
    return this.store.all<List>('lists').filter(list => includeArchived || !list.archived)
      .map(list => ({ ...list, openItems: items.filter(item => item.listId === list.id && item.status === 'open').length }));
  }
  archiveList(input: Input<'list_archive'>) {
    const value = schemas.list_archive.parse(input);
    return this.store.write('list_archive', value.idempotencyKey, value, () => {
      const list = this.list(value.list);
      if (list.builtIn && value.archived) throw new Error('The TODO and Shopping lists are always available.');
      list.archived = value.archived;
      this.store.put('lists', list.id, list);
      return list;
    });
  }
  addItems(input: Input<'items_add'>) {
    const value = schemas.items_add.parse(input);
    return this.store.write('items_add', value.idempotencyKey, value, () => {
      const list = this.list(value.list);
      if (list.archived) throw new Error('Restore the list before adding items.');
      return value.items.map(entry => {
        const now = this.now().toISOString();
        const item: Item = { ...entry, id: id('item'), listId: list.id, status: 'open', createdAt: now, updatedAt: now };
        this.store.put('items', item.id, item);
        return item;
      });
    });
  }
  getItems(input: Input<'items_get'> = {}) {
    const value = schemas.items_get.parse(input);
    const list = this.list(value.list);
    const priority = { high: 0, normal: 1, low: 2 };
    const items = this.store.all<Item>('items').filter(item => item.listId === list.id && (value.status === 'all' || item.status === value.status))
      .sort((a, b) => priority[a.priority] - priority[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { list, ...page(items, value.limit, value.cursor) };
  }
  updateItem(input: Input<'item_update'>) {
    const value = schemas.item_update.parse(input);
    return this.store.write('item_update', value.idempotencyKey, value, () => {
      const item = this.store.get<Item>('items', value.itemId);
      if (!item) throw new Error('Item not found. Read the list first to get the exact item ID.');
      const { itemId: _id, idempotencyKey: _key, ...updates } = value;
      Object.assign(item, updates, { updatedAt: this.now().toISOString() });
      if (value.status === 'done') item.completedAt ??= this.now().toISOString();
      if (value.status === 'open') delete item.completedAt;
      this.store.put('items', item.id, item);
      return item;
    });
  }
}
