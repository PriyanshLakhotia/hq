import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from './security.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS documents (
        namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY(namespace, id)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(scope, key)
      );
      PRAGMA user_version=1;
    `);
  }
  get<T>(namespace: string, id: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM documents WHERE namespace=? AND id=?').get(namespace, id);
    return row ? JSON.parse(row.value as string) as T : undefined;
  }
  all<T>(namespace: string): T[] {
    return this.db.prepare('SELECT value FROM documents WHERE namespace=? ORDER BY id').all(namespace)
      .map(row => JSON.parse(row.value as string) as T);
  }
  put(namespace: string, id: string, value: unknown): void {
    this.db.prepare('INSERT INTO documents VALUES (?, ?, ?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value')
      .run(namespace, id, JSON.stringify(value));
  }
  delete(namespace: string, id: string): void {
    this.db.prepare('DELETE FROM documents WHERE namespace=? AND id=?').run(namespace, id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  write<T>(scope: string, key: string | undefined, input: unknown, fn: () => T): T {
    return this.transaction(() => {
      // Receipts protect explicit retries for 30 days; data itself has no automatic expiry.
      this.db.prepare('DELETE FROM receipts WHERE created_at < ?').run(Date.now() - 30 * 86_400_000);
      const fingerprint = digest(JSON.stringify(input));
      if (key) {
        const receipt = this.db.prepare('SELECT fingerprint, result FROM receipts WHERE scope=? AND key=?').get(scope, key);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) throw new Error('Idempotency key already used with different input.');
          return JSON.parse(receipt.result as string) as T;
        }
      }
      const result = fn();
      if (key) this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)')
        .run(scope, key, fingerprint, JSON.stringify(result), Date.now());
      return result;
    });
  }
  close() { this.db.close(); }
}
