import { DatabaseSync, backup } from 'node:sqlite';
import { openSync, closeSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [, , source, destination] = process.argv;
if (!source || !destination || resolve(source) === resolve(destination)) {
  console.error('Usage: node scripts/backup.mjs SOURCE_DATABASE NEW_BACKUP_PATH');
  process.exit(1);
}
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
// Exclusive creation refuses overwrite and symlink destinations; private from the first byte.
closeSync(openSync(destination, 'wx', 0o600));
let db;
try {
  db = new DatabaseSync(source, { readOnly: true });
  await backup(db, destination);
  console.log('Consistent SQLite backup completed. Store it privately.');
} catch (error) {
  rmSync(destination, { force: true });
  throw error;
} finally {
  db?.close();
}
