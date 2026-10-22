import { setTimeout } from 'node:timers/promises';
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:8787/v1/projects/demo-hq/databases/(default)/documents', { signal: AbortSignal.timeout(1000) });
    if (response.ok) process.exit(0);
  } catch {}
  await setTimeout(500);
}
console.error('Firestore emulator did not become ready.');
process.exit(1);
