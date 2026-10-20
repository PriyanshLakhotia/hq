export interface AmpEvent {
  type: 'system' | 'assistant' | 'result';
  sessionId?: string;
  text?: string;
  tools?: string[];
  success?: boolean;
  permissionDenials?: string[];
}
export type WorkerRequest =
  | { operation: 'execute'; prompt: string; threadId?: string; title?: string; executor: 'orb' | 'runner'; runnerId?: string; runnerDir?: string; project?: string; mode: 'low' | 'medium' | 'high' | 'ultra' }
  | { operation: 'list'; limit: number; offset: number; includeArchived: boolean }
  | { operation: 'read'; threadId: string }
  | { operation: 'live' };
export type WorkerReply = { type: 'event'; event: AmpEvent } | { type: 'done'; data: unknown } | { type: 'error'; message: string };
