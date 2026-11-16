/**
 * Builds the MCP server with its three code-mode tools. Used by the stdio entry point
 * (one process, credentials from the environment) and by hosted mode (one server per
 * request, credentials of the person calling).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Icon } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { performRequest, ApiError, type Credentials, type Guard, type RequestOptions } from './client.js';
import { resolveProject, resolveRobot, SERVER_NAME, SERVER_VERSION, type Config } from './config.js';
import { classify, describePrice, describeTarget, type Pricing } from './guard.js';
import { runSandbox, SPEC_PATH, type SandboxControl, type SandboxResult } from './sandbox.js';
import { createReference, type Reference } from './validate.js';

export interface ServerOptions {
  /** Appended to the server instructions (hosted mode: who is connected, where to connect). */
  extraInstructions?: string;
  extraTools?: (server: McpServer) => void;
  icons?: Icon[];
  /** Error text when a call needs a project / Robot account and none is available. */
  missingProject?: string;
  missingRobot?: string;
  /** The API rejected stored credentials (HTTP 401). */
  onRejected?: (kind: 'cloud' | 'robot', name: string) => void;
  /** How an operator switches billed requests on, for the error message. */
  billedHint?: string;
}

let sharedReference: Reference | undefined;
const reference = (): Reference => (sharedReference ??= createReference(SPEC_PATH));

