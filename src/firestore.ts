import { Firestore, type Query as FirestoreQuery, type Transaction as FirestoreTransaction } from '@google-cloud/firestore';
import { digest } from './security.js';
import { clone, type Driver, type Field, type Query, type Transaction } from './store.js';

const indexed: Field[] = ['listId', 'status', 'expiresAt', 'createdAt', 'sortKey'];
export class FirestoreDriver implements Driver {
  constructor(readonly db: Firestore, readonly root = 'hq') {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,60}$/.test(root)) throw new Error('Invalid Firestore collection prefix.');
  }
  private collection(ns: string) { return this.db.collection(this.root).doc(ns).collection('records'); }
  private document(ns: string, id: string) { return this.collection(ns).doc(digest(id)); }
  private query(ns: string, options: Query = {}) {
    let query: FirestoreQuery = this.collection(ns);
    for (const [field, op, value] of options.where ?? []) query = query.where(`fields.${field}`, op, value);
    if (options.order) query = query.orderBy(`fields.${options.order[0]}`, options.order[1]);
    if (options.after !== undefined) query = query.startAfter(options.after);
    if (options.offset) query = query.offset(options.offset);
    if (options.limit) query = query.limit(options.limit);
    return query;
  }
  async get<T>(ns: string, id: string) {
    const snapshot = await this.document(ns, id).get();
    return snapshot.exists ? JSON.parse(snapshot.get('body')) as T : undefined;
  }
  async entries(ns: string, query?: Query) {
    const snapshot = await this.query(ns, query).get();
    return snapshot.docs.map(doc => ({ id: doc.get('id') as string, value: JSON.parse(doc.get('body')) }));
  }
  async find<T>(ns: string, query?: Query) { return (await this.entries(ns, query)).map(row => row.value as T); }
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async native => {
      // Buffer writes until all reads complete: required by Firestore transactions.
      const pending = new Map<string, { ns: string; id: string; value?: unknown; deleted: boolean }>();
      const tx: Transaction = {
        get: async <V>(ns: string, id: string) => {
          const staged = pending.get(`${ns}:${id}`);
          if (staged) return staged.deleted ? undefined : clone(staged.value) as V;
          const snapshot = await native.get(this.document(ns, id));
          return snapshot.exists ? JSON.parse(snapshot.get('body')) as V : undefined;
        },
        entries: async (ns, options) => {
          if ([...pending.values()].some(row => row.ns === ns)) throw new Error('Query must precede writes to its namespace.');
          const snapshot = await native.get(this.query(ns, options));
          return snapshot.docs.map(doc => ({ id: doc.get('id') as string, value: JSON.parse(doc.get('body')) }));
        },
        find: async <V>(ns: string, options?: Query) => (await tx.entries(ns, options)).map(row => row.value as V),
        put: (ns, id, value) => { pending.set(`${ns}:${id}`, { ns, id, value: clone(value), deleted: false }); },
        delete: (ns, id) => { pending.set(`${ns}:${id}`, { ns, id, deleted: true }); },
      };
      const result = await fn(tx);
      this.flush(native, pending.values());
      return result;
    }, { maxAttempts: 5 });
  }
  private flush(native: FirestoreTransaction, writes: Iterable<{ ns: string; id: string; value?: unknown; deleted: boolean }>) {
    for (const row of writes) {
      const ref = this.document(row.ns, row.id);
      if (row.deleted) { native.delete(ref); continue; }
      const body = JSON.stringify(row.value);
      if (Buffer.byteLength(body) > 800_000) throw new Error('Record exceeds the storage limit.');
      const fields: Record<string, string | number> = {};
      for (const key of indexed) {
        const value = (row.value as any)[key];
        if (typeof value === 'string' || typeof value === 'number') fields[key] = value;
      }
      native.set(ref, { id: row.id, body, fields });
    }
  }
  async close() { await this.db.terminate(); }
}
