/**
 * Persistent state for hosted mode, in SQLite (node:sqlite, no extra dependency).
 *
 * Vocabulary:
 *  - grant:      one person's bundle of Hetzner connections. Every token this
 *                server issues to an MCP client points at a grant.
 *  - connection: a grant's credentials for one tenant (Cloud project or Robot account).
 *  - session:    a short-lived visit to the connect page, either during the MCP
 *                client's OAuth authorization ("authorize") or from a link the
 *                model handed out ("manage").
 *
 * Secrets at rest: Hetzner credentials are AES-256-GCM encrypted; tokens this server
 * issues are stored only as SHA-256 hashes.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface SessionRow {
  id: string;
  kind: "authorize" | "manage";
  grant_id: string;
  client_id: string | null;
  redirect_uri: string | null;
  code_challenge: string | null;
  state: string | null;
  resource: string | null;
  expires_at: number;
}

/** What is stored per connection: a Cloud API token, or a Robot webservice user. */
export type ConnectionSecret = { token: string } | { user: string; password: string };

export interface ConnectionRow {
  grant_id: string;
  tenant_id: string;
  secret: ConnectionSecret;
  /** For display, never the secret itself: "Token …abcd" or the Robot user name. */
  label: string;
  /** Who stored it, when Cloudflare Access is in front (their e-mail). */
  connected_by: string | null;
  connected_at: number;
  /** Set when Hetzner rejected the credentials; the person has to store new ones. */
  broken_reason: string | null;
}

export interface TokenRow {
  kind: "access" | "refresh";
  grant_id: string;
  client_id: string;
  resource: string | null;
  expires_at: number;
}

export interface CodeRow {
  grant_id: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string | null;
  expires_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT, redirect_uri TEXT,
  code_challenge TEXT, state TEXT, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  grant_id TEXT NOT NULL, tenant_id TEXT NOT NULL, secret TEXT NOT NULL, label TEXT NOT NULL,
  connected_by TEXT, connected_at INTEGER NOT NULL, broken_reason TEXT, PRIMARY KEY (grant_id, tenant_id));
CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL, client_id TEXT NOT NULL, code_challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, resource TEXT, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL, client_id TEXT NOT NULL,
  resource TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS tokens_grant ON tokens (grant_id);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  constructor(dbPath: string, secret: string) {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.key = Buffer.from(hkdfSync("sha256", secret, "hetzner-mcp", "credential-encryption", 32));
  }

  close(): void {
    this.db.close();
  }

  // --- encryption --------------------------------------------------------

  private encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  private decrypt(stored: string): string {
    const raw = Buffer.from(stored, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  }

  // --- OAuth clients (MCP clients that registered with us) ---------------

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as OAuthClientInformationFull) : undefined;
  }

  saveClient(client: OAuthClientInformationFull): void {
    this.db
      .prepare("INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)")
      .run(client.client_id, JSON.stringify(client), nowSeconds());
  }

  // --- grants ------------------------------------------------------------

  createGrant(): string {
    const id = randomToken(18);
    const now = nowSeconds();
    this.db.prepare("INSERT INTO grants (id, created_at, last_used_at) VALUES (?, ?, ?)").run(id, now, now);
    return id;
  }

  grantExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM grants WHERE id = ?").get(id) !== undefined;
  }

  touchGrant(id: string): void {
    this.db.prepare("UPDATE grants SET last_used_at = ? WHERE id = ?").run(nowSeconds(), id);
  }

  // --- connect-page sessions --------------------------------------------

  createSession(row: Omit<SessionRow, "id" | "expires_at">, ttlSeconds: number): string {
    const id = randomToken();
    this.db
      .prepare(
        "INSERT INTO sessions (id, kind, grant_id, client_id, redirect_uri, code_challenge, state, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, row.kind, row.grant_id, row.client_id, row.redirect_uri, row.code_challenge, row.state, row.resource, nowSeconds() + ttlSeconds);
    return id;
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // --- connections -------------------------------------------------------

  saveConnection(row: Omit<ConnectionRow, "broken_reason">): void {
    this.db
      .prepare(
        `INSERT INTO connections (grant_id, tenant_id, secret, label, connected_by, connected_at, broken_reason)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(grant_id, tenant_id) DO UPDATE SET secret = excluded.secret, label = excluded.label,
           connected_by = excluded.connected_by, connected_at = excluded.connected_at, broken_reason = NULL`,
      )
      .run(row.grant_id, row.tenant_id, this.encrypt(JSON.stringify(row.secret)), row.label, row.connected_by, row.connected_at);
  }

  markConnectionBroken(grantId: string, tenantId: string, reason: string): void {
    this.db.prepare("UPDATE connections SET broken_reason = ? WHERE grant_id = ? AND tenant_id = ?").run(reason, grantId, tenantId);
  }

  listConnections(grantId: string): ConnectionRow[] {
    const rows = this.db.prepare("SELECT * FROM connections WHERE grant_id = ?").all(grantId) as Record<string, unknown>[];
    return rows.map((row) => ({
      grant_id: String(row.grant_id),
      tenant_id: String(row.tenant_id),
      secret: JSON.parse(this.decrypt(String(row.secret))) as ConnectionSecret,
      label: String(row.label),
      connected_by: row.connected_by === null ? null : String(row.connected_by),
      connected_at: Number(row.connected_at),
      broken_reason: row.broken_reason === null ? null : String(row.broken_reason),
    }));
  }

  deleteConnection(grantId: string, tenantId: string): void {
    this.db.prepare("DELETE FROM connections WHERE grant_id = ? AND tenant_id = ?").run(grantId, tenantId);
  }

  // --- authorization codes (issued to MCP clients) -----------------------

  createCode(row: Omit<CodeRow, "expires_at">): string {
    const code = randomToken();
    this.db
      .prepare(
        "INSERT INTO auth_codes (code_hash, grant_id, client_id, code_challenge, redirect_uri, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(sha256(code), row.grant_id, row.client_id, row.code_challenge, row.redirect_uri, row.resource, nowSeconds() + 300);
    return code;
  }

  getCode(code: string): CodeRow | undefined {
    const row = this.db.prepare("SELECT * FROM auth_codes WHERE code_hash = ?").get(sha256(code)) as CodeRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteCode(code: string): void {
    this.db.prepare("DELETE FROM auth_codes WHERE code_hash = ?").run(sha256(code));
  }

  // --- tokens (issued to MCP clients) ------------------------------------

  createToken(row: Omit<TokenRow, "expires_at">, ttlSeconds: number): { token: string; expiresAt: number } {
    const token = randomToken();
    const expiresAt = nowSeconds() + ttlSeconds;
    this.db
      .prepare("INSERT INTO tokens (token_hash, kind, grant_id, client_id, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(sha256(token), row.kind, row.grant_id, row.client_id, row.resource, expiresAt);
    return { token, expiresAt };
  }

  getToken(token: string): TokenRow | undefined {
    const row = this.db.prepare("SELECT * FROM tokens WHERE token_hash = ?").get(sha256(token)) as TokenRow | undefined;
    if (!row || row.expires_at < nowSeconds()) return undefined;
    return row;
  }

  deleteToken(token: string): void {
    this.db.prepare("DELETE FROM tokens WHERE token_hash = ?").run(sha256(token));
  }

  // --- housekeeping ------------------------------------------------------

  /** Drops expired rows. Cheap; run it periodically. */
  purgeExpired(): void {
    const now = nowSeconds();
    for (const table of ["sessions", "auth_codes", "tokens"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE expires_at < ?`).run(now);
    }
  }
}
