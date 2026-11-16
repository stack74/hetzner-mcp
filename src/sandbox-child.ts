/**
 * Sandbox process: runs model-written JavaScript inside a bare V8 context.
 *
 * Isolation layers, outermost first:
 *  - this process is started with the Node permission model (no file system outside the
 *    package, no child processes, no workers) and an empty environment; it never holds a
 *    credential, API calls are relayed to the parent as JSON strings
 *  - the code runs in a vm context without Node globals (no require, process, fetch,
 *    timers, eval)
 *  - only primitives cross the context boundary, so sandbox code never holds a host
 *    object whose prototype chain would lead to the host's Function constructor
 *  - the parent kills the process on timeout
 * node:vm alone is not a security boundary; the process-level restrictions are what
 * contains code that gets out of the context.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

interface RunMessage {
  type: 'run';
  mode: 'search' | 'api';
  code: string;
  specPath: string;
}

const post = (message: unknown): void => {
  process.send!(message);
};

// ---------------------------------------------------------------------------
// Code below is evaluated INSIDE the sandbox context.
// ---------------------------------------------------------------------------

const COMMON_BOOTSTRAP = String.raw`
  'use strict';
  const logs = [];
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return describeError(v);
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const describeError = (e) => {
    if (!(e instanceof Error)) return 'Thrown: ' + fmt(e);
    let out = (e.name || 'Error') + ': ' + e.message;
    if (e.details !== undefined && e.details !== null) out += '\ndetails: ' + fmt(e.details);
    return out;
  };
  const logger = (prefix) => (...args) => { logs.push(prefix + args.map(fmt).join(' ')); };
  globalThis.console = Object.freeze({
    log: logger(''), info: logger(''), debug: logger(''), warn: logger('[warn] '), error: logger('[error] '),
  });
  const finish = (value) => {
    Promise.resolve()
      .then(() => (typeof value === 'function' ? value() : value))
      .then(
        (result) => {
          let text;
          try { text = result === undefined ? 'undefined' : JSON.stringify(result, null, 2); }
          catch (e) { text = String(result); }
          hostDone(true, typeof text === 'string' ? text : String(result), logs.join('\n'));
        },
        (error) => hostDone(false, describeError(error), logs.join('\n')),
      );
  };
`;

const API_BOOTSTRAP = String.raw`(function (hostCall, hostSleep, hostDone) {
  ${COMMON_BOOTSTRAP}
  const sleep = (ms) => new Promise((resolve) => hostSleep(Number(ms) || 0, () => resolve()));

  const request = (opts) => new Promise((resolve, reject) => {
    if (typeof opts === 'string') opts = { path: opts };
    let payload;
    try { payload = JSON.stringify(opts); } catch { payload = undefined; }
    if (typeof payload !== 'string') { reject(new TypeError('hetzner.request(options): options must be a JSON-serializable object')); return; }
    hostCall(
      payload,
      (body) => { try { resolve(body === '' ? null : JSON.parse(body)); } catch { resolve(body); } },
      (info) => {
        const data = JSON.parse(info);
        const error = new Error(data.message);
        error.name = 'HetznerApiError';
        error.status = data.status; error.code = data.code; error.details = data.details;
        reject(error);
      },
    );
  });

  const paginate = async (path, query, opts) => {
    opts = opts || {};
    const maxPages = opts.maxPages || 50;
    const items = [];
    let page = 1;
    for (let i = 0; i < maxPages && page; i++) {
      const res = await request({ path, api: opts.api, query: { per_page: 50, ...(query || {}), page } });
      const key = opts.key || Object.keys(res || {}).find((k) => Array.isArray(res[k]));
      if (!key || !Array.isArray(res[key])) throw new Error('paginate: ' + path + ' did not return a list');
      items.push(...res[key]);
      page = (res.meta && res.meta.pagination && res.meta.pagination.next_page) || null;
    }
    return items;
  };

  const waitForAction = async (action, opts) => {
    opts = opts || {};
    const id = typeof action === 'object' && action !== null ? (action.action ? action.action.id : action.id) : action;
    if (typeof id !== 'number') throw new TypeError('waitForAction: pass an action id, an action object or a response containing "action"');
    const path = (opts.api === 'hetzner' ? '/storage_boxes/actions/' : '/actions/') + id;
    const deadline = Date.now() + (opts.timeoutMs || 90000);
    for (;;) {
      const current = (await request({ path, api: opts.api })).action;
      if (current.status === 'success') return current;
      if (current.status === 'error') {
        const error = new Error('Action ' + id + ' (' + current.command + ') failed: ' + ((current.error && current.error.message) || 'unknown error'));
        error.name = 'HetznerActionError'; error.details = current.error;
        throw error;
      }
      if (Date.now() > deadline) throw new Error('Action ' + id + ' (' + current.command + ') still running at ' + current.progress + '%; poll /actions/' + id + ' later');
      await sleep(opts.intervalMs || 1000);
    }
  };

  const verbs = (api) => ({
    request: (opts) => request(typeof opts === 'string' ? { path: opts, api } : { ...(opts || {}), api: api || (opts || {}).api }),
    get: (path, query, opts) => request({ ...(opts || {}), ...(api ? { api } : {}), method: 'GET', path, query }),
    post: (path, body, opts) => request({ ...(opts || {}), ...(api ? { api } : {}), method: 'POST', path, body }),
    put: (path, body, opts) => request({ ...(opts || {}), ...(api ? { api } : {}), method: 'PUT', path, body }),
    delete: (path, opts) => request({ ...(opts || {}), ...(api ? { api } : {}), method: 'DELETE', path }),
  });
  globalThis.sleep = sleep;
  globalThis.hetzner = Object.freeze({ ...verbs(undefined), paginate, waitForAction });
  globalThis.robot = Object.freeze(verbs('robot'));
  return finish;
})`;

const SEARCH_BOOTSTRAP = String.raw`(function (specJson, hostDone) {
  ${COMMON_BOOTSTRAP}
  const spec = JSON.parse(specJson);
  const operations = spec.operations;

  const firstLine = (text) => (text || '').trim().split('\n')[0];
  const brief = (op) => ({ operationId: op.operationId, method: op.method, path: op.path, summary: op.summary, api: op.api });
  const haystack = (op, withDescription) =>
    [op.operationId, op.method, op.path, op.summary, op.tags.join(' '), withDescription ? op.description : ''].join(' ').toLowerCase();

  const search = (query) => {
    const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const match = (withDescription) => operations.filter((op) => {
      const text = haystack(op, withDescription);
      return terms.every((term) => text.includes(term));
    });
    let hits = match(false);
    if (hits.length === 0) hits = match(true);
    return hits.map(brief);
  };

  // Condenses a JSON schema into a small, readable shape.
  const compact = (schema, depth) => {
    if (!schema || typeof schema !== 'object') return 'any';
    const variants = schema.oneOf || schema.anyOf;
    if (variants) return { oneOf: variants.map((v) => compact(v, depth + 1)) };
    if (schema.allOf) return compact(Object.assign({}, ...schema.allOf.map((s) => ({ ...s, properties: undefined })), {
      type: 'object',
      properties: Object.assign({}, ...schema.allOf.map((s) => s.properties || {})),
      required: schema.allOf.flatMap((s) => s.required || []),
    }), depth);
    const type = Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
    if (type === 'array' || schema.items) {
      const item = compact(schema.items, depth + 1);
      if (typeof item !== 'string') return [item];
      const note = firstLine(schema.description);
      return '[' + item + ']' + (note ? ' - ' + (note.length > 160 ? note.slice(0, 157) + '...' : note) : '');
    }
    if (schema.properties) {
      if (depth > 6) return 'object';
      const required = new Set(schema.required || []);
      const out = {};
      for (const [name, prop] of Object.entries(schema.properties)) {
        if (prop && prop.deprecated) continue;
        out[required.has(name) ? name + '*' : name] = compact(prop, depth + 1);
      }
      return out;
    }
    let text = type || 'any';
    if (schema.enum) text += ' (' + schema.enum.join(' | ') + ')';
    if (schema.default !== undefined) text += ' default=' + JSON.stringify(schema.default);
    const desc = firstLine(schema.description);
    if (desc) text += ' - ' + (desc.length > 160 ? desc.slice(0, 157) + '...' : desc);
    return text;
  };

  const find = (ref) => {
    const wanted = String(ref || '').trim();
    const [method, path] = wanted.split(/\s+/);
    return operations.find((op) => op.operationId === wanted)
      || operations.find((op) => path && op.method === method.toUpperCase() && op.path === path);
  };

  const describe = (ref) => {
    const op = find(ref);
    if (!op) {
      const error = new Error('No operation "' + ref + '". Pass an operationId or "METHOD /path" exactly as returned by search().');
      throw error;
    }
    return {
      ...brief(op),
      deprecated: op.deprecated || undefined,
      description: op.description.trim(),
      parameters: op.api === 'robot' ? undefined : op.parameters.map((p) => ({ name: p.name, in: p.in, required: p.required === true, schema: compact({ ...p.schema, description: p.description }, 0) })),
      requestBody: op.requestBody ? compact(op.requestBody, 0) : undefined,
      response: op.response ? compact(op.response, 0) : undefined,
      examples: op.examples && (op.examples.request || op.examples.response) ? op.examples : undefined,
    };
  };

  globalThis.operations = operations;
  globalThis.apis = spec.apis;
  globalThis.search = search;
  globalThis.describe = describe;
  return finish;
})`;

// ---------------------------------------------------------------------------
// Host side of the bridge. Only strings and sandbox-created callbacks cross it.
// ---------------------------------------------------------------------------

type SandboxCallback = (value?: string) => void;

const pending = new Map<number, { resolve: SandboxCallback; reject: SandboxCallback }>();
let sequence = 0;

const hostCall = (payload: unknown, resolve: unknown, reject: unknown): void => {
  if (typeof payload !== 'string' || typeof resolve !== 'function' || typeof reject !== 'function') return;
  const id = ++sequence;
  pending.set(id, { resolve: resolve as SandboxCallback, reject: reject as SandboxCallback });
  post({ type: 'request', id, payload });
};

const hostSleep = (ms: unknown, callback: unknown): void => {
  if (typeof callback !== 'function') return;
  const delay = typeof ms === 'number' && ms > 0 ? Math.min(ms, 60_000) : 0;
  setTimeout(() => (callback as SandboxCallback)(), delay);
};

const hostDone = (ok: unknown, result: unknown, logs: unknown): void => {
  post({ type: 'done', ok: ok === true, result: String(result), logs: String(logs) });
};

const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
  name: 'hetzner-mcp-sandbox',
  codeGeneration: { strings: false, wasm: false },
});

function compile(source: string): unknown {
  try {
    // Preferred form: an (async) arrow function or any expression.
    return vm.runInContext(`(${source}\n)`, context, { filename: 'code.js' });
  } catch (error) {
    if ((error as { name?: string } | null)?.name !== 'SyntaxError') throw error;
    try {
      // Fallback: a plain sequence of statements with top-level await/return.
      return vm.runInContext(`(async () => {\n${source}\n})`, context, { filename: 'code.js' });
    } catch {
      throw error;
    }
  }
}

function run({ mode, code, specPath }: RunMessage): void {
  try {
    const finish =
      mode === 'search'
        ? vm.runInContext(SEARCH_BOOTSTRAP, context)(readFileSync(specPath, 'utf8'), hostDone)
        : vm.runInContext(API_BOOTSTRAP, context)(hostCall, hostSleep, hostDone);
    finish(compile(code));
  } catch (error) {
    const e = error as { name?: unknown; message?: unknown } | null;
    hostDone(false, `${String(e?.name ?? 'Error')}: ${String(e?.message ?? error)}`, '');
  }
}

let started = false;
process.on('message', (message: RunMessage | { type: 'response'; id: number; ok: boolean; body: string }) => {
  if (message.type === 'run') {
    if (started) return;
    started = true;
    run(message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  (message.ok ? entry.resolve : entry.reject)(message.body);
});
process.on('disconnect', () => process.exit(0));
post({ type: 'ready' });
