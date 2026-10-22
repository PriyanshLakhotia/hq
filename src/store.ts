import { digest } from './security.js';

export type Field = 'listId' | 'status' | 'family' | 'expiresAt' | 'createdAt' | 'sortKey';
export interface Query { where?: [Field, '==' | '<=' | 'in', unknown][]; order?: [Field, 'asc' | 'desc']; after?: string; offset?: number; limit?: number }
export interface RecordValue { id: string; value: unknown }
export interface Reader {
  get<T>(namespace: string, id: string): Promise<T | undefined>;
  find<T>(namespace: string, query?: Query): Promise<T[]>;
  entries(namespace: string, query?: Query): Promise<RecordValue[]>;
}
export interface Transaction extends Reader { put(namespace: string, id: string, value: unknown): void; delete(namespace: string, id: string): void }
export interface Driver extends Reader { transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>; close(): Promise<void> }
export const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

export class Store implements Reader {
  readonly driver: Driver;
  constructor(driver: Driver | ':memory:' = ':memory:') { this.driver = driver === ':memory:' ? new MemoryDriver() : driver; }
  get<T>(ns: string, id: string) { return this.driver.get<T>(ns, id); }
  find<T>(ns: string, query?: Query) { return this.driver.find<T>(ns, query); }
  all<T>(ns: string) { return this.find<T>(ns); }
  entries(ns: string, query?: Query) { return this.driver.entries(ns, query); }
  transaction<T>(fn: (tx: Transaction) => Promise<T>) { return this.driver.transaction(fn); }
  put(ns: string, id: string, value: unknown) { return this.transaction(async tx => { tx.put(ns, id, value); }); }
  delete(ns: string, id: string) { return this.transaction(async tx => { tx.delete(ns, id); }); }
  write<T>(scope: string, key: string | undefined, input: unknown, fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const receiptId = digest(`${scope}:${key}`);
    const fingerprint = digest(JSON.stringify(input));
    return this.transaction(async tx => {
      const saved = key ? await tx.get<{ fingerprint: string; result: T; expiresAt: number }>('receipts', receiptId) : undefined;
      if (saved && saved.expiresAt > Date.now()) {
        if (saved.fingerprint !== fingerprint) throw new Error('Idempotency key already used with different input.');
        return saved.result;
      }
      const result = await fn(tx);
      if (key) tx.put('receipts', receiptId, { fingerprint, result, expiresAt: Date.now() + 30 * 86_400_000 });
      return result;
    });
  }
  async pruneExpired(namespace: string, limit = 50) {
    return this.transaction(async tx => {
      const rows = await tx.entries(namespace, { where: [['expiresAt', '<=', Date.now()]], limit });
      for (const row of rows) tx.delete(namespace, row.id);
      return rows.length;
    });
  }
  close() { return this.driver.close(); }
}

export function select(rows: RecordValue[], query: Query = {}): RecordValue[] {
  let result = rows.filter(row => (query.where ?? []).every(([field, op, value]) => {
    const actual = (row.value as Record<string, unknown>)[field];
    return op === '==' ? actual === value : op === 'in' ? (value as unknown[]).includes(actual) : actual !== undefined && (actual as number) <= (value as number);
  }));
  if (query.order) {
    const [field, direction] = query.order;
    result = result.filter(row => (row.value as any)[field] !== undefined).sort((a, b) => {
      const left = (a.value as any)[field]; const right = (b.value as any)[field];
      return (left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)) * (direction === 'asc' ? 1 : -1);
    });
    if (query.after !== undefined) result = result.filter(row => query.order![1] === 'asc' ? (row.value as any)[field] > query.after! : (row.value as any)[field] < query.after!);
  }
  return result.slice(query.offset ?? 0, query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit);
}
export class MemoryDriver implements Driver {
  private values = new Map<string, Map<string, unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  async get<T>(ns: string, id: string) { return clone(this.values.get(ns)?.get(id)) as T | undefined; }
  async entries(ns: string, query?: Query) { return select([...this.values.get(ns) ?? []].map(([id, value]) => ({ id, value: clone(value) })), query); }
  async find<T>(ns: string, query?: Query) { return (await this.entries(ns, query)).map(row => row.value as T); }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const execute = async () => {
      const snapshot = new Map([...this.values].map(([ns, rows]) => [ns, new Map([...rows].map(([id, value]) => [id, clone(value)]))]));
      const tx: Transaction = {
        get: async <V>(ns: string, id: string) => clone(snapshot.get(ns)?.get(id)) as V | undefined,
        entries: async (ns, query) => select([...snapshot.get(ns) ?? []].map(([id, value]) => ({ id, value: clone(value) })), query),
        find: async <V>(ns: string, query?: Query) => (await tx.entries(ns, query)).map(row => row.value as V),
        put: (ns, id, value) => { if (!snapshot.has(ns)) snapshot.set(ns, new Map()); snapshot.get(ns)!.set(id, clone(value)); },
        delete: (ns, id) => { snapshot.get(ns)?.delete(id); },
      };
      const result = await fn(tx);
      this.values = snapshot;
      return result;
    };
    const pending = this.tail.then(execute);
    this.tail = pending.catch(() => {});
    return pending;
  }
  async close() {}
}
