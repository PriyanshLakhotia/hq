// Dedicated process: the SDK inherits only the explicitly allowed environment.
import { execute } from '@ampcode/sdk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AmpEvent, WorkerReply, WorkerRequest } from './amp-protocol.js';

const send = (reply: WorkerReply) => { if (process.connected) process.send?.(reply); };
const scrub = (value: string, max = 8000) => {
  let result = value;
  if (process.env.AMP_API_KEY) result = result.split(process.env.AMP_API_KEY).join('[REDACTED]');
  return result.replace(/(?:sgamp_|sgp_)[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._~-]+/gi, 'Bearer [REDACTED]').slice(-max);
};
function cli(args: string[], firstLine = false): Promise<unknown> {
  const require = createRequire(import.meta.url);
  const path = join(dirname(require.resolve('@ampcode/cli/package.json')), 'bin', 'amp.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(path, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      if (error) reject(error); else resolve(value);
    };
    child.stderr.resume(); // Upstream errors may contain private data; never forward stderr.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { finish(new Error('Thread output exceeds the 4 MiB retrieval limit. View this thread in Amp.')); return; }
      output += chunk;
      if (firstLine && output.includes('\n')) {
        try { finish(undefined, JSON.parse(output.slice(0, output.indexOf('\n')))); }
        catch { finish(new Error('Amp returned an unsupported live-status format. Status is unknown.')); }
      }
    });
    child.on('error', () => finish(new Error('Could not start the installed Amp CLI.')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) { finish(new Error('Amp request failed. Check the access token, account access, connectivity and CLI version.')); return; }
      finish(undefined, output.trim());
    });
  });
}
let started = false;
process.on('message', async (request: WorkerRequest) => {
  if (started) return;
  started = true;
  try {
    if (request.operation === 'execute') {
      let resultSeen = false;
      for await (const message of execute({ prompt: request.prompt, options: {
        executor: request.executor, runnerId: request.executor === 'runner' ? request.runnerId : undefined,
        runnerDir: request.executor === 'runner' ? request.runnerDir : undefined,
        project: request.executor === 'orb' ? request.project : undefined,
        continue: request.threadId, title: request.threadId ? undefined : request.title,
        mode: request.mode, visibility: 'private', noArchiveAfterExecute: true, labels: ['hq'],
      } })) {
        const sessionId = /^T-[a-zA-Z0-9-]+$/.test(message.session_id) ? message.session_id : undefined;
        if (message.type === 'system') send({ type: 'event', event: { type: 'system', sessionId } });
        if (message.type === 'assistant') {
          const event: AmpEvent = { type: 'assistant', sessionId,
            text: scrub(message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')),
            tools: message.message.content.filter(block => block.type === 'tool_use').map(block => scrub(block.name, 100)).slice(0, 20),
          };
          send({ type: 'event', event });
        }
        if (message.type === 'result') {
          resultSeen = true;
          send({ type: 'event', event: { type: 'result', sessionId, success: !message.is_error,
            text: message.is_error ? 'Amp reported an execution error. Read the thread in Amp for details.' : scrub(message.result, 16000),
            permissionDenials: message.permission_denials?.slice(0, 20).map(value => scrub(value, 200)),
          } });
        }
      }
      if (!resultSeen) throw new Error('Amp stream ended without a final result. Remote status is unknown; read the thread before retrying.');
      send({ type: 'done', data: null });
    } else if (request.operation === 'list') {
      const output = await cli(['threads', 'list', '--json', '--limit', String(request.limit), '--offset', String(request.offset), ...(request.includeArchived ? ['--include-archived'] : [])]);
      let parsed: unknown;
      try { parsed = JSON.parse(output as string); } catch { throw new Error('Amp returned an unsupported thread-list format.'); }
      send({ type: 'done', data: parsed });
    } else if (request.operation === 'read') {
      const output = await cli(['threads', 'markdown', request.threadId]);
      send({ type: 'done', data: scrub(output as string, 4 * 1024 * 1024) });
    } else if (request.operation === 'live') {
      send({ type: 'done', data: await cli(['top', '--stream-jsonl'], true) });
    }
  } catch (error) {
    // Only our controlled error messages are forwarded. SDK errors can contain stderr or prompts.
    const controlled = request.operation !== 'execute' && error instanceof Error && !/JSON|Unexpected/.test(error.message);
    send({ type: 'error', message: controlled ? error.message : 'Amp execution failed. Check account authorization, connectivity, credits and the configured executor. Remote work may still be running; inspect the thread before retrying.' });
  } finally {
    process.disconnect?.();
  }
});
