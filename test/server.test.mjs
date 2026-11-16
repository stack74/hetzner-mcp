import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const requests = [];
let mock;
let baseUrl;
let actionPolls = 0;

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: url.pathname, search: url.search, auth: req.headers.authorization, body });
      const json = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(data === undefined ? '' : JSON.stringify(data));
      };
      if (url.pathname === '/robot/server') return json(200, [{ server: { server_number: 321, server_name: 'box', server_ip: '138.0.0.1' } }]);
      if (url.pathname === '/robot/firewall/321' && req.method === 'POST') {
        return json(200, { firewall: { status: 'in process', contentType: req.headers['content-type'], raw: body } });
      }
      if (url.pathname === '/robot/boot/1') {
        return json(400, { error: { status: 400, code: 'INVALID_INPUT', message: 'invalid input', missing: ['os'], invalid: null } });
      }
      if (url.pathname === '/v1/servers' && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? 1);
        return json(200, {
          servers: [{ id: page, name: `srv-${page}`, filler: 'x'.repeat(100) }],
          meta: { pagination: { page, next_page: page < 3 ? page + 1 : null } },
        });
      }
      if (url.pathname === '/v1/servers/1/actions/reboot') return json(201, { action: { id: 7, command: 'reboot_server', status: 'running', progress: 0 } });
      if (url.pathname === '/v1/actions/7') {
        actionPolls++;
        return json(200, { action: { id: 7, command: 'reboot_server', status: actionPolls > 1 ? 'success' : 'running', progress: 50 } });
      }
      if (url.pathname === '/v1/servers/2' && req.method === 'DELETE') return json(204);
      if (url.pathname === '/v1/servers/2' && req.method === 'GET') return json(200, { server: { id: 2, name: 'old-box', created: '2024-03-01T10:00:00+00:00', server_type: { name: 'cx23' } } });
      if (url.pathname === '/v1/servers' && req.method === 'POST') return json(201, { server: { id: 9, name: JSON.parse(body).name }, action: { id: 7, status: 'running' } });
      if (url.pathname === '/v1/pricing') {
        return json(200, { pricing: { currency: 'EUR', vat_rate: '19.00', volume: { price_per_gb_month: { net: '0.044', gross: '0.05236' } },
          server_types: [{ id: 1, name: 'cx23', prices: [{ location: 'nbg1', price_hourly: { gross: '0.0071' }, price_monthly: { gross: '4.15' } }, { location: 'hel1', price_hourly: { gross: '0.0080' }, price_monthly: { gross: '4.75' } }] }] } });
      }
      if (url.pathname === '/v1/storage_boxes') return json(200, { storage_boxes: [], host: req.headers.host });
      if (url.pathname === '/v1/servers/999') {
        return json(404, { error: { code: 'not_found', message: 'server with ID 999 not found', details: null } });
      }
      json(404, { error: { code: 'not_found', message: 'unknown mock route' } });
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${mock.address().port}/v1`;
});
after(() => mock.close());

async function connect(env = {}, onElicit) {
  const client = new Client({ name: 'test', version: '1.0.0' }, onElicit ? { capabilities: { elicitation: {} } } : undefined);
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request) => onElicit(request.params));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY],
      env: { PATH: process.env.PATH, HETZNER_CLOUD_API_URL: baseUrl, HETZNER_API_URL: baseUrl, HETZNER_ROBOT_API_URL: baseUrl.replace('/v1', '/robot'), ...env },
      stderr: 'ignore',
    }),
  );
  const call = async (name, args) => {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
    return { text: res.content[0].text, isError: res.isError === true };
  };
  return { client, call };
}

test('lists three tools with matching annotations', async () => {
  const { client } = await connect({ HETZNER_API_TOKEN: 'tok-default' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['hetzner_execute', 'hetzner_query', 'hetzner_search']);
  assert.equal(tools.find((t) => t.name === 'hetzner_query').annotations.readOnlyHint, true);
  assert.equal(tools.find((t) => t.name === 'hetzner_execute').annotations.destructiveHint, true);
  await client.close();
});

test('read-only mode hides hetzner_execute', async () => {
  const { client } = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_READ_ONLY: '1' });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['hetzner_query', 'hetzner_search']);
  await client.close();
});

test('search works without a token and covers both APIs', async () => {
  const { client, call } = await connect();
  const hits = JSON.parse((await call('hetzner_search', { code: "async () => search('firewall')" })).text);
  assert.ok(hits.some((h) => h.operationId === 'create_firewall'));
  const boxes = JSON.parse((await call('hetzner_search', { code: "async () => search('storage box').map(o => o.api)" })).text);
  assert.ok(boxes.filter((api) => api === 'hetzner').length > 5);
  assert.ok(boxes.every((api) => api === 'hetzner' || api === 'robot'));
  const total = await call('hetzner_search', { code: 'operations.length' });
  assert.ok(Number(total.text) > 200);
  const noToken = await call('hetzner_query', { code: "async () => hetzner.get('/servers')" });
  assert.equal(noToken.isError, true);
  assert.match(noToken.text, /HETZNER_API_TOKEN/);
  await client.close();
});

test('describe condenses an operation and marks required fields', async () => {
  const { client, call } = await connect();
  const res = await call('hetzner_search', { code: "async () => describe('create_server')" });
  assert.equal(res.isError, false);
  const op = JSON.parse(res.text);
  assert.equal(op.method, 'POST');
  assert.equal(op.path, '/servers');
  for (const key of ['name*', 'server_type*', 'image*']) assert.ok(key in op.requestBody, `missing ${key}`);
  assert.ok(res.text.length < 20000, `describe output too large: ${res.text.length}`);
  const byPath = JSON.parse((await call('hetzner_search', { code: "async () => describe('GET /servers').parameters.map(p => p.name)" })).text);
  assert.ok(byPath.includes('label_selector'));
  const missing = await call('hetzner_search', { code: "async () => describe('nope')" });
  assert.equal(missing.isError, true);
  await client.close();
});

test('query paginates, sends the token and repeats array query keys', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok-default' });
  requests.length = 0;
  const res = await call('hetzner_query', { code: "async () => (await hetzner.paginate('/servers', { status: ['running', 'off'] })).map(s => s.name)" });
  assert.deepEqual(JSON.parse(res.text), ['srv-1', 'srv-2', 'srv-3']);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].auth, 'Bearer tok-default');
  assert.match(requests[0].search, /status=running&status=off/);
  assert.match(requests[0].search, /per_page=50/);
  await client.close();
});

test('query blocks writes, execute performs them', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  requests.length = 0;
  const blocked = await call('hetzner_query', { code: "async () => hetzner.delete('/servers/2')" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /hetzner_execute/);
  assert.equal(requests.length, 0);

  const caught = await call('hetzner_query', { code: "async () => { try { await hetzner.post('/servers', {}); } catch (e) { return e.code; } }" });
  assert.equal(JSON.parse(caught.text), 'read_only');

  const deleted = await call('hetzner_execute', { code: "async () => hetzner.delete('/servers/2')", confirmed: true });
  assert.equal(deleted.isError, false);
  assert.equal(deleted.text, 'null');
  assert.equal(requests.at(-1).method, 'DELETE');
  await client.close();
});

test('waitForAction polls until the action finished', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  actionPolls = 0;
  const res = await call('hetzner_execute', {
    code: "async () => { const r = await hetzner.post('/servers/1/actions/reboot'); return (await hetzner.waitForAction(r, { intervalMs: 10 })).status; }",
  });
  assert.equal(JSON.parse(res.text), 'success');
  assert.equal(actionPolls, 2);
  await client.close();
});

test('API errors surface status, code and message', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  const res = await call('hetzner_query', { code: "async () => hetzner.get('/servers/999')" });
  assert.equal(res.isError, true);
  assert.match(res.text, /HTTP 404 not_found: server with ID 999 not found/);
  const caught = await call('hetzner_query', { code: "async () => { try { await hetzner.get('/servers/999'); } catch (e) { return [e.status, e.code]; } }" });
  assert.deepEqual(JSON.parse(caught.text), [404, 'not_found']);
  await client.close();
});

test('projects select their own token', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN_PROD: 'tok-prod', HETZNER_API_TOKEN_STAGING: 'tok-staging' });
  const ambiguous = await call('hetzner_query', { code: "async () => hetzner.get('/servers')" });
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.text, /prod, staging/);
  requests.length = 0;
  await call('hetzner_query', { code: "async () => hetzner.get('/servers')", project: 'staging' });
  assert.equal(requests[0].auth, 'Bearer tok-staging');
  const unknown = await call('hetzner_query', { code: '1', project: 'nope' });
  assert.match(unknown.text, /Unknown project/);
  await client.close();
});

test('paths cannot leave the API host', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  requests.length = 0;
  for (const path of ['//evil.example/x', 'https://evil.example/x', '/../../x', '@evil.example/x']) {
    const res = await call('hetzner_query', { code: `async () => hetzner.get(${JSON.stringify(path)})` });
    assert.equal(res.isError, true, path);
  }
  assert.equal(requests.length, 0);
  await client.close();
});

test('sandbox has no host access and survives escape attempts', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'secret-token' });
  const globals = JSON.parse(
    (await call('hetzner_query', { code: "async () => [typeof process, typeof require, typeof fetch, typeof setTimeout, typeof Buffer, Object.keys(globalThis).sort().join()]" })).text,
  );
  assert.deepEqual(globals, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'hetzner,robot,sleep']);
  const evalBlocked = await call('hetzner_query', { code: "async () => eval('1 + 1')" });
  assert.equal(evalBlocked.isError, true);
  const attempts = [
    "async () => this.constructor.constructor('return process')().env",
    "async () => hetzner.request.constructor('return process')().env",
    "async () => console.log.constructor('return process')()",
    "async () => { const p = hetzner.get('/servers'); return p.constructor.constructor('return process')().env; }",
    "async () => { try { null.x } catch (e) { return e.constructor.constructor('return process')().env; } }",
    "async () => sleep.constructor('return process')().pid",
    "async () => import('node:fs')",
  ];
  for (const code of attempts) {
    const res = await call('hetzner_query', { code });
    assert.equal(res.isError, true, `escape not blocked: ${code} -> ${res.text}`);
    assert.doesNotMatch(res.text, /secret-token/);
  }
  await client.close();
});

test('runaway code is terminated and output is truncated', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_EXECUTE_TIMEOUT_SECONDS: '1', HETZNER_MAX_OUTPUT_CHARS: '500' });
  const started = Date.now();
  const loop = await call('hetzner_query', { code: "async () => { await sleep(5); for (;;) {} }" });
  assert.equal(loop.isError, true);
  assert.match(loop.text, /Timed out after 1s/);
  assert.ok(Date.now() - started < 5000);
  const big = await call('hetzner_query', { code: "async () => 'y'.repeat(5000)" });
  assert.match(big.text, /Output truncated: 5002 characters/);
  const stillAlive = await call('hetzner_query', { code: 'async () => 1 + 1' });
  assert.equal(stillAlive.text, '2');
  await client.close();
});

test('accepts statement-style code and reports console output and syntax errors', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  const statements = await call('hetzner_query', { code: "const r = await hetzner.get('/servers');\nconsole.log('count', r.servers.length);\nreturn r.servers[0].name;" });
  assert.match(statements.text, /^"srv-1"\n\n--- console ---\ncount 1$/);
  const syntax = await call('hetzner_query', { code: 'async () => {' });
  assert.equal(syntax.isError, true);
  assert.match(syntax.text, /SyntaxError/);
  const boxes = JSON.parse((await call('hetzner_query', { code: "async () => hetzner.get('/storage_boxes')" })).text);
  assert.deepEqual(boxes.storage_boxes, []);
  await client.close();
});

const ROBOT = { HETZNER_ROBOT_USER: '#ws+user', HETZNER_ROBOT_PASSWORD: 'p@ss:word' };

test('search covers the Robot API', async () => {
  const { client, call } = await connect();
  const hits = JSON.parse((await call('hetzner_search', { code: "async () => search('robot firewall').map(o => o.method + ' ' + o.path)" })).text);
  assert.ok(hits.includes('POST /firewall/{server-id}'));
  const op = JSON.parse((await call('hetzner_search', { code: "async () => describe('robot_post_firewall_server_id')" })).text);
  assert.equal(op.api, 'robot');
  assert.match(op.description, /## Input[\s\S]*whitelist_hos[\s\S]*## Rule data[\s\S]*dst_port[\s\S]*## Errors[\s\S]*FIREWALL_IN_PROCESS/);
  assert.match(op.description, /500 requests per 1 hour/);
  assert.match(op.examples.request, /rules\[input\]\[0\]\[action\]=accept/);
  const counts = JSON.parse((await call('hetzner_search', { code: "async () => [operations.filter(o => o.api === 'robot').length, apis.robot.overview.includes('RATE_LIMIT_EXCEEDED')]" })).text);
  assert.ok(counts[0] >= 100 && counts[1] === true);
  await client.close();
});

test('robot uses basic auth and works without a project token', async () => {
  const { client, call } = await connect(ROBOT);
  requests.length = 0;
  const res = await call('hetzner_query', { code: "async () => (await robot.get('/server')).map(x => x.server.server_number)" });
  assert.deepEqual(JSON.parse(res.text), [321]);
  assert.equal(requests[0].path, '/robot/server');
  assert.equal(requests[0].auth, 'Basic ' + Buffer.from('#ws+user:p@ss:word').toString('base64'));
  const cloud = await call('hetzner_query', { code: "async () => hetzner.get('/servers')" });
  assert.equal(cloud.isError, true);
  assert.match(cloud.text, /HETZNER_API_TOKEN/);
  await client.close();
});

test('robot bodies are form-encoded with nested keys, and writes need hetzner_execute', async () => {
  const { client, call } = await connect({ ...ROBOT, HETZNER_API_TOKEN: 'cloud-token' });
  const code = "async () => (await robot.post('/firewall/321', { status: 'active', whitelist_hos: true, rules: { input: [{ name: 'SIP & RTP', ip_version: 'ipv4', dst_port: '5060', protocol: 'udp', action: 'accept', src_ip: null }] } })).firewall";
  requests.length = 0;
  const blocked = await call('hetzner_query', { code });
  assert.equal(blocked.isError, true);
  assert.equal(requests.length, 0);
  const fw = JSON.parse((await call('hetzner_execute', { code })).text);
  assert.equal(fw.contentType, 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(fw.raw)), {
    status: 'active',
    whitelist_hos: 'true',
    'rules[input][0][name]': 'SIP & RTP',
    'rules[input][0][ip_version]': 'ipv4',
    'rules[input][0][dst_port]': '5060',
    'rules[input][0][protocol]': 'udp',
    'rules[input][0][action]': 'accept',
  });
  assert.match(requests.at(-1).auth, /^Basic /);
  assert.doesNotMatch(requests.at(-1).auth, /cloud-token/);
  await client.close();
});

test('robot errors keep their extra fields, missing credentials are explained', async () => {
  const { client, call } = await connect(ROBOT);
  const res = await call('hetzner_query', { code: "async () => { try { await robot.get('/boot/1'); } catch (e) { return [e.status, e.code, e.details]; } }" });
  assert.deepEqual(JSON.parse(res.text), [400, 'INVALID_INPUT', { missing: ['os'], invalid: null }]);
  await client.close();
  const plain = await connect({ HETZNER_API_TOKEN: 'tok' });
  requests.length = 0;
  const missing = await plain.call('hetzner_query', { code: "async () => robot.get('/server')" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /HETZNER_ROBOT_USER/);
  assert.equal(requests.length, 0);
  await plain.client.close();
});

test('requests are checked against the API reference before they are sent', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', ...ROBOT });
  requests.length = 0;
  const typo = await call('hetzner_execute', { code: "async () => hetzner.post('/servers', { name: 'a', server_typ: 'cx23', image: 'ubuntu-24.04' })" });
  assert.equal(typo.isError, true);
  assert.match(typo.text, /was not sent/);
  assert.match(typo.text, /required field "server_type" is missing/);
  assert.match(typo.text, /unknown field "server_typ" \(did you mean "server_type"\?\)/);
  assert.match(typo.text, /describe\('create_server'\)/);

  const query = await call('hetzner_query', { code: "async () => hetzner.get('/servers', { label_selektor: 'a' })" });
  assert.match(query.text, /unknown field "label_selektor"/);
  const wrongApi = await call('hetzner_query', { code: "async () => hetzner.get('/server')" });
  assert.match(wrongApi.text, /use the `robot` object/);
  const robotTypo = await call('hetzner_execute', { code: "async () => robot.post('/firewall/321', { status: 'active', whitelist_host: true })" });
  assert.match(robotTypo.text, /did you mean "whitelist_hos"/);
  const code = await call('hetzner_query', { code: "async () => { try { await hetzner.get('/nope'); } catch (e) { return e.code; } }" });
  assert.equal(JSON.parse(code.text), 'validation_failed');
  assert.equal(requests.length, 0);

  const skipped = await call('hetzner_query', { code: "async () => { try { await hetzner.request({ path: '/nope', validate: false }); } catch (e) { return e.status; } }" });
  assert.equal(JSON.parse(skipped.text), 404);
  assert.equal(requests.length, 1);
  await client.close();
});

test('version constant matches package.json and --version', async () => {
  const { readFileSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(execFileSync(process.execPath, [ENTRY, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
  assert.match(execFileSync(process.execPath, [ENTRY, '--help'], { encoding: 'utf8' }), /HETZNER_API_TOKEN/);
});

const CREATE = "async () => (await hetzner.post('/servers', { name: 'web-1', server_type: 'cx23', image: 'ubuntu-24.04', location: 'nbg1' })).server.id";
const writes = () => requests.filter((r) => r.method !== 'GET');

test('billed requests are refused unless the operator allows them', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok' });
  requests.length = 0;
  for (const confirmed of [false, true]) {
    const res = await call('hetzner_execute', { code: CREATE, confirmed });
    assert.equal(res.isError, true);
    assert.match(res.text, /was NOT sent: it creates a server.*billed requests are switched off.*HETZNER_ALLOW_BILLED=1/s);
  }
  assert.equal(requests.length, 0);
  const code = await call('hetzner_execute', { code: `async () => { try { await (${CREATE})(); } catch (e) { return e.code; } }` });
  assert.equal(JSON.parse(code.text), 'billing_disabled');
  // Writes that cost nothing are unaffected.
  const reboot = await call('hetzner_execute', { code: "async () => (await hetzner.post('/servers/1/actions/reboot')).action.command" });
  assert.equal(JSON.parse(reboot.text), 'reboot_server');
  await client.close();
});

test('allowed billed requests first report the price and wait for confirmation', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_ALLOW_BILLED: '1' });
  requests.length = 0;
  const first = await call('hetzner_execute', { code: CREATE });
  assert.equal(first.isError, true);
  assert.match(first.text, /POST \/servers was NOT sent, it needs the user's approval first/);
  assert.match(first.text, /Price: server type cx23 in nbg1: 4\.15 EUR\/month, 0\.0071 EUR\/hour \(incl\. 19% VAT\)/);
  assert.match(first.text, /confirmed: true/);
  assert.equal(writes().length, 0);

  const second = await call('hetzner_execute', { code: CREATE, confirmed: true });
  assert.equal(second.text, '9');
  assert.equal(writes().length, 1);

  const range = await call('hetzner_execute', { code: "async () => hetzner.post('/servers', { name: 'a', server_type: 'cx23', image: 'x' })" });
  assert.match(range.text, /4\.15 to 4\.75 EUR\/month depending on the location/);
  await client.close();
});

test('destructive requests name what they affect and wait for confirmation', async () => {
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', ...ROBOT });
  requests.length = 0;
  const del = await call('hetzner_execute', { code: "async () => hetzner.delete('/servers/2')" });
  assert.equal(del.isError, true);
  assert.match(del.text, /DELETE \/servers\/2 was NOT sent.*deletes the resource permanently.*Affected: server "old-box" \(id 2\) type cx23 created 2024-03-01/s);
  assert.equal(writes().length, 0);
  // Configuration changes that cost nothing and lose no data are not held back.
  const firewall = await call('hetzner_execute', { code: "async () => (await robot.post('/firewall/321', { status: 'active', whitelist_hos: true, rules: { input: [] } })).firewall.status" });
  assert.equal(JSON.parse(firewall.text), 'in process');
  await client.close();

  const skip = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_SKIP_CONFIRMATION: '1' });
  const direct = await skip.call('hetzner_execute', { code: "async () => hetzner.delete('/servers/2')" });
  assert.equal(direct.text, 'null');
  const { tools } = await skip.client.listTools();
  assert.equal('confirmed' in tools.find((t) => t.name === 'hetzner_execute').inputSchema.properties, false);
  await skip.client.close();
});

test('with HETZNER_APPROVAL_DIALOG the person is asked instead of trusting the confirmed argument', async () => {
  const asked = [];
  let answer = { action: 'accept', content: { decision: 'decline' } };
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_ALLOW_BILLED: '1', HETZNER_APPROVAL_DIALOG: '1' }, (params) => {
    asked.push(params.message);
    return answer;
  });
  requests.length = 0;
  const declined = await call('hetzner_execute', { code: CREATE, confirmed: true });
  assert.equal(declined.isError, true);
  assert.match(declined.text, /the user declined it/);
  assert.equal(writes().length, 0);
  assert.match(asked[0], /POST \/servers creates a server.*Price: server type cx23 in nbg1: 4\.15 EUR\/month/s);

  answer = { action: 'cancel' };
  assert.match((await call('hetzner_execute', { code: CREATE })).text, /the user declined it/);

  answer = { action: 'accept', content: { decision: 'approve' } };
  assert.equal((await call('hetzner_execute', { code: CREATE })).text, '9');

  asked.length = 0;
  answer = { action: 'accept', content: { decision: 'approve_all' } };
  const both = await call('hetzner_execute', { code: `async () => { await (${CREATE})(); await hetzner.delete('/servers/2'); return 'done'; }` });
  assert.equal(JSON.parse(both.text), 'done');
  assert.equal(asked.length, 1, 'approve_all covers the rest of the run');
  await client.close();
});

test('a client that dismisses dialogs on its own does not block approvals by default', async () => {
  // Announces elicitation and answers "decline" without showing anything, as some clients do.
  const asked = [];
  const { client, call } = await connect({ HETZNER_API_TOKEN: 'tok', HETZNER_ALLOW_BILLED: '1' }, (params) => {
    asked.push(params.message);
    return { action: 'decline' };
  });
  const first = await call('hetzner_execute', { code: CREATE });
  assert.match(first.text, /needs the user's approval first.*confirmed: true/s);
  const second = await call('hetzner_execute', { code: CREATE, confirmed: true });
  assert.equal(second.text, '9');
  assert.equal(asked.length, 0);
  await client.close();
});
