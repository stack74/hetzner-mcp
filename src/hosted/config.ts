/**
 * Configuration for hosted (HTTP + OAuth) mode.
 *
 * Hosted mode serves one MCP endpoint for a whole team. The tenant file lists the
 * Hetzner Cloud projects and Robot accounts; each person connects the ones they have
 * access to by storing an API token (Cloud) or a webservice user (Robot).
 */

import { readFileSync } from "node:fs";
import { loadLimits, type Limits } from "../config.js";

export interface TenantConfig {
  /** Slug the model passes as `project` (cloud) or `robot_account` (robot). */
  id: string;
  /** Shown on the connect page and to the model. */
  name: string;
  /** "cloud": a Hetzner Cloud project (API token). "robot": a Robot account (webservice user). */
  type: "cloud" | "robot";
  /** Allow POST/PUT/DELETE against this tenant. Default: read-only. */
  writes: boolean;
}

export interface HostedConfig {
  /** Public base URL, e.g. https://hetzner-mcp.example.com. The MCP endpoint is <publicUrl>/mcp. */
  publicUrl: URL;
  mcpUrl: URL;
  host: string;
  port: number;
  /** Encrypts stored credentials and signs the browser cookie. */
  secret: string;
  dbPath: string;
  tenants: TenantConfig[];
  /**
   * Cloudflare Access in front of the connect pages: when set, /connect/* only
   * answers requests carrying a valid Access token for this application.
   */
  cloudflareAccess?: { issuer: string; audience: string };
  /** Icon served as favicon and announced in the MCP server info. */
  icon?: { path: string; mimeType: string; extension: "svg" | "png" | "ico" };
  /** Lifetime of the access tokens this server issues to MCP clients. */
  accessTokenTtlSeconds: number;
  /** Lifetime of the refresh tokens this server issues to MCP clients. */
  refreshTokenTtlSeconds: number;
  limits: Limits;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function fail(message: string): never {
  throw new Error(`Hosted mode configuration: ${message}`);
}

function parseTenants(raw: string, source: string): TenantConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${source} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tenants?: unknown } | null)?.tenants;
  if (!Array.isArray(list) || list.length === 0) fail(`${source} must contain a non-empty "tenants" array`);

  const seen = new Set<string>();
  return list.map((entry: unknown, index): TenantConfig => {
    const t = (entry ?? {}) as Record<string, unknown>;
    const where = `${source} tenants[${index}]`;
    // Case-insensitive: "PROD" becomes "prod", the value the model passes as `project`.
    const id = typeof t.id === "string" ? t.id.trim().toLowerCase() : "";
    if (!SLUG.test(id)) fail(`${where}.id must be a slug (letters, digits, - and _), got ${JSON.stringify(t.id)}`);
    if (seen.has(id)) fail(`${where}.id "${id}" is used twice`);
    seen.add(id);
    const type = t.type === undefined ? "cloud" : t.type;
    if (type !== "cloud" && type !== "robot") fail(`${where}.type must be "cloud" or "robot", got ${JSON.stringify(t.type)}`);
    return {
      id,
      name: typeof t.name === "string" && t.name.trim() ? t.name.trim() : id,
      type,
      writes: t.writes === true,
    };
  });
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < 1) fail(`${name} must be a positive integer`);
  return value;
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  const rawUrl = env.HETZNER_MCP_PUBLIC_URL?.trim();
  if (!rawUrl) fail("HETZNER_MCP_PUBLIC_URL is required, e.g. https://hetzner-mcp.example.com");
  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl.replace(/\/+$/, ""));
  } catch {
    fail(`HETZNER_MCP_PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const localhost = ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  // Same escape hatch the MCP SDK uses for its issuer check, for LAN tests only:
  // API tokens then travel unencrypted.
  const insecureAllowed = /^(1|true)$/.test(env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL ?? "");
  if (publicUrl.protocol !== "https:" && !localhost && !insecureAllowed) {
    fail(
      "HETZNER_MCP_PUBLIC_URL must use https (http is only allowed for localhost; for a test in a " +
        "trusted local network set MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=true)",
    );
  }

  const secret = env.HETZNER_MCP_SECRET ?? "";
  if (secret.length < 32) fail("HETZNER_MCP_SECRET must be at least 32 characters (e.g. `openssl rand -base64 48`)");

  let tenants: TenantConfig[];
  if (env.HETZNER_MCP_TENANTS?.trim()) {
    tenants = parseTenants(env.HETZNER_MCP_TENANTS, "HETZNER_MCP_TENANTS");
  } else if (env.HETZNER_MCP_TENANTS_FILE?.trim()) {
    const file = env.HETZNER_MCP_TENANTS_FILE.trim();
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      fail(`cannot read HETZNER_MCP_TENANTS_FILE ${file} (${error instanceof Error ? error.message : String(error)})`);
    }
    tenants = parseTenants(raw, file);
  } else {
    fail("set HETZNER_MCP_TENANTS_FILE (path to a JSON file) or HETZNER_MCP_TENANTS (inline JSON)");
  }

  const teamDomain = env.HETZNER_MCP_CF_ACCESS_TEAM_DOMAIN?.trim();
  const accessAud = env.HETZNER_MCP_CF_ACCESS_AUD?.trim();
  if (Boolean(teamDomain) !== Boolean(accessAud)) {
    fail("set both HETZNER_MCP_CF_ACCESS_TEAM_DOMAIN and HETZNER_MCP_CF_ACCESS_AUD, or neither");
  }
  let cloudflareAccess: HostedConfig["cloudflareAccess"];
  if (teamDomain && accessAud) {
    // Accepts "team", "team.cloudflareaccess.com" or a full URL.
    const issuer = teamDomain.includes("://")
      ? teamDomain
      : `https://${teamDomain.includes(".") ? teamDomain : `${teamDomain}.cloudflareaccess.com`}`;
    cloudflareAccess = { issuer: issuer.replace(/\/+$/, ""), audience: accessAud };
  }

  let icon: HostedConfig["icon"];
  const iconPath = env.HETZNER_MCP_ICON_PATH?.trim();
  if (iconPath) {
    const extension = /\.(svg|png|ico)$/i.exec(iconPath)?.[1]?.toLowerCase() as "svg" | "png" | "ico" | undefined;
    if (!extension) fail(`HETZNER_MCP_ICON_PATH must end in .svg, .png or .ico, got ${JSON.stringify(iconPath)}`);
    const mimeType = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" }[extension];
    icon = { path: iconPath, mimeType, extension };
  }

  return {
    publicUrl,
    mcpUrl: new URL(`${publicUrl.href.replace(/\/+$/, "")}/mcp`),
    host: env.HOST?.trim() || "0.0.0.0",
    port: intEnv(env, "PORT", 3000),
    secret,
    dbPath: env.HETZNER_MCP_DB_PATH?.trim() || "./data/hetzner-mcp.sqlite",
    tenants,
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
    ...(icon ? { icon } : {}),
    accessTokenTtlSeconds: intEnv(env, "HETZNER_MCP_ACCESS_TOKEN_TTL", 3600),
    refreshTokenTtlSeconds: intEnv(env, "HETZNER_MCP_REFRESH_TOKEN_TTL", 90 * 24 * 3600),
    limits: loadLimits(env),
  };
}
