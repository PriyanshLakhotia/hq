import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Domain } from '../src/domain.js';

test('online backup includes committed WAL writes and refuses overwrites', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hq-backup-test-'));
  const path = join(directory, 'hq.db');
  const destination = join(directory, 'snapshot.db');
  const store = new Store(path);
  try {
    new Domain(store).captureNote({ title: 'Backup test', body: 'This write may still be in the WAL.' });
    execFileSync(process.execPath, ['scripts/backup.mjs', path, destination], { stdio: 'pipe' });
    const restored = new Store(destination);
    try { assert.equal(new Domain(restored).searchNotes().items[0]?.title, 'Backup test'); }
    finally { restored.close(); }
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    assert.throws(() => execFileSync(process.execPath, ['scripts/backup.mjs', path, destination], { stdio: 'pipe' }));
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('briefing calendar dates respect the configured owner time zone at midnight', () => {
  const store = new Store(':memory:');
  try {
    const domain = new Domain(store, () => new Date('2026-10-20T23:30:00Z'), 'Europe/Amsterdam');
    domain.addItems({ items: [{ title: 'Today in Amsterdam', dueDate: '2026-10-21' }] });
    assert.equal(domain.briefing().date, '2026-10-21');
    assert.equal(domain.briefing().overdue, 0);
    assert.equal(domain.briefing().attention.length, 1);
  } finally { store.close(); }
});
