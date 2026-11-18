/**
 * Hosted mode end to end: the real server (`--http`) against a fake Hetzner API.
 * Flow: MCP client OAuth with this server -> connect page -> store a token per
 * project / a Robot webservice user -> tools routed by `project`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TENANTS = [
  { id: 'prod', name: 'Production', type: 'cloud', writes: false },
  { id: 'Stage', name: 'Staging', type: 'cloud', writes: true },
  { id: 'metal', name: 'Dedicated servers', type: 'robot', writes: true },
];
const ROBOT_AUTH = 'Basic ' + Buffer.from('#ws+abc:robot-secret').toString('base64');
const SECRET = 'test-secret-test-secret-test-secret-1234';

const freePort = () =>
  new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const fake = { tokens: new Set(['token-prod-1111', 'token-stage-2222']), calls: [] };
let fakeServer, fakePort, server, base, dir;

/** Starts `--http` with the test tenants; `env` overrides, `options.dir` reuses a data directory (same DB file). */
async function startHosted(env = {}, options = {}) {
  const port = options.port ?? (await freePort());
  const dataDir = options.dir ?? mkdtempSync(path.join(tmpdir(), 'hetzner-mcp-test-'));
  const url = `http://localhost:${port}`;
  const child = spawn(process.execPath, [ENTRY, '--http'], {
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      HETZNER_MCP_PUBLIC_URL: url,
      HETZNER_MCP_SECRET: SECRET,
      HETZNER_MCP_TENANTS: JSON.stringify({ tenants: TENANTS }),
      HETZNER_MCP_DB_PATH: path.join(dataDir, 'db.sqlite'),
      HETZNER_CLOUD_API_URL: `http://127.0.0.1:${fakePort}/v1`,
      HETZNER_API_URL: `http://127.0.0.1:${fakePort}/v1`,
      HETZNER_ROBOT_API_URL: `http://127.0.0.1:${fakePort}/robot`,
      ...env,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (c) => (log += c));
  const exited = new Promise((r) => child.once('exit', r));
  const instance = {
    base: url,
    dir: dataDir,
    port,
    child,
    get log() {
      return log;
    },
    /** Stops the server; removes the data directory unless keepData. */
    async stop({ keepData = false } = {}) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      if (!keepData) rmSync(dataDir, { recursive: true, force: true });
    },
  };
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`${url}/healthz`)).ok) return instance;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  await instance.stop();
  throw new Error(`server did not start: ${log}`);
}

before(async () => {
  fakePort = await freePort();
  fakeServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization ?? '';
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      fake.calls.push({ method: req.method, path: url.pathname, auth });
      if (url.pathname.startsWith('/robot/')) {
        if (auth !== ROBOT_AUTH) return json(401, { error: { status: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' } });
        if (url.pathname === '/robot/server') return json(200, [{ server: { server_number: 7, server_name: 'box' } }]);
        return json(404, { error: { status: 404, code: 'NOT_FOUND', message: 'not found' } });
      }
      const token = auth.replace(/^Bearer /, '');
      if (!fake.tokens.has(token)) return json(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } });
      if (url.pathname === '/v1/locations') return json(200, { locations: [] });
      if (url.pathname === '/v1/servers' && req.method === 'GET') return json(200, { servers: [{ id: 1, name: `server-of-${token}` }], meta: { pagination: { next_page: null } } });
      if (url.pathname === '/v1/servers/1' && req.method === 'DELETE') return json(200, { action: { id: 1, status: 'success' } });
      json(404, { error: { code: 'not_found', message: 'unknown route' } });
    });
  });
  await new Promise((r) => fakeServer.listen(fakePort, '127.0.0.1', r));

  server = await startHosted();
  base = server.base;
  dir = server.dir;
});

after(async () => {
  await server?.stop();
  fakeServer?.close();
});

const form = (data, cookie) => ({
  method: 'POST',
  redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
  body: new URLSearchParams(data),
});

/**
 * A browser: keeps the cookies the server sets (by name; attributes are not
 * checked here) and sends them back, plus fixed extra headers (e.g. the
 * Cloudflare Access token). Node's fetch has no cookie jar of its own.
 */
