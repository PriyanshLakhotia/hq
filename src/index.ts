import { loadEnvFile } from 'node:process';
import { loadConfig } from './config.js';
import { createStore } from './runtime.js';
import { createApp } from './app.js';
import { AmpService } from './amp.js';
import { CloudTaskQueue, googleInternalVerifier } from './tasks.js';

try { loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const config = loadConfig();
const store = createStore(config);
const amp = new AmpService(store, config, undefined, config.jobBackend === 'cloudtasks' ? new CloudTaskQueue(config) : undefined);
const { app } = await createApp(config, store, amp.tools(), config.jobBackend === 'cloudtasks' ? { amp, verify: googleInternalVerifier(config) } : undefined);
const http = app.listen(config.port, '0.0.0.0', () => console.log(`HQ listening on port ${config.port}; storage=${config.storageBackend}; jobs=${config.jobBackend}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  void amp.close();
  http.close(() => { void store.close().then(() => process.exit(0)); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
