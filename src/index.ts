import { loadEnvFile } from 'node:process';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import { AmpService } from './amp.js';

try { loadEnvFile('.env'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const config = loadConfig();
const store = new Store(config.databasePath);
const amp = new AmpService(store, config);
const { app } = createApp(config, store, amp.tools());
const http = app.listen(config.port, '0.0.0.0', () => console.log(`HQ listening on port ${config.port}; MCP at ${new URL('/mcp', config.publicUrl).href}`));
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  http.close(() => { void amp.close().then(() => { store.close(); process.exit(0); }); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