function toToolResult(run: SandboxResult, limit: number) {
  let text = run.result;
  if (run.logs) text += `\n\n--- console ---\n${run.logs}`;
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n\n[Output truncated: ${text.length} characters, limit ${limit}. Return fewer fields or filter inside the code.]`;
  }
  return { content: [{ type: 'text' as const, text }], isError: !run.ok };
}

const describeEntries = (entries: Map<string, { writes: boolean; label?: string }>): string =>
  [...entries].map(([name, e]) => `${name}${e.label && e.label !== name ? ` = ${e.label}` : ''}${e.writes ? '' : ' (read-only)'}`).join(', ');

export function createHetznerServer(config: Config, options: ServerOptions = {}): McpServer {
  const projectNames = [...config.projects.keys()];
  const robotNames = [...config.robots.keys()];
  const hasRobot = robotNames.length > 0;
  const canWrite = !config.readOnly && [...config.projects.values(), ...config.robots.values()].some((e) => e.writes);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, ...(options.icons ? { icons: options.icons } : {}) },
    {
      instructions: [
        [
          'Hetzner Cloud API (servers, volumes, networks, firewalls, load balancers, IPs, images, DNS zones, Storage Boxes) and Hetzner Robot API (dedicated servers and their firewall, reset, rescue, rDNS, vSwitch) in code mode.',
          'Cloud resources are reached through the `hetzner` object, dedicated servers through the `robot` object; a server missing in one may live in the other.',
          'Workflow: 1) hetzner_search to find the operation and its parameters, 2) hetzner_query for reads (GET only),',
          canWrite ? '3) hetzner_execute only for changes.' : 'This server is read-only: changes are not possible.',
          'Do the filtering and aggregation inside the code and return only what is needed, list responses are large.',
          projectNames.length > 1
            ? `Each API token belongs to one Hetzner project. Projects: ${describeEntries(config.projects)}${config.defaultProject ? ` (default: ${config.defaultProject})` : ''}. IDs belong to one project; never reuse an ID from one project in another.`
            : '',
          robotNames.length > 1 ? `Robot accounts: ${describeEntries(config.robots)}.` : '',
        ]
          .filter(Boolean)
          .join(' '),
        options.extraInstructions ?? '',
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
  );

  const projectSchema = z
    .string()
    .optional()
    .describe(
      projectNames.length > 1
        ? `Hetzner Cloud project to use. One of: ${projectNames.join(', ')}.${config.defaultProject ? ` Default: ${config.defaultProject}.` : ' Required when the code uses `hetzner`.'}`
        : 'Hetzner Cloud project to use. Only needed when several projects are available.',
    );
  const robotSchema = z
    .string()
    .optional()
    .describe(`Robot account to use for \`robot\`. One of: ${robotNames.join(', ')}.${config.defaultRobot ? ` Default: ${config.defaultRobot}.` : ' Required when the code uses `robot`.'}`);

  const API_REFERENCE = `Globals available in the code:
  hetzner.request({ method = 'GET', path, query?, body?, api? })  -> parsed JSON body (null if empty)
  hetzner.get(path, query?) / hetzner.post(path, body?) / hetzner.put(path, body?) / hetzner.delete(path)
  hetzner.paginate(path, query?, { maxPages = 50 }?)  -> all items of a list endpoint across pages
  hetzner.waitForAction(actionOrResponse, { timeoutMs = 90000 }?)  -> finished action, throws if it failed
  sleep(ms), console.log(...)
  robot.get(path, query?) / robot.post(path, body?) / robot.put(path, body?) / robot.delete(path) / robot.request({...})
Paths are relative to the API root, e.g. "/servers/123" (no host, no /v1). Storage Box paths are routed
to api.hetzner.com automatically. Array query values become repeated keys. Failed calls throw an Error
with .status, .code and .details. No fetch, require or other network access exists.
Every request is checked against the API reference before it is sent (operation exists, known query and
body fields, required fields, types, enum values); a mismatch throws with code "validation_failed" and
nothing is sent. Only if the reference itself is wrong: hetzner.request({ ..., validate: false }).
\`hetzner\` is the Cloud API of the selected project. \`robot\` is the Robot webservice for dedicated servers
(${hasRobot ? 'available' : 'NOT available: no Robot webservice user is configured'}); it is account-wide and ignores \`project\`. Robot paths
are singular ("/server", "/firewall/{server-number}"), have no pagination and no actions, and are rate
limited per endpoint (see "Request limit" in describe()). Pass Robot bodies as plain objects; they are
sent form-encoded, nested values become rules[input][0][action]=accept.`;

  const registerApiTool = (tool: { name: string; title: string; description: string; allowWrites: boolean }): void => {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: {
          code: z.string().min(1).describe('JavaScript: an async arrow function whose return value is the result. Return only the fields you need.'),
          project: projectSchema,
          ...(robotNames.length > 1 ? { robot_account: robotSchema } : {}),
          ...(tool.allowWrites && config.confirm
            ? {
                confirmed: z
                  .boolean()
                  .optional()
                  .describe(
                    'Set true only after the user approved the billed or destructive requests of exactly this code. Without it such requests are not sent; the result says what they would do and cost.',
                  ),
              }
            : {}),
        },
        annotations: {
          readOnlyHint: !tool.allowWrites,
          destructiveHint: tool.allowWrites,
          idempotentHint: !tool.allowWrites,
          openWorldHint: true,
        },
      },
      async (args) => {
        const { code, project } = args;
        const robotAccount = (args as { robot_account?: string }).robot_account;
        const confirmed = (args as { confirmed?: boolean }).confirmed === true;
        const fail = (message: string) => ({ content: [{ type: 'text' as const, text: message }], isError: true });

        // An explicitly named project or account must exist. Without a name the run may
        // still use only the other side, so the error is kept until a call needs it.
        const credentials: Credentials = { cloud: { writes: false, billed: false }, robot: { writes: false, billed: false } };
        try {
          const p = resolveProject(config, project, options.missingProject);
          const name = (project?.trim().toLowerCase() || config.defaultProject)!;
          credentials.cloud = { value: { token: p.token }, writes: p.writes, billed: p.billed, onRejected: () => options.onRejected?.('cloud', name) };
        } catch (error) {
          if (project) return fail((error as Error).message);
          credentials.cloud.error = (error as Error).message;
        }
        try {
          const r = resolveRobot(config, robotAccount, options.missingRobot);
          const name = (robotAccount?.trim().toLowerCase() || config.defaultRobot)!;
          credentials.robot = { value: { user: r.user, password: r.password }, writes: r.writes, billed: r.billed, onRejected: () => options.onRejected?.('robot', name) };
        } catch (error) {
          if (robotAccount) return fail((error as Error).message);
          credentials.robot.error = (error as Error).message;
        }
        if (!credentials.cloud.value && !credentials.robot.value) return fail(credentials.cloud.error!);

        // Reads the guard needs for its previews; never guarded themselves.
        const read = async (api: string, path: string): Promise<unknown> =>
          JSON.parse(await performRequest(config, credentials, { path, api, validate: false }, false));
        let pricing: Promise<Pricing | undefined> | undefined;
        let approvedAll = false;

        const guardFor = (control: SandboxControl): Guard => async (write) => {
          const hit = classify(write.api, write.method, write.operation);
          if (!hit) return;
          const label = `${write.method} ${write.path}`;
          if (hit.kind === 'billed' && !write.access.billed) {
            throw new ApiError({
              message: `${label} was NOT sent: it ${hit.effect}, and billed requests are switched off for this ${write.api === 'robot' ? 'Robot account' : 'project'}. ${options.billedHint ?? 'The operator enables them with HETZNER_ALLOW_BILLED=1 in the MCP server environment.'} Tell the user; do not look for another way to create the resource.`,
              code: 'billing_disabled',
            });
          }
          if (!config.confirm || approvedAll) return;

          const canAsk = Boolean(server.server.getClientCapabilities()?.elicitation);
          if (confirmed && !canAsk) return;

          // What exactly is affected, and what it costs.
          const details: string[] = [];
          if (hit.kind === 'billed' && write.api !== 'robot' && write.operation) {
            pricing ??= read('cloud', '/pricing').then(
              (json) => (json as { pricing?: Pricing }).pricing,
              () => undefined,
            );
            const price = describePrice(write.operation.operationId, write.body, (await pricing) ?? {});
            details.push(price ? `Price: ${price}.` : 'The price could not be determined; see GET /pricing.');
          }
          if (write.method === 'DELETE' && write.api !== 'robot') {
            const target = await read(write.api, write.path).then(describeTarget, () => undefined);
            if (target) details.push(`Affected: ${target}.`);
          }
          const summary = `${label} ${hit.effect}.${details.length ? ` ${details.join(' ')}` : ''}`;

          if (canAsk) {
            let decision: unknown;
            try {
              const answer = await control.suspend(() =>
                server.server.elicitInput(
                  {
                    message: `Hetzner: ${summary}`,
                    requestedSchema: {
                      type: 'object',
                      properties: {
                        decision: {
                          type: 'string',
                          title: 'Send this request?',
                          enum: ['approve', 'approve_all', 'decline'],
                          enumNames: ['Approve', 'Approve this and all further requests of this run', 'Decline'],
                        },
                      },
                      required: ['decision'],
                    },
                  },
                  { timeout: 10 * 60 * 1000 },
                ),
              );
              decision = answer.action === 'accept' ? answer.content?.decision : 'decline';
            } catch (error) {
              throw new ApiError({ message: `${label} was NOT sent: the approval dialog failed (${error instanceof Error ? error.message : String(error)}).`, code: 'confirmation_failed' });
            }
            if (decision === 'approve_all') approvedAll = true;
            if (decision === 'approve' || decision === 'approve_all') return;
            throw new ApiError({ message: `${label} was NOT sent: the user declined it. Do not retry it without asking.`, code: 'declined' });
          }

          throw new ApiError({
            message: `${label} was NOT sent, it needs the user's approval first. This request ${hit.effect}.${details.length ? ` ${details.join(' ')}` : ''}\nTell the user exactly this. Only after they agree, run the same code again with the tool argument confirmed: true.`,
            code: 'confirmation_required',
          });
        };

        let requestCount = 0;
        const run = await runSandbox({
          mode: 'api',
          code,
          timeoutMs: config.executeTimeoutMs,
          onRequest: async (payload, control) => {
            if (++requestCount > config.maxRequestsPerRun) {
              throw new ApiError({ message: `Request limit of ${config.maxRequestsPerRun} API calls per run reached.`, code: 'request_limit' });
            }
            return performRequest(config, credentials, JSON.parse(payload) as RequestOptions, tool.allowWrites, reference(), tool.allowWrites ? guardFor(control) : undefined);
          },
        });
        return toToolResult(run, config.maxOutputChars);
      },
    );
  };

  server.registerTool(
    'hetzner_search',
    {
      title: 'Search the Hetzner API reference',
      description: `Explore the Hetzner API reference (Cloud API incl. DNS zones, Storage Box API, and the Robot API for dedicated servers) by running JavaScript against it. Makes no API calls and needs no token. Use it before hetzner_query / hetzner_execute to find the right path, parameters and request body.

Globals available in the code:
  search(text)      -> [{ operationId, method, path, summary, api }] where every word matches id, path, summary or tag.
                       api is "cloud" | "hetzner" (both called via \`hetzner\`) or "robot" (called via \`robot\`)
  describe(ref)     -> one operation, condensed: description, parameters, requestBody, response ("name*" = required).
                       ref is an operationId or "METHOD /path". Robot operations have no JSON schema; their
                       description lists Input, Output, Errors and the request limit, plus curl/JSON examples
  operations        -> all operations with full JSON schemas: { api, operationId, method, path, summary, description,
                       tags, deprecated, parameters, requestBody, response }
  apis              -> { cloud, hetzner, robot }, each { baseUrl, overview, tags: [{ name, description }] }. overview is the
                       general documentation in Markdown (pagination, label selectors, sorting, rate limits, errors)

Examples:
  async () => search('firewall')
  async () => describe('create_server')
  async () => describe('POST /servers/{id}/actions/rebuild')
  async () => search('robot firewall')
  async () => describe('robot_post_firewall_server_id')
  async () => operations.filter(o => o.tags.includes('Zone RRSets')).map(o => o.method + ' ' + o.path)
  async () => apis.cloud.overview.split('\\n## ').find(s => s.startsWith('Label Selector'))`,
      inputSchema: {
        code: z.string().min(1).describe('JavaScript: an async arrow function whose return value is the result.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ code }) => toToolResult(await runSandbox({ mode: 'search', code, timeoutMs: 15_000 }), config.maxOutputChars),
  );

  registerApiTool({
    name: 'hetzner_query',
    title: 'Read from the Hetzner API',
    allowWrites: false,
    description: `Run JavaScript that reads from the Hetzner API. Only GET requests are possible, so nothing can be changed. Chain several calls and filter the data in the code instead of returning whole responses.

${API_REFERENCE}

Examples:
  async () => (await hetzner.paginate('/servers')).map(s => ({ id: s.id, name: s.name, status: s.status, type: s.server_type.name, ip: s.public_net.ipv4?.ip, location: s.datacenter?.location?.name }))
  async () => (await hetzner.get('/servers', { label_selector: 'env=prod', status: ['running'] })).servers.length
  async () => (await robot.get('/server')).map(({ server: s }) => ({ number: s.server_number, name: s.server_name, ip: s.server_ip, product: s.product, dc: s.dc }))
  async () => (await robot.get('/firewall/321')).firewall
  async () => {
    const [servers, volumes] = await Promise.all([hetzner.paginate('/servers'), hetzner.paginate('/volumes')]);
    return volumes.filter(v => !v.server).map(v => ({ id: v.id, name: v.name, size: v.size }));
  }`,
  });

  if (canWrite) {
    registerApiTool({
      name: 'hetzner_execute',
      title: 'Change resources through the Hetzner API',
      allowWrites: true,
      description: `Run JavaScript that changes Hetzner resources (POST, PUT, DELETE as well as GET). Changes are real and immediate: they can create billable resources, cause downtime or delete data permanently. Through \`robot\` this includes ordering and cancelling dedicated servers, hardware resets, and firewall rules that can lock everyone out of a server (POST /firewall/{server-number} replaces the whole rule set: read it first and send all rules back, except output rules named "Block mail ports", which Hetzner prepends itself and would duplicate; the update is asynchronous, poll until status is no longer "in process"). Look the operation up with hetzner_search first, use hetzner_query for pure reads, and act only on resources the user named.

Guard: requests that cost money (creating servers, volumes, load balancers, IPs, snapshots, Storage Boxes, type changes, backups, Robot orders) are refused unless the operator switched billed requests on. Billed requests and destructive ones (every DELETE, rebuilding a server, replacing a firewall rule set or a DNS zone, Robot cancellations and OS installations) are not sent on the first attempt: the result states what they do and the price. Report that to the user and wait for their answer.

${API_REFERENCE}

Most Cloud changes return an "action" that runs asynchronously; await hetzner.waitForAction(response) before relying on the result.

Examples:
  async () => {
    const res = await hetzner.post('/servers/123/actions/reboot');
    return await hetzner.waitForAction(res);
  }
  async () => {
    const res = await hetzner.post('/servers', { name: 'web-1', server_type: 'cx23', image: 'ubuntu-24.04', location: 'nbg1', ssh_keys: ['my-key'] });
    await hetzner.waitForAction(res);
    return { id: res.server.id, ip: res.server.public_net.ipv4.ip };
  }`,
    });
  }

  options.extraTools?.(server);
  return server;
}
