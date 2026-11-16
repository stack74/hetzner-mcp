#!/usr/bin/env node
/**
 * MCP server for the Hetzner Cloud and Robot APIs in code mode.
 *
 * Transports:
 *   stdio (default, local) — credentials from the environment. Never log to stdout,
 *     it carries the MCP protocol.
 *   --http (hosted)        — Streamable HTTP + OAuth for remote connectors such as
 *     claude.ai; people connect their own projects and Robot accounts. See src/hosted/.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, SERVER_NAME, SERVER_VERSION } from './config.js';
import { createHetznerServer } from './server.js';

const USAGE = `${SERVER_NAME} v${SERVER_VERSION}

MCP server for the Hetzner Cloud API and the Hetzner Robot API (dedicated servers).
Speaks the Model Context Protocol over stdio; run it from an MCP client, not by hand.

Environment (at least one credential):
  HETZNER_API_TOKEN               API token of a Cloud project (Hetzner Console -> Security -> API Tokens).
  HETZNER_API_TOKEN_<NAME>        One token per project when you have several; <NAME> becomes the project name.
  HETZNER_DEFAULT_PROJECT         Project used when a call names none.
  HETZNER_ROBOT_USER / HETZNER_ROBOT_PASSWORD
                                  Robot webservice user (Robot -> Settings -> Web service and app settings).

Optional:
  HETZNER_READ_ONLY=1             Remove hetzner_execute; only GET requests are possible.
  HETZNER_ALLOW_BILLED=1          Allow requests that cost money (new servers, volumes, IPs, ...). Default: refused.
  HETZNER_SKIP_CONFIRMATION=1     Send billed and destructive requests without asking for approval first.
  HETZNER_APPROVAL_DIALOG=1       Ask for approval in a dialog of the MCP client (elicitation) instead of
                                  the confirmed argument. Only for clients that really show such dialogs.
  HETZNER_EXECUTE_TIMEOUT_SECONDS Maximum runtime of one code run (default 120).
  HETZNER_REQUEST_TIMEOUT_SECONDS Timeout of a single API call (default 30).
  HETZNER_MAX_REQUESTS_PER_RUN    API calls allowed per code run (default 200).
  HETZNER_MAX_OUTPUT_CHARS        Longer results are truncated (default 40000).

Flags:
  --http          Run as a hosted remote server (Streamable HTTP + OAuth) instead of stdio.
                  Requires HETZNER_MCP_PUBLIC_URL, HETZNER_MCP_SECRET and HETZNER_MCP_TENANTS_FILE,
                  see the README section "Hosted mode".
  --help, -h      Show this help.
  --version, -v   Print the version.
`;

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  if (process.argv.includes('--http') || process.env.HETZNER_MCP_TRANSPORT === 'http') {
    // Loaded lazily so stdio installs never touch express or node:sqlite.
    const { startHttpServer } = await import('./hosted/http.js');
    await startHttpServer();
    return;
  }

  const config = loadConfig();
  const server = createHetznerServer(config);
  if (config.projects.size === 0 && config.robots.size === 0) {
    console.error(`${SERVER_NAME}: no HETZNER_API_TOKEN and no Robot user configured; only hetzner_search will work.`);
  }
  await server.connect(new StdioServerTransport());
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} running on stdio (projects: ${[...config.projects.keys()].join(', ') || 'none'}, ` +
      `robot: ${config.robots.size ? 'yes' : 'no'}${config.readOnly ? ', read-only' : ''})`,
  );
}

main().catch((error: unknown) => {
  console.error(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
