/**
 * Hosted mode: Streamable HTTP transport + OAuth, for use as a remote connector
 * (claude.ai "Custom connector", Claude Code `--transport http`, …).
 *
 * Routes:
 *   /.well-known/*, /authorize, /token, /register, /revoke   OAuth (SDK mcpAuthRouter)
 *   /connect/...                                            connect page
 *   POST /mcp                                               MCP endpoint (stateless, bearer auth)
 *   GET  /healthz                                           liveness
 *   GET  /favicon.ico, /favicon.<ext>                        icon (only with HETZNER_MCP_ICON_PATH)
 */

import { readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Icon } from "@modelcontextprotocol/sdk/types.js";
import { type CloudProject, type Config, type RobotAccount, SERVER_NAME, SERVER_VERSION } from "../config.js";
import { createHetznerServer } from "../server.js";
import { accountInstructions, registerAccountTools } from "./accounts.js";
import { type HostedConfig, loadHostedConfig, type TenantConfig } from "./config.js";
import { renderConnectPage, renderKeyForm, renderMessage, setPageIcon } from "./pages.js";
import { GrantCookie, HostedOAuthProvider, SESSION_TTL_SECONDS } from "./provider.js";
import { type ConnectionSecret, type SessionRow, Store } from "./store.js";

/** Banner texts on the connect page, addressed by code so a crafted link cannot inject text. */
const MESSAGES: Record<string, (tenant?: TenantConfig) => string> = {
  connected: (t) => `„${t?.name ?? "Eintrag"}“ ist verbunden.`,
  disconnected: (t) => `„${t?.name ?? "Eintrag"}“ wurde getrennt.`,
  none_connected: () => "Verbinde mindestens ein Projekt oder einen Robot-Account, bevor du fortfährst.",
};

/**
 * Checks credentials against Hetzner with one cheap read. Returns the HTTP status;
 * 200 (and for Robot 404 "no server found") means the credentials are valid.
 */
