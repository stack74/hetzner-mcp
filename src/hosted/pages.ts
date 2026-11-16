/**
 * HTML for the connect page — the page a person lands on when they connect the
 * MCP server in claude.ai. Server-rendered, no JavaScript, German UI.
 */

import type { TenantConfig } from "./config.js";
import type { ConnectionRow, SessionRow } from "./store.js";

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const STYLE = `
:root { --bg:#f6f7f9; --card:#fff; --text:#1d2330; --muted:#5f6b7a; --line:#e3e7ed; --accent:#d50c2d; --ok:#1a7f37; --warn:#b35900; --danger:#c62828; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --text:#e6e9ee; --muted:#9aa5b4; --line:#2a313b; --accent:#e5354f; --ok:#3fb950; --warn:#e3913a; --danger:#f0605d; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; padding:32px 16px; }
main { max-width:640px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 6px; }
p.lead { color:var(--muted); margin:0 0 24px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; }
.tenant { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:14px 16px; flex-wrap:wrap; }
.tenant + .tenant { border-top:1px solid var(--line); }
.name { font-weight:600; }
.status { font-size:13px; color:var(--muted); }
.status.ok { color:var(--ok); } .status.warn { color:var(--warn); }
.badge { font-size:12px; border:1px solid var(--line); border-radius:99px; padding:1px 8px; margin-left:6px; color:var(--muted); font-weight:400; }
.actions { display:flex; gap:8px; }
form { margin:0; }
button { font:inherit; font-size:14px; border-radius:7px; padding:6px 14px; cursor:pointer; border:1px solid var(--line); background:var(--card); color:var(--text); }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
button.link { border:none; background:none; color:var(--danger); padding:6px 4px; }
button:disabled { opacity:.45; cursor:not-allowed; }
label { display:block; font-weight:600; margin:12px 0 6px; }
input { width:100%; font:inherit; padding:8px 10px; border:1px solid var(--line); border-radius:7px; background:var(--bg); color:var(--text); }
.footer { display:flex; gap:12px; justify-content:flex-end; align-items:center; margin-top:20px; flex-wrap:wrap; }
.footer .hint { margin-right:auto; color:var(--muted); font-size:13px; }
.banner { border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:14px; border:1px solid; }
.banner.error { border-color:var(--danger); color:var(--danger); }
.banner.notice { border-color:var(--ok); color:var(--ok); }
details { margin-top:24px; color:var(--muted); font-size:13px; }
`;

let iconLink = "";

