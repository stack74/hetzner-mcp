# hetzner-code-mcp

MCP server for the Hetzner APIs in **code mode**: instead of one tool per endpoint, the
model looks an operation up in the API reference and then runs a small piece of JavaScript
against the API. Three tools cover all 327 operations:

- **Cloud API** (222 operations): servers, volumes, networks, firewalls, load balancers,
  IPs, images, certificates, DNS zones, Storage Boxes
- **Robot API** (105 operations): dedicated servers and their firewall, reset, rescue and
  boot configuration, reverse DNS, failover IPs, vSwitches, SSH keys, server ordering

| Tool | Purpose | Can change things |
| --- | --- | --- |
| `hetzner_search` | Explore the API reference (`search()`, `describe()`, raw `operations`). No token needed. | no |
| `hetzner_query` | Run JavaScript that reads from the API. Only GET requests pass. | no |
| `hetzner_execute` | Run JavaScript that may also POST, PUT and DELETE. | yes |

Reads and writes are separate tools, so a client can auto-approve `hetzner_query` and still
ask before every `hetzner_execute`.

Why code mode: one call can chain requests, follow pagination and return only the fields
that matter, instead of pushing whole API responses through the model. New Hetzner
endpoints arrive with `npm run update-spec`, without new tool code.

Runs locally over stdio, or [hosted](#hosted-mode-claudeai-connector-for-a-team) as a
remote connector for a team.

Not affiliated with Hetzner Online GmbH.

## Setup

Requires Node.js 22.13 or newer.

Create an API token in the [Hetzner Console](https://console.hetzner.com/) under
Security → API Tokens. A token belongs to exactly one project. A read-only token is enough
for `hetzner_query`.

Claude Code:

```bash
claude mcp add hetzner --scope user \
  --env HETZNER_API_TOKEN=your-token \
  -- npx -y hetzner-code-mcp
```

Other clients (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "hetzner": {
      "command": "npx",
      "args": ["-y", "hetzner-code-mcp"],
      "env": { "HETZNER_API_TOKEN": "your-token" }
    }
  }
}
```

### Several projects

Set one variable per project. The part after `HETZNER_API_TOKEN_` becomes the project name
(lower-cased), which the tools accept as `project`.

```bash
HETZNER_API_TOKEN_PROD=...
HETZNER_API_TOKEN_STAGING=...
HETZNER_DEFAULT_PROJECT=prod   # optional; without it, `project` must be passed
```

`HETZNER_API_TOKEN` (no suffix) is the project `default` and is used when no project is named.

### Dedicated servers (Robot)

Robot has its own credentials: a webservice user, created in
[Robot](https://robot.hetzner.com/) under Settings → Web service and app settings. It is
valid for the whole Robot account and independent of Cloud projects.

```bash
HETZNER_ROBOT_USER='#ws+xxxxxxxx'
HETZNER_ROBOT_PASSWORD='...'
```

Robot has no read-only users: the webservice user can always change, order and cancel.
`hetzner_query` still only lets GET requests through. Robot blocks the calling IP for 10
minutes after three failed logins, so check the credentials before retrying.

### Options

| Variable | Default | Meaning |
| --- | --- | --- |
| `HETZNER_READ_ONLY` | off | `1` removes `hetzner_execute` and blocks every non-GET request |
| `HETZNER_EXECUTE_TIMEOUT_SECONDS` | 120 | Maximum runtime of one code run |
| `HETZNER_REQUEST_TIMEOUT_SECONDS` | 30 | Timeout of a single API call |
| `HETZNER_MAX_REQUESTS_PER_RUN` | 200 | API calls allowed per code run |
| `HETZNER_MAX_OUTPUT_CHARS` | 40000 | Longer results are truncated |

## What the code can use

```js
hetzner.request({ method, path, query, body, api })
hetzner.get(path, query)   hetzner.post(path, body)   hetzner.put(path, body)   hetzner.delete(path)
hetzner.paginate(path, query)        // all pages of a list endpoint
hetzner.waitForAction(response)      // waits for an asynchronous action, throws if it failed
sleep(ms)   console.log(...)

robot.get(path, query)   robot.post(path, body)   robot.put(path, body)   robot.delete(path)
```

`hetzner` talks to the Cloud API of the selected project, `robot` to the Robot webservice.
Robot bodies are passed as plain objects and sent form-encoded; nested values become
`rules[input][0][action]=accept`. Storage Box paths (`/storage_boxes`, `/storage_box_types`)
are sent to `api.hetzner.com`, everything else under `hetzner` to `api.hetzner.cloud`.

Example for `hetzner_query`:

```js
async () => (await hetzner.paginate('/servers'))
  .map(s => ({ name: s.name, status: s.status, type: s.server_type.name, ip: s.public_net.ipv4?.ip }))
```

### Requests are checked before they are sent

Every request is compared with the API reference first: the operation must exist, query
and body fields must be known, required fields present, types and enum values valid. A
mismatch is reported to the model and nothing is sent:

```
POST /servers was not sent, it does not match the API reference:
- body: required field "server_type" is missing
- body: unknown field "server_typ" (did you mean "server_type"?). Allowed: name, location, server_type, ...
- See describe('create_server') in hetzner_search for all inputs.
```

For Robot, which publishes no schemas, the operation and the top-level input names are
checked. `hetzner.request({ ..., validate: false })` skips the check if the reference is wrong.

## Hosted mode (claude.ai connector for a team)

`hetzner-code-mcp --http` runs the server as a remote MCP endpoint (Streamable HTTP):

1. Someone adds the connector in claude.ai (or any OAuth-capable MCP client).
2. The client opens this server's **connect page**. It lists the Cloud projects and Robot
   accounts from your tenant configuration; the person clicks *Verbinden* on each one they
   have access to and stores an API token (Cloud) or a webservice user (Robot). The server
   checks the credentials against Hetzner before storing them.
3. *Fertig – zurück zu Claude* completes the client's OAuth flow.

The tools then take `project` (and `robot_account` when several Robot accounts are
connected). `hetzner_list_accounts` shows the status and hands out a link to connect more
or replace credentials. Credentials are stored AES-GCM encrypted in SQLite; credentials
Hetzner rejects later are marked, and the model hands out the link to replace them.

This server is the OAuth authorization server for the MCP client; Hetzner only sees
API-token requests. The connect pages are in German.

### Tenant configuration

```json
{
  "tenants": [
    { "id": "prod", "name": "Production", "type": "cloud", "writes": false },
    { "id": "staging", "name": "Staging", "type": "cloud", "writes": true },
    { "id": "dedicated", "name": "Dedicated servers", "type": "robot", "writes": false }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Slug the model passes as `project` (cloud) or `robot_account` (robot). |
| `name` | Shown on the connect page and to the model. |
| `type` | `cloud` (default): a Cloud project, connected with an API token. `robot`: a Robot account, connected with a webservice user. |
| `writes` | `true` allows POST/PUT/DELETE for this tenant. Default: only GET requests pass, whatever the stored token could do. |

A Hetzner token does not say which project it belongs to, so the server cannot verify that
a token stored under "Production" really is from that project.

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `HETZNER_MCP_PUBLIC_URL` | — | **Required.** Public https base URL. The connector URL is `<this>/mcp`. |
| `HETZNER_MCP_SECRET` | — | **Required.** ≥ 32 characters; encrypts stored credentials and signs the browser cookie. Changing it invalidates all connections. |
| `HETZNER_MCP_TENANTS_FILE` / `HETZNER_MCP_TENANTS` | — | **Required.** Path to the tenant JSON, or the JSON inline. |
| `HETZNER_MCP_DB_PATH` | `./data/hetzner-mcp.sqlite` | SQLite file. Put it on a persistent volume. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |
| `HETZNER_MCP_CF_ACCESS_TEAM_DOMAIN` / `HETZNER_MCP_CF_ACCESS_AUD` | — | Put the connect pages behind Cloudflare Access: team domain and the Access application's AUD tag. `/connect/*` then requires a valid Access token, checked by the server itself. |
| `HETZNER_MCP_ICON_PATH` | — | Path to an `.svg`, `.png` or `.ico` file, served as favicon and announced as the MCP server icon. |
| `HETZNER_MCP_ACCESS_TOKEN_TTL` | `3600` | Lifetime (s) of access tokens issued to MCP clients. |
| `HETZNER_MCP_REFRESH_TOKEN_TTL` | `7776000` | Lifetime (s) of refresh tokens issued to MCP clients (90 days). |

The options from the table further up (`HETZNER_EXECUTE_TIMEOUT_SECONDS` and so on) apply too.

The `Dockerfile` builds a ready image:

```bash
docker build -t hetzner-mcp .
docker run -p 3000:3000 -v hetzner-mcp-data:/data \
  -v $PWD/tenants.json:/config/tenants.json:ro \
  -e HETZNER_MCP_TENANTS_FILE=/config/tenants.json \
  -e HETZNER_MCP_PUBLIC_URL=https://hetzner-mcp.example.com \
  -e HETZNER_MCP_SECRET="$(openssl rand -base64 48)" \
  hetzner-mcp
```

Run it behind TLS (reverse proxy). Then in claude.ai: *Settings → Connectors → Add custom
connector* with `https://hetzner-mcp.example.com/mcp`.

**Protect the connect pages.** Anyone who can open the connector URL can start the OAuth
flow and store their own credentials; they never see anyone else's. To keep strangers out
altogether, put the path `/connect` behind Cloudflare Access (or a comparable login) and
set the two `HETZNER_MCP_CF_ACCESS_*` variables. Leave `/mcp`, `/token`, `/register`,
`/authorize` and `/.well-known/*` outside: claude.ai calls them from its servers.

## Security

- **The code runs in its own locked-down process.** Each run starts a Node process with the
  [permission model](https://nodejs.org/api/permissions.html): no file system outside this
  package, no child processes, no workers, an empty environment. Inside it, the code runs in
  a V8 context without `require`, `process`, `fetch`, timers or `eval`.
- **Credentials never enter that process.** The code passes request descriptions (method,
  path, query, body) to the server, which adds the credentials and only talks to the three
  Hetzner hosts.
- **Runs are bounded:** a time limit (the process is killed, also when the code loops
  forever), 256 MB of memory, and a cap on API calls per run.
- **Writes need the second tool**, and can be switched off per installation
  (`HETZNER_READ_ONLY`) or per tenant (`writes` in hosted mode).

What it does not do: there is no cost guard and no confirmation step inside the server.
`hetzner_execute` can create billable resources and delete data; the confirmation is the
approval prompt of your MCP client. Use read-only tokens where you only want to look.

## Updating the API reference

`spec/operations.json` is generated from the official OpenAPI specs
(`docs.hetzner.cloud/cloud.spec.json` and `hetzner.spec.json`) and, because Robot has no
OpenAPI spec, from the HTML documentation at `robot.hetzner.com/doc/webservice/en.html`.

```bash
npm run update-spec
```

## Development

```bash
npm install
npm test
```

The tests start the built server (stdio and `--http`) and talk to a local fake of the
Hetzner APIs. No real API is called.

Releases: bump `version` in `package.json` and `SERVER_VERSION` in `src/config.ts`, push a
tag `v<version>`. The workflow publishes to npm via Trusted Publishing.

## License

[MIT](LICENSE)