async function checkCredentials(config: HostedConfig, tenant: TenantConfig, secret: ConnectionSecret): Promise<number> {
  const headers = { Accept: "application/json", "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}` };
  const signal = AbortSignal.timeout(Math.min(config.limits.requestTimeoutMs, 15_000));
  if ("token" in secret) {
    const response = await fetch(`${config.limits.baseUrls.cloud}/locations?per_page=1`, {
      headers: { ...headers, Authorization: `Bearer ${secret.token}` },
      signal,
    });
    return response.status;
  }
  const response = await fetch(`${config.limits.baseUrls.robot}/server`, {
    headers: { ...headers, Authorization: `Basic ${Buffer.from(`${secret.user}:${secret.password}`).toString("base64")}` },
    signal,
  });
  return response.status === 404 ? 200 : response.status;
}

export interface HostedApp {
  app: express.Express;
  store: Store;
  config: HostedConfig;
}

/** Builds the app without listening — used by start() and by tests. */
export async function createHostedApp(config: HostedConfig): Promise<HostedApp> {
  const store = new Store(config.dbPath, config.secret);
  const cookie = new GrantCookie(config.secret, config.publicUrl.protocol === "https:");
  const provider = new HostedOAuthProvider(config, store, cookie);
  const tenants = config.tenants;
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  const app = express();
  app.disable("x-powered-by");
  // Behind a reverse proxy: needed for the SDK's rate limiting.
  app.set("trust proxy", 1);

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, version: SERVER_VERSION });
  });

  // Optional icon from outside the image. claude.ai shows the domain's favicon
  // next to a custom connector; MCP clients read the server info icon.
  let icons: Icon[] | undefined;
  if (config.icon) {
    const { path: iconPath, mimeType, extension } = config.icon;
    let body: Buffer;
    try {
      body = readFileSync(iconPath);
    } catch (error) {
      throw new Error(
        `Hosted mode configuration: cannot read HETZNER_MCP_ICON_PATH ${JSON.stringify(iconPath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const iconRoute = `/favicon.${extension}`;
    const sendIcon = (_req: Request, res: Response): void => {
      res.set("Cache-Control", "public, max-age=86400").type(mimeType).send(body);
    };
    app.get(iconRoute, sendIcon);
    if (iconRoute !== "/favicon.ico") app.get("/favicon.ico", sendIcon);
    setPageIcon(iconRoute, mimeType);
    icons = [{ src: new URL(iconRoute, config.publicUrl).href, mimeType, ...(extension === "svg" ? { sizes: ["any"] } : {}) }];
  }

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: config.mcpUrl,
      resourceName: "Hetzner",
    }),
  );

  // --- Cloudflare Access in front of the connect pages ----------------------
  //
  // The connect pages are opened by people in a browser, so they can sit behind
  // a Zero Trust policy. /mcp, /token, /register and /.well-known stay open:
  // claude.ai calls them from its servers. Checking the Access token here (not
  // only at Cloudflare's edge) keeps the policy effective when the origin is
  // reachable directly, e.g. by IP.

  const access = config.cloudflareAccess;
  const accessKeys = access ? createRemoteJWKSet(new URL(`${access.issuer}/cdn-cgi/access/certs`)) : undefined;

  const readAccessToken = (req: Request): string | undefined => {
    const header = req.headers["cf-access-jwt-assertion"];
    if (typeof header === "string" && header) return header;
    const found = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.cookie ?? "");
    return found?.[1];
  };

  app.use("/connect", async (req: Request, res: Response, next: NextFunction) => {
    if (!access || !accessKeys) return next();
    const token = readAccessToken(req);
    try {
      if (!token) throw new Error("no Cloudflare Access token");
      const { payload } = await jwtVerify(token, accessKeys, { issuer: access.issuer, audience: access.audience });
      res.locals.viewer = typeof payload.email === "string" ? payload.email : String(payload.sub ?? "");
      next();
    } catch (error) {
      console.error(`Connect page refused (Cloudflare Access): ${error instanceof Error ? error.message : String(error)}`);
      res.setHeader("Cache-Control", "no-store");
      res
        .status(403)
        .type("html")
        .send(renderMessage("Kein Zugriff", "Diese Seite ist nur über die Anmeldung des Unternehmens (Cloudflare Access) erreichbar."));
    }
  });

  const viewerOf = (res: Response): string | undefined =>
    typeof res.locals.viewer === "string" && res.locals.viewer ? res.locals.viewer : undefined;

  // --- connect page --------------------------------------------------------

  const pageHeaders = (res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    );
  };

  const expired = (res: Response): void => {
    pageHeaders(res);
    res
      .status(400)
      .type("html")
      .send(
        renderMessage(
          "Link abgelaufen",
          "Diese Seite ist nicht mehr gültig. Starte die Verbindung in Claude erneut oder lass dir von Claude einen neuen Link geben (hetzner_list_accounts).",
        ),
      );
  };

  const loadSession = (req: Request, res: Response): SessionRow | undefined => {
    const session = store.getSession(String(req.params.sid));
    if (!session) expired(res);
    return session;
  };

  const backToPage = (res: Response, session: SessionRow, kind: "e" | "n", code: string, tenantId?: string): void => {
    const params = new URLSearchParams({ [kind]: code, ...(tenantId ? { t: tenantId } : {}) });
    res.redirect(303, `/connect/${encodeURIComponent(session.id)}?${params}`);
  };

  app.get("/connect/:sid", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = typeof req.query.t === "string" ? tenantById.get(req.query.t) : undefined;
    const message = (key: unknown): string | undefined => (typeof key === "string" && MESSAGES[key] ? MESSAGES[key](tenant) : undefined);
    const error = message(req.query.e);
    const notice = message(req.query.n);
    const viewer = viewerOf(res);
    pageHeaders(res);
    res.type("html").send(
      renderConnectPage({
        ...(viewer ? { viewer } : {}),
        session,
        tenants,
        connections: store.listConnections(session.grant_id),
        ...(error ? { error } : {}),
        ...(notice ? { notice } : {}),
      }),
    );
  });

  app.get("/connect/:sid/tenants/:tid/key", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = tenantById.get(String(req.params.tid));
    if (!tenant) return expired(res);
    pageHeaders(res);
    res.type("html").send(renderKeyForm(session, tenant));
  });

  app.post("/connect/:sid/tenants/:tid/key", express.urlencoded({ extended: false, limit: "4kb" }), async (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenant = tenantById.get(String(req.params.tid));
    if (!tenant) return expired(res);
    const fail = (message: string): void => {
      pageHeaders(res);
      res.status(400).type("html").send(renderKeyForm(session, tenant, message));
    };
    const field = (name: string): string => (typeof req.body?.[name] === "string" ? (req.body[name] as string).trim() : "");

    let secret: ConnectionSecret;
    let label: string;
    if (tenant.type === "robot") {
      const user = field("robot_user");
      const password = typeof req.body?.robot_password === "string" ? (req.body.robot_password as string) : "";
      if (!user || !password || user.length > 128 || password.length > 512 || /\s/.test(user)) {
        return fail("Bitte gib Webservice-Benutzer und Passwort vollständig ein.");
      }
      secret = { user, password };
      label = user;
    } else {
      const token = field("api_token");
      if (!token || token.length > 512 || /\s/.test(token)) return fail("Bitte füge den API-Token vollständig und ohne Leerzeichen ein.");
      secret = { token };
      label = `Token …${token.slice(-4)}`;
    }

    let status: number;
    try {
      status = await checkCredentials(config, tenant, secret);
    } catch (error) {
      console.error(`Credential check for tenant ${tenant.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return fail("Hetzner ist gerade nicht erreichbar. Versuch es gleich noch einmal.");
    }
    if (status === 401) {
      return fail(
        tenant.type === "robot"
          ? "Hetzner Robot hat diese Zugangsdaten nicht akzeptiert. Prüfe Benutzer und Passwort, bevor du es erneut versuchst (Sperre nach drei Fehlversuchen)."
          : `Hetzner hat diesen API-Token nicht akzeptiert. Prüfe, ob er vollständig kopiert ist und aus „${tenant.name}“ stammt.`,
      );
    }
    if (status === 403 || status === 429) return fail("Hetzner drosselt oder sperrt gerade die Anfragen. Versuch es in ein paar Minuten noch einmal.");
    if (status !== 200) return fail(`Hetzner hat mit HTTP ${status} geantwortet. Versuch es gleich noch einmal.`);

    const viewer = viewerOf(res);
    console.error(`Tenant ${tenant.id}: credentials stored${viewer ? ` by ${viewer}` : ""}`);
    store.saveConnection({
      grant_id: session.grant_id,
      tenant_id: tenant.id,
      secret,
      label,
      connected_by: viewer ?? null,
      connected_at: Math.floor(Date.now() / 1000),
    });
    backToPage(res, session, "n", "connected", tenant.id);
  });

  app.post("/connect/:sid/tenants/:tid/disconnect", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    const tenantId = String(req.params.tid);
    store.deleteConnection(session.grant_id, tenantId);
    backToPage(res, session, "n", "disconnected", tenantId);
  });

  app.post("/connect/:sid/finish", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.kind === "manage") {
      store.deleteSession(session.id);
      pageHeaders(res);
      res.type("html").send(renderMessage("Fertig", "Du kannst dieses Fenster schließen und in Claude weitermachen."));
      return;
    }
    const usable = store.listConnections(session.grant_id).filter((c) => !c.broken_reason && tenantById.has(c.tenant_id));
    if (usable.length === 0) return backToPage(res, session, "e", "none_connected");
    cookie.write(res, session.grant_id);
    res.redirect(303, provider.completeAuthorization(session));
  });

  app.post("/connect/:sid/cancel", (req, res) => {
    const session = loadSession(req, res);
    if (!session) return;
    if (session.kind !== "authorize") return expired(res);
    res.redirect(303, provider.denyAuthorization(session));
  });

  // --- MCP endpoint ---------------------------------------------------------

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl),
  });

  app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
    const grantId = String(req.auth?.extra?.grantId ?? "");
    const connections = store.listConnections(grantId).filter((c) => tenantById.has(c.tenant_id));

    // The person's connected tenants become the projects and Robot accounts of this request.
    const projects = new Map<string, CloudProject>();
    const robots = new Map<string, RobotAccount>();
    for (const connection of connections) {
      if (connection.broken_reason) continue;
      const tenant = tenantById.get(connection.tenant_id)!;
      if (tenant.type === "cloud" && "token" in connection.secret) {
        projects.set(tenant.id, { token: connection.secret.token, writes: tenant.writes, billed: tenant.billed, label: tenant.name });
      } else if (tenant.type === "robot" && "user" in connection.secret) {
        robots.set(tenant.id, { ...connection.secret, writes: tenant.writes, billed: tenant.billed, label: tenant.name });
      }
    }
    const requestConfig: Config = {
      ...config.limits,
      projects,
      defaultProject: projects.size === 1 ? [...projects.keys()][0] : undefined,
      robots,
      defaultRobot: robots.size === 1 ? [...robots.keys()][0] : undefined,
      readOnly: false,
    };
    const connectHint = "Call hetzner_list_accounts and give the user the link to connect one.";

    const server = createHetznerServer(requestConfig, {
      ...(icons ? { icons } : {}),
      missingProject: `No Hetzner Cloud project is connected for this user. ${connectHint}`,
      missingRobot: `No Hetzner Robot account is connected for this user. ${connectHint}`,
      billedHint: 'The operator of this server enables them per tenant with "billed": true in the tenant configuration.',
      onRejected: (_kind, name) => {
        console.error(`Tenant ${name}: Hetzner rejected the stored credentials`);
        store.markConnectionBroken(grantId, name, "rejected");
      },
      extraInstructions: accountInstructions(tenants, connections),
      extraTools: (s) =>
        registerAccountTools(s, {
          tenants,
          connections,
          manageLink: () => {
            const sid = store.createSession(
              { kind: "manage", grant_id: grantId, client_id: null, redirect_uri: null, code_challenge: null, state: null, resource: null },
              SESSION_TTL_SECONDS,
            );
            return `${config.publicUrl.href.replace(/\/+$/, "")}/connect/${sid}`;
          },
        }),
    });

    // Stateless: a fresh server + transport per request, closed with the response.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(`MCP request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.get("/", (_req, res) => {
    res.type("html").send(renderMessage("Hetzner MCP", `Dieser Server stellt Hetzner als MCP-Connector bereit. Connector-URL: ${config.mcpUrl.href}`));
  });

  return { app, store, config };
}

/** Entry point for `hetzner-mcp --http`. */
export async function startHttpServer(): Promise<void> {
  const config = loadHostedConfig();
  const { app, store } = await createHostedApp(config);

  const purge = setInterval(() => store.purgeExpired(), 10 * 60 * 1000);
  purge.unref();

  const server = app.listen(config.port, config.host, (error?: Error) => {
    // Express 5 reports listen failures (e.g. EADDRINUSE) here, not as a throw.
    if (error) {
      console.error(`Cannot listen on ${config.host}:${config.port}: ${error.message}`);
      process.exit(1);
    }
    console.error(
      `${SERVER_NAME} v${SERVER_VERSION} listening on ${config.host}:${config.port} | MCP endpoint ${config.mcpUrl.href}` +
        `${config.cloudflareAccess ? ` | /connect behind Cloudflare Access (${config.cloudflareAccess.issuer})` : ""}` +
        ` | ${config.tenants.length} tenant(s): ` +
        config.tenants.map((t) => `${t.id} (${t.type}, ${t.writes ? (t.billed ? "rw+billed" : "rw") : "ro"})`).join(", "),
    );
  });

  const shutdown = (): void => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