/** Links the configured icon from every page (set once at startup). */
export function setPageIcon(href: string, mimeType: string): void {
  iconLink = `<link rel="icon" href="${escape(href)}" type="${escape(mimeType)}">`;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title>${iconLink}<style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

const formatDate = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Berlin" });

const kindLabel = (tenant: TenantConfig): string => (tenant.type === "robot" ? "Robot" : "Cloud-Projekt");

function tenantRow(sessionId: string, tenant: TenantConfig, connection: ConnectionRow | undefined): string {
  const base = `/connect/${encodeURIComponent(sessionId)}/tenants/${encodeURIComponent(tenant.id)}`;
  const badges =
    `<span class="badge">${kindLabel(tenant)}</span>` + `<span class="badge">${tenant.writes ? (tenant.billed ? "Lesen, Schreiben &amp; Kostenpflichtiges" : "Lesen &amp; Schreiben") : "Nur lesen"}</span>`;
  const connectButton = (label: string, primary: boolean): string =>
    `<form method="get" action="${base}/key"><button${primary ? ' class="primary"' : ""}>${label}</button></form>`;
  const disconnect = `<form method="post" action="${base}/disconnect"><button class="link">Trennen</button></form>`;
  let status: string;
  let actions: string;
  if (!connection) {
    status = `<div class="status">Nicht verbunden</div>`;
    actions = connectButton("Verbinden", true);
  } else if (connection.broken_reason) {
    status = `<div class="status warn">Zugangsdaten von Hetzner abgelehnt – bitte neu hinterlegen</div>`;
    actions = connectButton("Neu verbinden", true) + disconnect;
  } else {
    status = `<div class="status ok">✓ Verbunden (${escape(connection.label)}) · seit ${formatDate(connection.connected_at)}</div>`;
    actions = connectButton("Neu verbinden", false) + disconnect;
  }
  return `<div class="tenant"><div><div class="name">${escape(tenant.name)}${badges}</div>${status}</div><div class="actions">${actions}</div></div>`;
}

export interface ConnectPageInput {
  /** Who is looking, when Cloudflare Access is in front (their e-mail). */
  viewer?: string;
  session: SessionRow;
  tenants: TenantConfig[];
  connections: ConnectionRow[];
  error?: string;
  notice?: string;
}

export function renderConnectPage({ viewer, session, tenants, connections, error, notice }: ConnectPageInput): string {
  const byTenant = new Map(connections.map((c) => [c.tenant_id, c]));
  const usable = connections.filter((c) => !c.broken_reason && tenants.some((t) => t.id === c.tenant_id)).length;
  const sid = encodeURIComponent(session.id);

  const banners =
    (error ? `<div class="banner error">${escape(error)}</div>` : "") + (notice ? `<div class="banner notice">${escape(notice)}</div>` : "");

  const footer =
    session.kind === "authorize"
      ? `<div class="footer">
          <span class="hint">${usable === 0 ? "Verbinde mindestens einen Eintrag." : `${usable} verbunden.`}</span>
          <form method="post" action="/connect/${sid}/cancel"><button>Abbrechen</button></form>
          <form method="post" action="/connect/${sid}/finish"><button class="primary"${usable === 0 ? " disabled" : ""}>Fertig – zurück zu Claude</button></form>
        </div>`
      : `<div class="footer"><form method="post" action="/connect/${sid}/finish"><button class="primary">Fertig</button></form></div>`;

  return layout(
    "Hetzner verbinden",
    `<h1>Hetzner-Projekte verbinden</h1>
    <p class="lead">Verbinde jedes Projekt und jeden Robot-Account, auf den du Zugriff hast, mit einem API-Token bzw. Webservice-Benutzer.
    Was du nicht brauchst, lässt du einfach aus – du kannst es später ergänzen.</p>
    ${viewer ? `<p class="status" style="margin:-16px 0 20px">Angemeldet als ${escape(viewer)}</p>` : ""}
    ${banners}
    <div class="card">${tenants.map((t) => tenantRow(session.id, t, byTenant.get(t.id))).join("")}</div>
    ${footer}
    <details><summary>Hinweise</summary>
      <p>Die Zugangsdaten werden verschlüsselt gespeichert und nur für deine eigenen Anfragen über Claude verwendet.</p>
      <p>Den Zugriff entziehst du hier über „Trennen“ – oder bei Hetzner, indem du den API-Token löschst bzw. das Passwort des Webservice-Benutzers änderst.</p>
      <p>„Nur lesen“ bedeutet, dass dieser Server für den Eintrag ausschließlich lesende Anfragen durchlässt, auch wenn der Token mehr dürfte.</p>
    </details>`,
  );
}

export function renderKeyForm(session: SessionRow, tenant: TenantConfig, error?: string): string {
  const sid = encodeURIComponent(session.id);
  const action = `/connect/${sid}/tenants/${encodeURIComponent(tenant.id)}/key`;
  const fields =
    tenant.type === "robot"
      ? `<ol style="margin:0 0 4px; padding-left:20px">
          <li>In <b>Hetzner Robot</b> einloggen (robot.hetzner.com).</li>
          <li>Rechts oben aufs Benutzermenü → <b>Einstellungen</b> → <b>Webservice- und App-Einstellungen</b>.</li>
          <li>Dort einen Webservice-Benutzer anlegen bzw. dessen Passwort setzen.</li>
        </ol>
        <label for="robot_user">Webservice-Benutzer</label>
        <input id="robot_user" name="robot_user" type="text" required autocomplete="off" spellcheck="false" placeholder="#ws+XXXXXXXX">
        <label for="robot_password">Passwort</label>
        <input id="robot_password" name="robot_password" type="password" required autocomplete="off" spellcheck="false">`
      : `<ol style="margin:0 0 4px; padding-left:20px">
          <li>In der <b>Hetzner Console</b> das Projekt „${escape(tenant.name)}“ öffnen (console.hetzner.com).</li>
          <li>Links <b>Sicherheit</b> → <b>API-Tokens</b> → <b>API-Token generieren</b>.</li>
          <li>Berechtigung wählen (${tenant.writes ? "„Lesen &amp; Schreiben“ für Änderungen, sonst „Lesen“" : "„Lesen“ genügt"}) und den Token kopieren.</li>
        </ol>
        <label for="api_token">API-Token</label>
        <input id="api_token" name="api_token" type="password" required autocomplete="off" spellcheck="false">`;
  const hint =
    tenant.type === "robot"
      ? "Robot sperrt die IP dieses Servers nach drei falschen Anmeldungen für 10 Minuten – bitte sorgfältig eingeben."
      : "Ein Token gilt immer für genau ein Projekt. Er wird nur einmal angezeigt.";
  return layout(
    `${tenant.name} verbinden`,
    `<h1>„${escape(tenant.name)}“ verbinden</h1>
    <p class="lead">${tenant.type === "robot" ? "Hinterlege den Webservice-Benutzer deines Robot-Accounts." : "Hinterlege einen API-Token aus diesem Projekt."}</p>
    ${error ? `<div class="banner error">${escape(error)}</div>` : ""}
    <div class="card" style="padding:16px">
      <form method="post" action="${action}">
        ${fields}
        <div class="footer">
          <span class="hint">${hint}</span>
          <a href="/connect/${sid}" style="color:var(--muted)">Zurück</a>
          <button class="primary">Prüfen und verbinden</button>
        </div>
      </form>
    </div>`,
  );
}

export function renderMessage(title: string, text: string): string {
  return layout(title, `<h1>${escape(title)}</h1><p class="lead">${escape(text)}</p>`);
}
