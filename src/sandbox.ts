/**
 * Runs model-written code in a separate Node process that is locked down with the
 * Node permission model: no file system outside this package, no child processes, no
 * workers, an empty environment. The process never sees a credential; API calls come
 * back here as JSON over the IPC channel. See sandbox-child.ts for the inner layer.
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from './client.js';

const CHILD_PATH = fileURLToPath(new URL('./sandbox-child.js', import.meta.url));
const DIST_DIR = path.dirname(CHILD_PATH);
export const SPEC_PATH = fileURLToPath(new URL('../spec/operations.json', import.meta.url));

export interface SandboxResult {
  ok: boolean;
  result: string;
  logs: string;
}

export interface SandboxOptions {
  mode: 'search' | 'api';
  code: string;
  timeoutMs: number;
  /** Handles one request() call; receives the JSON-encoded options, returns the raw body. */
  onRequest?: (payload: string, control: SandboxControl) => Promise<string>;
}

export interface SandboxControl {
  /** Runs fn with the run's time limit paused, e.g. while a person is asked for approval. */
  suspend<T>(fn: () => Promise<T>): Promise<T>;
}

type ChildMessage =
  | { type: 'ready' }
  | { type: 'request'; id: number; payload: string }
  | { type: 'done'; ok: boolean; result: string; logs: string };

export function runSandbox(options: SandboxOptions): Promise<SandboxResult> {
  return new Promise((resolve) => {
    const child = fork(CHILD_PATH, [], {
      execArgv: ['--permission', `--allow-fs-read=${DIST_DIR}`, `--allow-fs-read=${SPEC_PATH}`, '--max-old-space-size=256', '--no-warnings'],
      env: {},
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    let settled = false;
    const settle = (result: SandboxResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(result);
    };

    let remaining = options.timeoutMs;
    let armedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      armedAt = Date.now();
      timer = setTimeout(() => {
        settle({
          ok: false,
          result: `Timed out after ${Math.round(options.timeoutMs / 1000)}s. Split the work into smaller steps; requests already sent were not rolled back.`,
          logs: '',
        });
      }, Math.max(remaining, 0));
    };
    const control: SandboxControl = {
      suspend: async (fn) => {
        clearTimeout(timer);
        remaining -= Date.now() - armedAt;
        try {
          return await fn();
        } finally {
          if (!settled) arm();
        }
      },
    };
    arm();

    const send = (message: unknown): void => {
      if (!settled && child.connected) child.send(message as object, () => undefined);
    };

    child.on('message', (raw) => {
      const message = raw as ChildMessage;
      if (message?.type === 'ready') {
        send({ type: 'run', mode: options.mode, code: options.code, specPath: SPEC_PATH });
      } else if (message?.type === 'done') {
        settle({ ok: message.ok === true, result: String(message.result), logs: String(message.logs) });
      } else if (message?.type === 'request') {
        const reply = (ok: boolean, body: string): void => send({ type: 'response', id: message.id, ok, body });
        if (!options.onRequest || typeof message.payload !== 'string') {
          reply(false, JSON.stringify({ message: 'API access is not available in this tool.' }));
          return;
        }
        options.onRequest(message.payload, control).then(
          (body) => reply(true, body),
          (error: unknown) =>
            reply(false, JSON.stringify(error instanceof ApiError ? error.info : { message: error instanceof Error ? error.message : String(error) })),
        );
      }
    });
    child.on('error', (error) => settle({ ok: false, result: `Sandbox could not start: ${error.message}`, logs: '' }));
    child.on('exit', (code, signal) =>
      settle({ ok: false, result: `Sandbox exited without a result (${signal ?? `code ${code}`}); the code may have exceeded the memory limit.`, logs: '' }),
    );
  });
}