class Browser {
  constructor(headers = {}) {
    this.headers = headers;
    this.cookies = new Map();
  }
  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  /** The value of the browser-binding cookie (with or without __Host- prefix). */
  get nonce() {
    return [...this.cookies].find(([name]) => name.endsWith('hetzner_mcp_browser'))?.[1];
  }
  async fetch(url, init = {}) {
    const headers = { ...this.headers, ...(init.headers ?? {}), ...(this.cookies.size ? { cookie: this.cookieHeader } : {}) };
    const res = await fetch(url, { redirect: 'manual', ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
    return res;
  }
  post(url, data) {
    return this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  }
}

/** The form token the server expects from a browser with `nonce` for session `sid` (the test knows the secret). */
const csrfToken = (sid, nonce) => createHmac('sha256', SECRET).update(`csrf:${sid}:${nonce}`).digest('base64url');
const sidOf = (page) => new URL(page).pathname.split('/')[2];

/** What `browser` holds after opening a connect page: the browser cookie and the token in the forms. */
async function csrfFor(page, browser = new Browser()) {
  const res = await browser.fetch(page);
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(browser.nonce && csrf, `connect page must set the browser cookie and carry the token in its forms (HTTP ${res.status})`);
  return { browser, cookie: browser.cookieHeader, csrf, html, res };
}

/** Posts a form of the connect page `page` (e.g. '/finish', '/tenants/prod/key') the way a browser does. */
async function submit(page, action, data = {}, browser = new Browser()) {
  const { csrf } = await csrfFor(page, browser);
  return browser.post(`${page}${action}`, { ...data, csrf });
}

const registerRaw = (at, redirectUri, clientName = 'test client') =>
  fetch(`${at}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: clientName, token_endpoint_auth_method: 'none' }),
  });

/** Runs the MCP client's OAuth flow up to the connect page, in `browser` (which sends its grant cookie to /authorize). */
async function startAuthorization({ browser = new Browser(), at = base, publicUrl = at } = {}) {
  const redirectUri = 'http://localhost:9/callback';
  const reg = await registerRaw(at, redirectUri);
  assert.equal(reg.status, 201, await reg.clone().text());
  const client = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await browser.fetch(
    `${at}/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${publicUrl}/mcp` })}`,
  );
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const page = authorize.headers.get('location');
  assert.match(page, /^\/connect\/[\w-]+$/);
  return { client, verifier, redirectUri, page: `${at}${page}`, browser, at };
}

async function finishAuthorization({ client, verifier, redirectUri, page, browser, at }) {
  const finish = await submit(page, '/finish', {}, browser);
  assert.equal(finish.status, 303);
  const target = new URL(finish.headers.get('location'));
  assert.equal(target.origin + target.pathname, redirectUri);
  assert.equal(target.searchParams.get('state'), 'xyz');
  const token = await fetch(`${at}/token`, form({ grant_type: 'authorization_code', code: target.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }));
  assert.equal(token.status, 200, await token.clone().text());
  return token.json();
}

let rpcId = 0;
async function rpc(accessToken, method, params, at = base) {
  const res = await fetch(`${at}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
const call = async (accessToken, name, args, at = base) => {
  const { body } = await rpc(accessToken, 'tools/call', { name, arguments: args }, at);
  return { text: body.result.content[0].text, isError: body.result.isError === true, structured: body.result.structuredContent };
};

const MANAGE_WARNING = /Hat dir jemand diesen Link geschickt, schließ die Seite\.<\/b> Jeden Token, den du hier hinterlegst, kann diese Person verwenden/;

let tokens;
/** The browser that finished the first authorization: it carries the grant cookie of `tokens`. */
let ownerBrowser;

test('OAuth metadata is served and /mcp requires a token', async () => {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.token_endpoint, `${base}/token`);
  const unauth = await rpc(undefined, 'tools/list');
  assert.equal(unauth.status, 401);
});

test('connect page: rejects bad credentials, stores good ones, then issues tokens', async () => {
  const flow = await startAuthorization();
  const html = await (await fetch(flow.page)).text();
  for (const t of TENANTS) assert.ok(html.includes(t.name), t.name);
  assert.match(html, /Nur lesen/);

  const early = await submit(flow.page, '/finish');
  assert.match(early.headers.get('location'), /e=none_connected/);

  const bad = await submit(flow.page, '/tenants/prod/key', { api_token: 'wrong-token' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /nicht akzeptiert/);

  const good = await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' });
  assert.equal(good.status, 303);
  assert.match(good.headers.get('location'), /n=connected&t=prod/);
  assert.equal((await submit(flow.page, '/tenants/stage/key', { api_token: 'token-stage-2222' })).status, 303);

  const badRobot = await submit(flow.page, '/tenants/metal/key', { robot_user: '#ws+abc', robot_password: 'nope' });
  assert.equal(badRobot.status, 400);
  assert.equal((await submit(flow.page, '/tenants/metal/key', { robot_user: '#ws+abc', robot_password: 'robot-secret' })).status, 303);

  const after = await (await fetch(flow.page)).text();
  assert.match(after, /Token …1111/);
  assert.doesNotMatch(after, /token-prod-1111|robot-secret/);

  tokens = await finishAuthorization(flow);
  ownerBrowser = flow.browser;
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal((await fetch(flow.page)).status, 400, 'session is single use');

  const db = readFileSync(path.join(dir, 'db.sqlite'), 'latin1');
  for (const secret of ['token-prod-1111', 'token-stage-2222', 'robot-secret', tokens.access_token]) assert.ok(!db.includes(secret), `${secret} stored in plain text`);
});

test('tools are routed by project and respect read-only tenants', async () => {
  const list = await rpc(tokens.access_token, 'tools/list');
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), ['hetzner_execute', 'hetzner_list_accounts', 'hetzner_query', 'hetzner_search']);

  const ambiguous = await call(tokens.access_token, 'hetzner_query', { code: "async () => hetzner.get('/servers')" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /prod, stage/);

  const prod = await call(tokens.access_token, 'hetzner_query', { code: "async () => (await hetzner.get('/servers')).servers[0].name", project: 'prod' });
  assert.equal(JSON.parse(prod.text), 'server-of-token-prod-1111');
  const stage = await call(tokens.access_token, 'hetzner_query', { code: "async () => (await hetzner.get('/servers')).servers[0].name", project: 'STAGE' });
  assert.equal(JSON.parse(stage.text), 'server-of-token-stage-2222');

  fake.calls.length = 0;
  const blocked = await call(tokens.access_token, 'hetzner_execute', { code: "async () => hetzner.delete('/servers/1')", project: 'prod' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /read-only/);
  assert.equal(fake.calls.length, 0);
  const unconfirmed = await call(tokens.access_token, 'hetzner_execute', { code: "async () => hetzner.delete('/servers/1')", project: 'stage' });
  assert.match(unconfirmed.text, /was NOT sent, it needs the user's approval first/);
  const allowed = await call(tokens.access_token, 'hetzner_execute', { code: "async () => (await hetzner.delete('/servers/1')).action.status", project: 'stage', confirmed: true });
  assert.equal(JSON.parse(allowed.text), 'success');
  const billed = await call(tokens.access_token, 'hetzner_execute', { code: "async () => hetzner.post('/servers', { name: 'a', server_type: 'cx23', image: 'x' })", project: 'stage', confirmed: true });
  assert.match(billed.text, /billed requests are switched off for this project.*"billed": true in the tenant configuration/s);

  const robot = await call(tokens.access_token, 'hetzner_query', { code: "async () => (await robot.get('/server'))[0].server.server_name" });
  assert.equal(JSON.parse(robot.text), 'box');
  assert.equal(fake.calls.at(-1).auth, ROBOT_AUTH);
});

test('rejected credentials are marked and the model gets a link to replace them', async () => {
  fake.tokens.delete('token-stage-2222');
  const failed = await call(tokens.access_token, 'hetzner_query', { code: "async () => hetzner.get('/servers')", project: 'stage' });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /HTTP 401/);

  const accounts = await call(tokens.access_token, 'hetzner_list_accounts', {});
  const byId = Object.fromEntries(accounts.structured.accounts.map((a) => [a.id, a]));
  assert.equal(byId.stage.status, 'rejected');
  assert.equal(byId.prod.status, 'connected');
  assert.equal(byId.metal.argument, 'robot_account');
  assert.doesNotMatch(accounts.text, /token-prod-1111|robot-secret/);

  const gone = await call(tokens.access_token, 'hetzner_query', { code: "async () => hetzner.get('/servers')", project: 'stage' });
  assert.match(gone.text, /Unknown project "stage"/);

  // The manage link opens the connect page for the same person; a new token repairs the connection.
  const link = accounts.structured.connect_url;
  assert.match(await (await fetch(link)).text(), /abgelehnt/);
  fake.tokens.add('token-stage-3333');
  assert.equal((await submit(link, '/tenants/stage/key', { api_token: 'token-stage-3333' })).status, 303);
  const repaired = await call(tokens.access_token, 'hetzner_query', { code: "async () => (await hetzner.get('/servers')).servers[0].name", project: 'stage' });
  assert.equal(JSON.parse(repaired.text), 'server-of-token-stage-3333');
});

test('manage links: warning on the page, refused in a browser connected with another grant', async () => {
  const link = (await call(tokens.access_token, 'hetzner_list_accounts', {})).structured.connect_url;
  const sid = sidOf(link);

  // A browser without grant cookie gets the page with the warning; the connected accounts stay visible.
  const page = await (await fetch(link)).text();
  assert.match(page, MANAGE_WARNING);
  assert.match(page, /Token …1111/);
  assert.match(await (await fetch(`${link}/tenants/stage/key`)).text(), MANAGE_WARNING);
  // The authorization page has its own notice, not this one.
  assert.doesNotMatch(await (await fetch((await startAuthorization()).page)).text(), MANAGE_WARNING);

  // A colleague whose browser finished its own authorization (grant cookie of another grant).
  const colleague = await startAuthorization();
  assert.equal((await submit(colleague.page, '/tenants/prod/key', { api_token: 'token-prod-1111' }, colleague.browser)).status, 303);
  await finishAuthorization(colleague);
  const refused = await colleague.browser.fetch(link);
  assert.equal(refused.status, 403);
  const refusedText = await refused.text();
  assert.match(refusedText, /anderen Claude-Zugang als dem, der in diesem Browser verbunden ist/);
  assert.doesNotMatch(refusedText, /<form/);
  assert.equal((await colleague.browser.fetch(`${link}/tenants/stage/key`)).status, 403);
  // Not even a form token that would be valid for this browser gets through.
  fake.tokens.add('token-colleague-5555');
  fake.calls.length = 0;
  const csrf = csrfToken(sid, colleague.browser.nonce);
  for (const [action, data] of [
    ['/tenants/stage/key', { api_token: 'token-colleague-5555' }],
    ['/tenants/prod/disconnect', {}],
    ['/finish', {}],
  ]) {
    assert.equal((await colleague.browser.post(`${link}${action}`, { ...data, csrf })).status, 403, action);
  }
  assert.equal(fake.calls.length, 0, 'no credential check was made');
  const accounts = Object.fromEntries((await call(tokens.access_token, 'hetzner_list_accounts', {})).structured.accounts.map((a) => [a.id, a]));
  assert.equal(accounts.stage.connected_as, 'Token …3333', 'nothing stored in the grant of the link');
  assert.equal(accounts.prod.status, 'connected');

  // The colleague's own browser still authorizes normally: /authorize reuses the grant of its cookie.
  const again = await startAuthorization({ browser: colleague.browser });
  const againPage = await colleague.browser.fetch(again.page);
  assert.equal(againPage.status, 200);
  assert.match(await againPage.text(), /Token …1111/);

  // A signed grant cookie for a grant that no longer exists does not block: /authorize starts a new grant.
  const stale = new Browser();
  stale.cookies.set('hetzner_mcp_grant', `gone.${createHmac('sha256', SECRET).update('grant:gone').digest('base64url')}`);
  const fresh = await startAuthorization({ browser: stale });
  assert.equal((await stale.fetch(fresh.page)).status, 200);

  // The browser carrying the link's own grant cookie uses the page as before (with the warning).
  const own = await csrfFor(link, ownerBrowser);
  assert.equal(own.res.status, 200);
  assert.match(own.html, MANAGE_WARNING);
  assert.equal(own.csrf, csrfToken(sid, ownerBrowser.nonce));
  assert.equal((await submit(link, '/tenants/stage/key', { api_token: 'token-colleague-5555' }, ownerBrowser)).status, 303);
  const updated = Object.fromEntries((await call(tokens.access_token, 'hetzner_list_accounts', {})).structured.accounts.map((a) => [a.id, a]));
  assert.equal(updated.stage.connected_as, 'Token …5555');
  const done = await submit(link, '/finish', {}, ownerBrowser);
  assert.equal(done.status, 200);
  assert.match(await done.text(), /Fertig/);
});

test('refresh tokens rotate and a second person sees only their own connections', async () => {
  const flow = await startAuthorization();
  assert.doesNotMatch(await (await fetch(flow.page)).text(), /Token …1111/);
  assert.equal((await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' })).status, 303);
  const other = await finishAuthorization(flow);
  const robot = await call(other.access_token, 'hetzner_query', { code: "async () => robot.get('/server')" });
  assert.equal(robot.isError, true);
  assert.match(robot.text, /No Hetzner Robot account is connected/);
  const one = await call(other.access_token, 'hetzner_query', { code: "async () => (await hetzner.get('/servers')).servers.length" });
  assert.equal(one.text, '1');

  const refreshed = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: other.refresh_token, client_id: flow.client.client_id }));
  assert.equal(refreshed.status, 200);
  const reuse = await fetch(`${base}/token`, form({ grant_type: 'refresh_token', refresh_token: other.refresh_token, client_id: flow.client.client_id }));
  assert.equal(reuse.status, 400);
});

describe('hosted mode: who may receive the access (confused deputy)', () => {
  const authorizeUrl = (at, clientId, redirectUri, challenge = 'x'.repeat(43)) =>
    `${at}/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' })}`;

  test('only known redirect URIs may register; the list can be extended or replaced via env', async () => {
    const extended = await startHosted({ HETZNER_MCP_ALLOWED_REDIRECT_URIS: 'https://app.example.com/oauth/callback' });
    try {
      const evil = await registerRaw(extended.base, 'https://attacker.example/steal');
      assert.equal(evil.status, 400);
      assert.equal((await evil.json()).error, 'invalid_redirect_uri');
      // Look-alikes of allowed hosts do not pass.
      for (const uri of [
        'https://claude.ai.attacker.example/api/mcp/auth_callback',
        'http://localhost.attacker.example/cb',
        'https://claude.ai/other',
        'http://user@localhost:9/cb',
      ]) {
        assert.equal((await registerRaw(extended.base, uri)).status, 400, uri);
      }
      for (const uri of [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
        'http://localhost:53682/callback',
        'http://127.0.0.1:8080/',
        'https://app.example.com/oauth/callback',
      ]) {
        assert.equal((await registerRaw(extended.base, uri)).status, 201, uri);
      }
      assert.match(extended.log, /Client registration refused: redirect URI\(s\) not allowed: https:\/\/attacker\.example\/steal/);
    } finally {
      await extended.stop();
    }

    const strict = await startHosted({ HETZNER_MCP_DEFAULT_REDIRECT_URIS: 'false', HETZNER_MCP_ALLOWED_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback' });
    try {
      assert.equal((await registerRaw(strict.base, 'http://localhost:53682/callback')).status, 400);
      assert.equal((await registerRaw(strict.base, 'https://claude.ai/api/mcp/auth_callback')).status, 201);
    } finally {
      await strict.stop();
    }

    // Defaults dropped and nothing listed: the server refuses to start.
    await assert.rejects(startHosted({ HETZNER_MCP_DEFAULT_REDIRECT_URIS: 'false' }), /no redirect URIs allowed/);
  });

  test('/authorize is refused without redirect for a client registered before the list was narrowed', async () => {
    const loose = await startHosted({ HETZNER_MCP_ALLOWED_REDIRECT_URIS: 'https://old.example/cb' });
    const reg = await registerRaw(loose.base, 'https://old.example/cb');
    assert.equal(reg.status, 201);
    const { client_id: clientId } = await reg.json();
    await loose.stop({ keepData: true });

    const narrowed = await startHosted({}, { dir: loose.dir });
    try {
      const res = await fetch(authorizeUrl(narrowed.base, clientId, 'https://old.example/cb'), { redirect: 'manual' });
      assert.equal(res.status, 400);
      assert.equal(res.headers.get('location'), null);
      assert.match(await res.text(), /Verbindung abgelehnt/);
    } finally {
      await narrowed.stop();
    }
  });

  test('the connect page names the app and where the access goes', async () => {
    const flow = await startAuthorization();
    const { html, res } = await csrfFor(flow.page);
    assert.match(html, /„test client“/);
    assert.match(html, /nicht geprüft/);
    assert.match(html, /deinem eigenen Computer<\/b> \(localhost:9\)/);
    assert.match(html, /Abbrechen/);
    // Over plain http (localhost) the browser cookie cannot carry the __Host- prefix.
    const setCookie = res.headers.getSetCookie().find((c) => c.includes('hetzner_mcp_browser'));
    assert.match(setCookie, /^hetzner_mcp_browser=[\w-]{43};/);
    assert.match(setCookie, /;\s*HttpOnly/i);
    assert.match(setCookie, /;\s*SameSite=Lax/i);
    assert.match(setCookie, /;\s*Path=\/(;|$)/);
    assert.doesNotMatch(setCookie, /;\s*Secure/i);
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith('hetzner_mcp_csrf=')), 'the old per-session cookie is gone');

    // A remote redirect target is shown by host, so a person can check it.
    const reg = await registerRaw(base, 'https://claude.ai/api/mcp/auth_callback', 'Claude');
    const { client_id: clientId } = await reg.json();
    const authorize = await fetch(authorizeUrl(base, clientId, 'https://claude.ai/api/mcp/auth_callback'), { redirect: 'manual' });
    assert.equal(authorize.status, 302);
    const remote = await (await fetch(`${base}${authorize.headers.get('location')}`)).text();
    assert.match(remote, /„Claude“/);
    assert.match(remote, /<b>claude\.ai<\/b>/);
  });

  test('the connect page forms cannot be posted cross-site (CSRF)', async () => {
    const flow = await startAuthorization();
    const { browser, cookie, csrf } = await csrfFor(flow.page);
    const post = (action, data, cookieHeader) => fetch(`${flow.page}${action}`, form(data, cookieHeader));

    // A cross-site post may know a token at best, but never carries the browser cookie that fits it.
    const noCookie = await post('/tenants/prod/key', { api_token: 'token-prod-1111', csrf });
    assert.equal(noCookie.status, 403);
    assert.match(await noCookie.text(), /Nicht bestätigt/);
    assert.doesNotMatch(await (await fetch(flow.page)).text(), /Token …1111/, 'nothing stored');

    for (const action of ['/finish', '/cancel', '/tenants/prod/disconnect']) {
      assert.equal((await post(action, {})).status, 403, `${action} without cookie and token`);
      assert.equal((await post(action, { csrf })).status, 403, `${action} without cookie`);
      assert.equal((await post(action, {}, cookie)).status, 403, `${action} without token`);
      assert.equal((await post(action, { csrf }, 'hetzner_mcp_browser=short')).status, 403, `${action} with a malformed cookie`);
    }
    // The old scheme (token from the session id alone, per-session cookie) no longer passes.
    const legacy = createHmac('sha256', SECRET).update(`csrf:${sidOf(flow.page)}`).digest('base64url');
    assert.equal((await post('/finish', { csrf: legacy }, `hetzner_mcp_csrf=${legacy}`)).status, 403);

    // A token from another session does not fit this one, also in the same browser.
    const other = await startAuthorization();
    const foreign = await csrfFor(other.page, browser);
    assert.equal(browser.cookieHeader, cookie, 'an existing browser cookie is reused');
    assert.equal((await browser.post(`${flow.page}/finish`, { csrf: foreign.csrf })).status, 403);

    // The session is untouched and works with the browser's own cookie and token.
    assert.equal((await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' }, browser)).status, 303);
    const done = await finishAuthorization({ ...flow, browser });
    assert.ok(done.access_token);
  });

  test('the form token is bound to the browser: a token from another browser is refused', async () => {
    const flow = await startAuthorization();
    const victim = await csrfFor(flow.page, new Browser());
    const attacker = await csrfFor(flow.page, new Browser());
    assert.notEqual(attacker.csrf, victim.csrf);
    assert.notEqual(attacker.browser.nonce, victim.browser.nonce);

    // The attacker knows the link, opens the page himself and makes the victim's browser post his
    // token: the victim's browser sends the victim's cookie, which the token does not fit.
    fake.calls.length = 0;
    const forged = await victim.browser.post(`${flow.page}/tenants/prod/key`, { api_token: 'token-prod-1111', csrf: attacker.csrf });
    assert.equal(forged.status, 403);
    // Likewise the victim's token in another browser.
    assert.equal((await attacker.browser.post(`${flow.page}/tenants/prod/key`, { api_token: 'token-prod-1111', csrf: victim.csrf })).status, 403);
    assert.equal((await victim.browser.post(`${flow.page}/finish`, { csrf: attacker.csrf })).status, 403);
    assert.equal(fake.calls.length, 0);
    assert.doesNotMatch(await (await fetch(flow.page)).text(), /Token …1111/, 'nothing stored');

    // Each browser's own token works.
    assert.equal((await victim.browser.post(`${flow.page}/tenants/prod/key`, { api_token: 'token-prod-1111', csrf: victim.csrf })).status, 303);
  });

  test('with an https public URL the browser cookie is a __Host- cookie', async () => {
    const port = await freePort();
    // Requested over plain http directly, as a reverse proxy would.
    const secure = await startHosted({ HETZNER_MCP_PUBLIC_URL: `https://127.0.0.1:${port}` }, { port });
    try {
      const flow = await startAuthorization({ at: secure.base, publicUrl: `https://127.0.0.1:${port}` });
      const { res, browser } = await csrfFor(flow.page, flow.browser);
      const setCookie = res.headers.getSetCookie().find((c) => c.includes('hetzner_mcp_browser'));
      assert.match(setCookie, /^__Host-hetzner_mcp_browser=[\w-]{43};/);
      assert.match(setCookie, /;\s*Secure(;|$)/i);
      assert.match(setCookie, /;\s*Path=\/(;|$)/);
      assert.match(setCookie, /;\s*HttpOnly/i);
      assert.match(setCookie, /;\s*SameSite=Lax/i);
      assert.match(setCookie, /;\s*Max-Age=86400/i);
      assert.doesNotMatch(setCookie, /Domain=/i);
      assert.ok(!browser.cookies.has('hetzner_mcp_browser'));

      // The same cookie is kept on the next page, and the forms work with it.
      const nonce = browser.nonce;
      await csrfFor(`${flow.page}/tenants/prod/key`, browser);
      assert.equal(browser.nonce, nonce);
      assert.equal((await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' }, browser)).status, 303);
      // The unprefixed name is not accepted in its place.
      const csrf = csrfToken(sidOf(flow.page), nonce);
      assert.equal((await fetch(`${flow.page}/finish`, form({ csrf }, `hetzner_mcp_browser=${nonce}`))).status, 403);
    } finally {
      await secure.stop();
    }
  });
});

describe('hosted mode behind Cloudflare Access: grants have an owner', () => {
  let jwks, issuer, privateKey;
  const AUD = 'test-aud';

  before(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    const port = await freePort();
    issuer = `http://127.0.0.1:${port}`;
    // Stands in for <team>.cloudflareaccess.com: serves the signing keys.
    jwks = http.createServer((req, res) => {
      const found = req.url === '/cdn-cgi/access/certs';
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(found ? { keys: [jwk] } : {}));
    });
    await new Promise((r) => jwks.listen(port, '127.0.0.1', r));
  });
  after(() => jwks?.close());

  /** A browser that passed Cloudflare Access as `email`. */
  const signedIn = async (email) =>
    new Browser({
      'cf-access-jwt-assertion': await new SignJWT({ email })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience(AUD)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey),
    });

  test('the first authorization sets the owner; only the owner may open the grant\'s pages', async () => {
    // A database from before grants had an owner, with one grant and an MCP access token for it.
    const dataDir = mkdtempSync(path.join(tmpdir(), 'hetzner-mcp-test-'));
    const dbFile = path.join(dataDir, 'db.sqlite');
    const now = Math.floor(Date.now() / 1000);
    const legacyToken = randomBytes(32).toString('base64url');
    const old = new DatabaseSync(dbFile);
    old.exec(`CREATE TABLE grants (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE TABLE tokens (token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
        resource TEXT, expires_at INTEGER NOT NULL);`);
    old.prepare('INSERT INTO grants VALUES (?, ?, ?)').run('legacy-grant', now, now);
    old.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?, ?, ?)').run(createHash('sha256').update(legacyToken).digest('hex'), 'access', 'legacy-grant', 'legacy-client', null, now + 3600);
    old.close();
    const query = (sql, ...args) => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      try {
        return db.prepare(sql).get(...args);
      } finally {
        db.close();
      }
    };
    const ownerOf = (grantId) => query('SELECT owner FROM grants WHERE id = ?', grantId)?.owner ?? null;
    const grantOf = (accessToken) => query('SELECT grant_id FROM tokens WHERE token_hash = ?', createHash('sha256').update(accessToken).digest('hex')).grant_id;

    const srv = await startHosted({ HETZNER_MCP_CF_ACCESS_TEAM_DOMAIN: issuer, HETZNER_MCP_CF_ACCESS_AUD: AUD }, { dir: dataDir });
    try {
      // Migrated: the old grant has no owner. Its manage link opens for whoever passes Access (with the
      // warning), and finishing a manage session never sets an owner.
      assert.equal(ownerOf('legacy-grant'), null);
      const legacyLink = (await call(legacyToken, 'hetzner_list_accounts', {}, srv.base)).structured.connect_url;
      assert.equal((await fetch(legacyLink)).status, 403, 'no Access token');
      const bob = await signedIn('bob@example.com');
      const legacyPage = await bob.fetch(legacyLink);
      assert.equal(legacyPage.status, 200);
      assert.match(await legacyPage.text(), MANAGE_WARNING);
      assert.equal((await submit(legacyLink, '/finish', {}, bob)).status, 200);
      assert.equal(ownerOf('legacy-grant'), null);

      // Alice authorizes: finishing records her as the owner.
      const alice = await signedIn('alice@example.com');
      const flow = await startAuthorization({ browser: alice, at: srv.base });
      assert.equal((await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' }, alice)).status, 303);
      const aliceTokens = await finishAuthorization(flow);
      const grantId = grantOf(aliceTokens.access_token);
      assert.equal(ownerOf(grantId), 'alice@example.com');

      // Her manage link, forwarded to Bob: refused (his browser has no grant cookie, the owner check
      // stands alone), without telling him whose link it is.
      const link = (await call(aliceTokens.access_token, 'hetzner_list_accounts', {}, srv.base)).structured.connect_url;
      const bobFresh = await signedIn('bob@example.com');
      const refused = await bobFresh.fetch(link);
      assert.equal(refused.status, 403);
      const refusedText = await refused.text();
      assert.match(refusedText, /einer anderen Person/);
      assert.doesNotMatch(refusedText, /alice/i);
      assert.doesNotMatch(refusedText, /<form/);
      assert.equal((await bobFresh.fetch(`${link}/tenants/stage/key`)).status, 403);
      // Not even with a form token that fits his browser.
      const nonce = randomBytes(32).toString('base64url');
      bobFresh.cookies.set('hetzner_mcp_browser', nonce);
      fake.tokens.add('token-bob-6666');
      const forged = await bobFresh.post(`${link}/tenants/stage/key`, { api_token: 'token-bob-6666', csrf: csrfToken(sidOf(link), nonce) });
      assert.equal(forged.status, 403);
      const accounts = Object.fromEntries((await call(aliceTokens.access_token, 'hetzner_list_accounts', {}, srv.base)).structured.accounts.map((a) => [a.id, a]));
      assert.equal(accounts.stage.status, 'not_connected', 'nothing stored');
      assert.match(srv.log, /bob@example\.com is not the owner of this grant/);

      // Alice in another browser, with different capitalisation, gets in.
      const aliceElsewhere = await signedIn('Alice@Example.COM');
      const own = await aliceElsewhere.fetch(link);
      assert.equal(own.status, 200);
      assert.match(await own.text(), /Token …1111/);
      assert.equal((await submit(link, '/tenants/stage/key', { api_token: 'token-bob-6666' }, aliceElsewhere)).status, 303);
      assert.equal((await submit(link, '/finish', {}, aliceElsewhere)).status, 200);
      assert.equal(ownerOf(grantId), 'alice@example.com');

      // A new authorization from Alice's browser reuses her grant; the owner stays.
      const again = await startAuthorization({ browser: alice, at: srv.base });
      assert.equal((await alice.fetch(again.page)).status, 200);
      await finishAuthorization(again);
      assert.equal(ownerOf(grantId), 'alice@example.com');
    } finally {
      await srv.stop();
    }
  });
});
