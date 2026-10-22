import { CloudTasksClient } from '@google-cloud/tasks';
import { OAuth2Client } from 'google-auth-library';
import type { Config } from './config.js';

export interface TaskQueue { enqueue(jobId: string): Promise<void> }
export class CloudTaskQueue implements TaskQueue {
  constructor(private config: Config, private client = new CloudTasksClient()) {}
  async enqueue(jobId: string) {
    const parent = this.config.tasksQueue!;
    try {
      await this.client.createTask({ parent, task: {
        name: `${parent}/tasks/hq-${jobId}`,
        dispatchDeadline: { seconds: Math.ceil(this.config.ampJobTimeoutMs / 1000) + 120 },
        httpRequest: { httpMethod: 'POST', url: new URL('/internal/amp/run', this.config.publicUrl).href,
          headers: { 'Content-Type': 'application/json' }, body: Buffer.from(JSON.stringify({ jobId })),
          oidcToken: { serviceAccountEmail: this.config.tasksServiceAccount!, audience: this.config.publicUrl.origin },
        },
      } }, { timeout: 10_000 });
    } catch (error) {
      // Deterministic names make an ambiguous create/retry safe; never name by prompt.
      if ((error as { code?: number }).code !== 6) throw new Error('Task scheduling is unavailable. The saved job remains queued for recovery.');
    }
  }
}
export type InternalVerifier = (token: string) => Promise<boolean>;
export function googleInternalVerifier(config: Config, client = new OAuth2Client()): InternalVerifier {
  return async token => {
    try {
      const ticket = await client.verifyIdToken({ idToken: token, audience: config.publicUrl.origin });
      const payload = ticket.getPayload();
      return !!payload && payload.email_verified === true && payload.email === config.tasksServiceAccount;
    } catch { return false; }
  };
}
