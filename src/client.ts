import { SERVER_NAME, SERVER_VERSION, type ApiName, type Limits } from './config.js';
import type { Validator } from './validate.js';

/** First path segments that live on api.hetzner.com instead of api.hetzner.cloud. */
const HETZNER_API_SEGMENTS = new Set(['storage_boxes', 'storage_box_types']);
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export interface ApiErrorInfo {
  message: string;
  status?: number;
  code?: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(public readonly info: ApiErrorInfo) {
    super(info.message);
  }
}

export interface RequestOptions {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  api?: string;
  /** false skips the check against the API reference. */
  validate?: boolean;
}

function fail(message: string, extra: Partial<ApiErrorInfo> = {}): never {
  throw new ApiError({ message, ...extra });
}

/** Robot expects application/x-www-form-urlencoded with PHP-style nesting: rules[input][0][action]=accept */
export function formEncode(body: unknown): string {
  if (typeof body === 'string') return body;
  const params = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => add(`${key}[${index}]`, item));
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else params.append(key, String(value));
  };
  for (const [key, value] of Object.entries((body ?? {}) as Record<string, unknown>)) add(key, value);
  return params.toString();
}

function resolveApi(opts: RequestOptions, path: string): ApiName {
  if (opts.api === undefined || opts.api === null) {
    return HETZNER_API_SEGMENTS.has(path.split(/[/?]/)[1] ?? '') ? 'hetzner' : 'cloud';
  }
  if (opts.api === 'cloud' || opts.api === 'hetzner' || opts.api === 'robot') return opts.api;
  fail('`api` must be "cloud" (api.hetzner.cloud), "hetzner" (api.hetzner.com, Storage Boxes) or "robot" (dedicated servers).');
}

function buildUrl(config: Limits, opts: RequestOptions): { url: URL; api: ApiName } {
  const path = opts.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    fail('`path` must be an API path starting with "/", e.g. "/servers" (without host or /v1 prefix).');
  }
  if (path.split(/[/?#]/).includes('..')) fail('`path` must not contain ".." segments.');

  const api = resolveApi(opts, path);
  const url = new URL(config.baseUrls[api] + path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value === undefined || value === null) continue;
    // Hetzner expects repeated keys for array filters: ?status=running&status=off
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
  }
  return { url, api };
}

/** One side (Cloud project or Robot account) of a code run's credentials. */
export interface Access<T> {
  /** Resolved lazily, so a run that only uses the other side never fails on this one. */
  value?: T;
  /** Why no credentials are available; reported when a call needs them. */
  error?: string;
  /** false: only GET requests are allowed for this side, also in hetzner_execute. */
  writes: boolean;
  /** Called when the API rejects the credentials (HTTP 401). */
  onRejected?: () => void;
}

export interface Credentials {
  cloud: Access<{ token: string }>;
  robot: Access<{ user: string; password: string }>;
}

/**
 * Performs one authenticated API call. Resolves with the raw response body ("" for empty
 * responses); throws ApiError for everything else. Credentials never leave the main process.
 */
export async function performRequest(
  config: Limits,
  credentials: Credentials,
  opts: RequestOptions,
  allowWrites: boolean,
  validate?: Validator,
): Promise<string> {
  const method = String(opts.method ?? 'GET').toUpperCase();
  if (!METHODS.has(method)) fail(`Unsupported HTTP method "${method}".`);
  if (method !== 'GET' && !allowWrites) {
    fail(`${method} blocked: hetzner_query only allows GET requests. Use the hetzner_execute tool for changes.`, { code: 'read_only' });
  }

  const { url, api } = buildUrl(config, opts);
  const hasBody = opts.body !== undefined && opts.body !== null && method !== 'GET';

  if (validate && opts.validate !== false) {
    const basePath = new URL(config.baseUrls[api]).pathname.replace(/\/$/, '');
    const problems = validate(api, method, url.pathname.slice(basePath.length), [...new Set(url.searchParams.keys())], opts.body);
    if (problems.length) {
      fail(
        `${method} ${opts.path} was not sent, it does not match the API reference:\n- ${problems.join('\n- ')}\nIf the reference is wrong, pass validate: false in hetzner.request({ ... }).`,
        { code: 'validation_failed', details: problems },
      );
    }
  }

  const access: Access<unknown> = api === 'robot' ? credentials.robot : credentials.cloud;
  if (method !== 'GET' && !access.writes) {
    fail(`${method} blocked: this ${api === 'robot' ? 'Robot account' : 'project'} is read-only, only GET requests are allowed.`, { code: 'read_only' });
  }
  if (!access.value) fail(access.error ?? 'No credentials configured.', { code: 'not_configured' });
  const authorization =
    api === 'robot'
      ? `Basic ${Buffer.from(`${credentials.robot.value!.user}:${credentials.robot.value!.password}`).toString('base64')}`
      : `Bearer ${credentials.cloud.value!.token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
        ...(hasBody ? { 'Content-Type': api === 'robot' ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
      },
      body: hasBody ? (api === 'robot' ? formEncode(opts.body) : JSON.stringify(opts.body)) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? (error.name === 'TimeoutError' ? 'request timed out' : error.message) : String(error);
    fail(`${method} ${url.pathname} failed: ${reason}`, { code: 'network_error' });
  }

  const text = await response.text();
  if (response.ok) return text;

  let apiError: { code?: string; message?: string; details?: unknown } = {};
  try {
    const { status: _status, code, message: errorMessage, details, ...rest } = JSON.parse(text).error ?? {};
    // Robot puts extra fields (missing, invalid, max_request, interval) next to the message.
    apiError = { code, message: errorMessage, details: details ?? (Object.keys(rest).length ? rest : undefined) };
  } catch {
    /* non-JSON error body */
  }
  let message = `${method} ${url.pathname} -> HTTP ${response.status}`;
  if (apiError.code) message += ` ${apiError.code}`;
  message += `: ${apiError.message ?? (text.slice(0, 300) || response.statusText)}`;
  if (response.status === 401) {
    access.onRejected?.();
    message += api === 'robot'
      ? ' (the Robot webservice user or password is wrong; do not retry: Robot blocks the IP for 10 minutes after 3 failed logins)'
      : ' (the API token of this project is invalid or was deleted)';
  }
  if (response.status === 403 && method !== 'GET' && api !== 'robot') message += ' (the token may be read-only)';
  if (response.status === 429) {
    const reset = Number(response.headers.get('ratelimit-reset'));
    message += reset ? ` (rate limit resets at ${new Date(reset * 1000).toISOString()})` : ' (rate limited, retry later)';
  }
  fail(message, { status: response.status, code: apiError.code, details: apiError.details });
}
