/**
 * The OAuth authorization server MCP clients (claude.ai, Claude Code, …) talk to.
 *
 * The SDK's mcpAuthRouter handles the protocol (metadata, dynamic client
 * registration, PKCE checks, token endpoint); this provider supplies the state.
 *
 * The interesting step is `authorize`: instead of a login form it sends the
 * person to the connect page, where they store the API tokens of their Hetzner
 * projects and Robot accounts. Only when they press "Fertig" does the MCP client get its
 * authorization code (see `completeAuthorization`).
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { CustomOAuthError, InvalidGrantError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { HostedConfig } from "./config.js";
import { renderMessage } from "./pages.js";
import type { SessionRow, Store } from "./store.js";

/** How long the connect page stays usable once opened. */
export const SESSION_TTL_SECONDS = 30 * 60;

export const GRANT_COOKIE = "hetzner_mcp_grant";
const GRANT_COOKIE_MAX_AGE = 180 * 24 * 3600;

/**
 * Remembers a person's grant in their browser, so reconnecting the MCP client
 * (new token, same person) finds the Hetzner accounts already connected. The
 * connect pages also use it to refuse links that belong to a different grant
 * than the one this browser is connected with (see http.ts).
 */
export class GrantCookie {
  constructor(
    private readonly secret: string,
    private readonly secure: boolean,
  ) {}

  private sign(grantId: string): string {
    return createHmac("sha256", this.secret).update(`grant:${grantId}`).digest("base64url");
  }

  read(req: Request): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name !== GRANT_COOKIE) continue;
      let value: string;
      try {
        value = decodeURIComponent(rest.join("="));
      } catch {
        return undefined;
      }
      const [grantId, signature] = value.split(".");
      if (!grantId || !signature) return undefined;
      const expected = Buffer.from(this.sign(grantId));
      const actual = Buffer.from(signature);
      return expected.length === actual.length && timingSafeEqual(expected, actual) ? grantId : undefined;
    }
    return undefined;
  }

  write(res: Response, grantId: string): void {
    res.cookie(GRANT_COOKIE, `${grantId}.${this.sign(grantId)}`, {
      httpOnly: true,
      secure: this.secure,
      sameSite: "lax",
      maxAge: GRANT_COOKIE_MAX_AGE * 1000,
      path: "/",
    });
  }

  clear(res: Response): void {
    res.clearCookie(GRANT_COOKIE, { path: "/" });
  }
}

export class HostedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly config: HostedConfig,
    private readonly store: Store,
    private readonly cookie: GrantCookie,
  ) {
    this.clientsStore = {
      getClient: (clientId) => store.getClient(clientId),
      registerClient: (client) => {
        // Only known redirect targets: an attacker-controlled one would receive
        // the code for whoever stores their tokens on the connect page (see redirects.ts).
        const uris = (client.redirect_uris ?? []).map(String);
        const refused = uris.filter((uri) => !config.redirects.allows(uri));
        if (refused.length > 0 || uris.length === 0) {
          console.error(`Client registration refused: redirect URI(s) not allowed: ${refused.join(", ") || "(none given)"}`);
          throw new CustomOAuthError(
            "invalid_redirect_uri",
            `Redirect URI not allowed on this server: ${refused.join(", ") || "(none given)"}. ` +
              "The operator can extend HETZNER_MCP_ALLOWED_REDIRECT_URIS.",
          );
        }
        const full = client as OAuthClientInformationFull;
        store.saveClient(full);
        return full;
      },
    };
  }

  /** Accepts the MCP endpoint (and the bare origin, which some clients send) as RFC 8707 resource. */
  private checkResource(resource: URL | undefined): void {
    if (!resource) return;
    const allowed = [this.config.mcpUrl.href, this.config.publicUrl.href, `${this.config.publicUrl.origin}/`];
    if (!allowed.includes(resource.href)) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.config.mcpUrl.href}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    // Checked again here: the client may have registered before the allowlist was narrowed.
    // Answer with a page instead of redirecting — the redirect target is the problem.
    if (!this.config.redirects.allows(params.redirectUri)) {
      console.error(`Authorization refused for client ${client.client_id}: redirect URI ${params.redirectUri} not allowed`);
      res.setHeader("Cache-Control", "no-store");
      res
        .status(400)
        .type("html")
        .send(
          renderMessage(
            "Verbindung abgelehnt",
            "Diese App darf sich nicht mit diesem Server verbinden: ihre Rücksprungadresse ist nicht freigegeben.",
          ),
        );
      return;
    }
    this.checkResource(params.resource);
    const remembered = this.cookie.read(res.req);
    const grantId = remembered && this.store.grantExists(remembered) ? remembered : this.store.createGrant();
    const sessionId = this.store.createSession(
      {
        kind: "authorize",
        grant_id: grantId,
        client_id: client.client_id,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        state: params.state ?? null,
        resource: params.resource?.href ?? null,
      },
      SESSION_TTL_SECONDS,
    );
    res.redirect(302, `/connect/${sessionId}`);
  }

  /** Called when the person presses "Fertig": returns the redirect back to the MCP client. */
  completeAuthorization(session: SessionRow): string {
    if (session.kind !== "authorize" || !session.client_id || !session.redirect_uri || !session.code_challenge) {
      throw new Error("not an authorization session");
    }
    const code = this.store.createCode({
      grant_id: session.grant_id,
      client_id: session.client_id,
      code_challenge: session.code_challenge,
      redirect_uri: session.redirect_uri,
      resource: session.resource,
    });
    this.store.deleteSession(session.id);
    const target = new URL(session.redirect_uri);
    target.searchParams.set("code", code);
    if (session.state) target.searchParams.set("state", session.state);
    return target.href;
  }

  /** Called when the person cancels: tells the MCP client access was denied. */
  denyAuthorization(session: SessionRow): string {
    this.store.deleteSession(session.id);
    const target = new URL(session.redirect_uri!);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user cancelled connecting Hetzner.");
    if (session.state) target.searchParams.set("state", session.state);
    return target.href;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.store.getCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.getCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError("Invalid authorization code");
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    this.checkResource(resource);
    // Single use, also when the exchange fails further down.
    this.store.deleteCode(authorizationCode);
    return this.issueTokens(row.grant_id, client.client_id, resource?.href ?? row.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.store.getToken(refreshToken);
    if (!row || row.kind !== "refresh" || row.client_id !== client.client_id || !this.store.grantExists(row.grant_id)) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    this.checkResource(resource);
    // Rotate: the old refresh token stops working.
    this.store.deleteToken(refreshToken);
    return this.issueTokens(row.grant_id, client.client_id, resource?.href ?? row.resource);
  }

  private issueTokens(grantId: string, clientId: string, resource: string | null): OAuthTokens {
    const access = this.store.createToken(
      { kind: "access", grant_id: grantId, client_id: clientId, resource },
      this.config.accessTokenTtlSeconds,
    );
    const refresh = this.store.createToken(
      { kind: "refresh", grant_id: grantId, client_id: clientId, resource },
      this.config.refreshTokenTtlSeconds,
    );
    this.store.touchGrant(grantId);
    return {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refresh.token,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.store.getToken(token);
    if (!row || row.kind !== "access" || !this.store.grantExists(row.grant_id)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }
    return {
      token,
      clientId: row.client_id,
      scopes: [],
      expiresAt: row.expires_at,
      ...(row.resource ? { resource: new URL(row.resource) } : {}),
      extra: { grantId: row.grant_id },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.deleteToken(request.token);
  }
}
