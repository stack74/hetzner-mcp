/**
 * Hosted mode end to end: the real server (`--http`) against a fake Hetzner API.
 * Flow: MCP client OAuth with this server -> connect page -> store a token per
 * project / a Robot webservice user -> tools routed by `project`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const TENANTS = [
  { id: 'prod', name: 'Production', type: 'cloud', writes: false },
  { id: 'Stage', name: 'Staging', type: 'cloud', writes: true },
  { id: 'metal', name: 'Dedicated servers', type: 'robot', writes: true },
];
const ROBOT_AUTH = 'Basic ' + Buffer.from('#ws+abc:robot-secret').toString('base64');

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
      HETZNER_MCP_SECRET: 'test-secret-test-secret-test-secret-1234',
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

/** What a browser holds after opening a connect page: the CSRF cookie and the token in the forms. */
async function csrfFor(page) {
  const res = await fetch(page);
  const html = await res.text();
  const cookie = /hetzner_mcp_csrf=[^;]+/.exec(res.headers.get('set-cookie') ?? '')?.[0];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(cookie && csrf, 'connect page must set a CSRF cookie and carry the token in its forms');
  return { cookie, csrf, html, res };
}

/** Posts a form of the connect page `page` (e.g. '/finish', '/tenants/prod/key') the way a browser does. */
async function submit(page, action, data = {}) {
  const { cookie, csrf } = await csrfFor(page);
  return fetch(`${page}${action}`, form({ ...data, csrf }, cookie));
}

const registerRaw = (at, redirectUri, clientName = 'test client') =>
  fetch(`${at}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: clientName, token_endpoint_auth_method: 'none' }),
  });

/** Runs the MCP client's OAuth flow up to the connect page. */
async function startAuthorization() {
  const redirectUri = 'http://localhost:9/callback';
  const reg = await registerRaw(base, redirectUri);
  assert.equal(reg.status, 201, await reg.clone().text());
  const client = await reg.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await fetch(
    `${base}/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: `${base}/mcp` })}`,
    { redirect: 'manual' },
  );
  assert.equal(authorize.status, 302, await authorize.clone().text());
  const page = authorize.headers.get('location');
  assert.match(page, /^\/connect\/[\w-]+$/);
  return { client, verifier, redirectUri, page: `${base}${page}` };
}

async function finishAuthorization({ client, verifier, redirectUri, page }) {
  const finish = await submit(page, '/finish');
  assert.equal(finish.status, 303);
  const target = new URL(finish.headers.get('location'));
  assert.equal(target.origin + target.pathname, redirectUri);
  assert.equal(target.searchParams.get('state'), 'xyz');
  const token = await fetch(`${base}/token`, form({ grant_type: 'authorization_code', code: target.searchParams.get('code'), code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }));
  assert.equal(token.status, 200, await token.clone().text());
  return token.json();
}

let rpcId = 0;
async function rpc(accessToken, method, params) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
}
const call = async (accessToken, name, args) => {
  const { body } = await rpc(accessToken, 'tools/call', { name, arguments: args });
  return { text: body.result.content[0].text, isError: body.result.isError === true, structured: body.result.structuredContent };
};

let tokens;

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
    assert.match(res.headers.get('set-cookie') ?? '', /HttpOnly/i);
    assert.match(res.headers.get('set-cookie') ?? '', /SameSite=Strict/i);
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`Path=${new URL(flow.page).pathname}`));

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
    const { cookie, csrf } = await csrfFor(flow.page);

    // A cross-site post may know the token from the page at best, never carries the Strict cookie.
    const noCookie = await fetch(`${flow.page}/tenants/prod/key`, form({ api_token: 'token-prod-1111', csrf }));
    assert.equal(noCookie.status, 403);
    assert.match(await noCookie.text(), /Nicht bestätigt/);
    assert.doesNotMatch(await (await fetch(flow.page)).text(), /Token …1111/, 'nothing stored');

    for (const action of ['/finish', '/cancel', '/tenants/prod/disconnect']) {
      assert.equal((await fetch(`${flow.page}${action}`, form({}))).status, 403, `${action} without cookie and token`);
      assert.equal((await fetch(`${flow.page}${action}`, form({ csrf }))).status, 403, `${action} without cookie`);
      assert.equal((await fetch(`${flow.page}${action}`, form({}, cookie))).status, 403, `${action} without token`);
    }
    // A token from another session does not fit this one.
    const other = await startAuthorization();
    const foreign = await csrfFor(other.page);
    assert.equal((await fetch(`${flow.page}/finish`, form({ csrf: foreign.csrf }, foreign.cookie))).status, 403);

    // The session is untouched and works with the real cookie and token.
    assert.equal((await submit(flow.page, '/tenants/prod/key', { api_token: 'token-prod-1111' })).status, 303);
    const done = await finishAuthorization(flow);
    assert.ok(done.access_token);
  });
});
