import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

// Read from a TTY without echo. Never pass a password as a shell argument.
if (!process.stdin.isTTY) {
  console.error('Run npm run password in an interactive terminal.');
  process.exit(1);
}
process.stdout.write('New owner password (at least 16 characters, input hidden): ');
const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
rl.question('', password => {
  rl.close();
  process.stdout.write('\n');
  if (password.length < 16) {
    console.error('Use at least 16 characters.');
    process.exitCode = 1;
    return;
  }
  const salt = randomBytes(16).toString('hex');
  console.log(`OWNER_PASSWORD_HASH=scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`);
});
