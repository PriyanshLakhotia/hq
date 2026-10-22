import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, type Reader } from './store.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.string().min(8).max(160).optional();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a valid calendar date in YYYY-MM-DD format.');
const pagination = { limit: z.number().int().min(1).max(50).default(20), cursor: z.string().min(1).max(300).optional() };
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
export interface List { id: string; name: string; description: string; archived: boolean; builtIn: boolean; createdAt: string; openItems: number; doneItems: number }
export interface Item { id: string; listId: string; title: string; status: 'open' | 'done'; priority: 'low' | 'normal' | 'high'; dueDate?: string | null; quantity?: string | null; notes: string; createdAt: string; updatedAt: string; completedAt?: string; sortKey: string }
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
const sortKey = (item: Pick<Item, 'priority' | 'dueDate' | 'createdAt' | 'id'>) =>
  `${{ high: 0, normal: 1, low: 2 }[item.priority]}|${item.dueDate ?? '9999-12-31'}|${item.createdAt}|${item.id}`;

export class Domain {
  constructor(readonly store: Store, private now = () => new Date()) {}
  async initialize() {
    await this.store.transaction(async tx => {
      for (const [listId, name] of [['todo', 'TODO'], ['shopping', 'Shopping']] as const) {
        if (!await tx.get('lists', listId)) {
          tx.put('lists', listId, { id: listId, name, description: '', archived: false, builtIn: true,
            createdAt: this.now().toISOString(), openItems: 0, doneItems: 0 } satisfies List);
          tx.put('list_names', normalize(name), { listId });
        }
      }
    });
  }
  private async list(reference: string, reader: Reader = this.store): Promise<List> {
    let list = await reader.get<List>('lists', reference);
    if (!list) {
      const index = await reader.get<{ listId: string }>('list_names', normalize(reference));
      if (index) list = await reader.get<List>('lists', index.listId);
    }
    if (!list) throw new Error('List not found. Use lists_get to find its name or ID.');
    return list;
  }
  async createList(input: Input<'list_create'>) {
    const value = schemas.list_create.parse(input);
    return this.store.write('list_create', value.idempotencyKey, value, async tx => {
      if (await tx.get('list_names', normalize(value.name))) throw new Error('A list with that name already exists.');
      const list: List = { id: id('list'), name: value.name, description: value.description, archived: false, builtIn: false, openItems: 0, doneItems: 0, createdAt: this.now().toISOString() };
      tx.put('lists', list.id, list);
      tx.put('list_names', normalize(list.name), { listId: list.id });
      return list;
    });
  }
  async getLists(input: Input<'lists_get'> = {}) {
    const { includeArchived } = schemas.lists_get.parse(input);
    return (await this.store.all<List>('lists')).filter(list => includeArchived || !list.archived);
  }
  async archiveList(input: Input<'list_archive'>) {
    const value = schemas.list_archive.parse(input);
    return this.store.write('list_archive', value.idempotencyKey, value, async tx => {
      const list = await this.list(value.list, tx);
      if (list.builtIn && value.archived) throw new Error('The TODO and Shopping lists are always available.');
      list.archived = value.archived;
      tx.put('lists', list.id, list);
      return list;
    });
  }
  async addItems(input: Input<'items_add'>) {
    const value = schemas.items_add.parse(input);
    return this.store.write('items_add', value.idempotencyKey, value, async tx => {
      const list = await this.list(value.list, tx);
      if (list.archived) throw new Error('Restore the list before adding items.');
      list.openItems += value.items.length;
      tx.put('lists', list.id, list);
      return value.items.map(entry => {
        const now = this.now().toISOString();
        const fields = { ...entry, id: id('item'), listId: list.id, createdAt: now };
        const item: Item = { ...fields, status: 'open', updatedAt: now, sortKey: sortKey(fields) };
        tx.put('items', item.id, item);
        return item;
      });
    });
  }
  async getItems(input: Input<'items_get'> = {}) {
    const value = schemas.items_get.parse(input);
    const list = await this.list(value.list);
    let after: string | undefined;
    if (value.cursor) {
      after = Buffer.from(value.cursor, 'base64url').toString('utf8');
      if (!/^[012]\|\d{4}-\d{2}-\d{2}\|[^|]+\|item_[a-f0-9-]+$/.test(after)) throw new Error('Invalid list cursor.');
    }
    const where: import('./store.js').Query['where'] = [['listId', '==', list.id]];
    if (value.status !== 'all') where.push(['status', '==', value.status]);
    const items = await this.store.find<Item>('items', { where, order: ['sortKey', 'asc'], after, limit: value.limit + 1 });
    const hasMore = items.length > value.limit;
    const visible = items.slice(0, value.limit);
    return { list, total: value.status === 'open' ? list.openItems : value.status === 'done' ? list.doneItems : list.openItems + list.doneItems,
      items: visible, nextCursor: hasMore ? Buffer.from(visible.at(-1)!.sortKey).toString('base64url') : null };
  }
  async updateItem(input: Input<'item_update'>) {
    const value = schemas.item_update.parse(input);
    return this.store.write('item_update', value.idempotencyKey, value, async tx => {
      const item = await tx.get<Item>('items', value.itemId);
      if (!item) throw new Error('Item not found. Read the list first to get the exact item ID.');
      const list = await this.list(item.listId, tx);
      if (value.status && value.status !== item.status) {
        list.openItems += value.status === 'open' ? 1 : -1;
        list.doneItems += value.status === 'done' ? 1 : -1;
        tx.put('lists', list.id, list);
      }
      const { itemId: _id, idempotencyKey: _key, ...updates } = value;
      Object.assign(item, updates, { updatedAt: this.now().toISOString() });
      if (value.status === 'done') item.completedAt ??= this.now().toISOString();
      if (value.status === 'open') delete item.completedAt;
      item.sortKey = sortKey(item);
      tx.put('items', item.id, item);
      return item;
    });
  }
}
