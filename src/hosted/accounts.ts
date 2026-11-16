/**
 * Hosted mode: the account overview tool and the instructions that explain
 * projects and Robot accounts to the model.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TenantConfig } from "./config.js";
import type { ConnectionRow } from "./store.js";

type Status = "connected" | "rejected" | "not_connected";

function statusOf(connection: ConnectionRow | undefined): Status {
  if (!connection) return "not_connected";
  return connection.broken_reason ? "rejected" : "connected";
}

const argumentOf = (tenant: TenantConfig): string => (tenant.type === "robot" ? "robot_account" : "project");

export function accountInstructions(tenants: TenantConfig[], connections: ConnectionRow[]): string {
  const usable = tenants.filter((t) => statusOf(connections.find((c) => c.tenant_id === t.id)) === "connected");
  const lines = ["# Accounts", "", "Each user connects the Hetzner Cloud projects and Robot accounts they have access to."];
  if (usable.length === 0) {
    lines.push("", "Nothing is connected for this user yet. Call `hetzner_list_accounts` and give the user the link to connect one.");
  } else {
    lines.push(
      "",
      "Connected for this user:",
      ...usable.map((t) => `- \`${t.id}\` = ${t.name} (${t.type === "robot" ? "Robot account" : "Cloud project"}, ${t.writes ? "read & write" : "read-only"})`),
      "",
      "- If the request does not make clear which project is meant and more than one is connected, ask the user.",
      "- If the user needs a project that is not connected, or a call reports rejected credentials, call `hetzner_list_accounts` and give them the link.",
    );
  }
  return lines.join("\n");
}

export function registerAccountTools(
  server: McpServer,
  deps: { tenants: TenantConfig[]; connections: ConnectionRow[]; manageLink: () => string },
): void {
  server.registerTool(
    "hetzner_list_accounts",
    {
      title: "List Hetzner projects and connection status",
      description:
        "List the Hetzner Cloud projects and Robot accounts this server can reach, which of them the user has connected, " +
        "and whether each allows writes. Also returns a link where the user connects more of them or replaces " +
        "rejected credentials.\n\n" +
        "Call this when the user asks which projects are available, names one that is not connected, or a call " +
        "reports invalid credentials. Give the user the link; it is valid for 30 minutes. Makes no Hetzner request.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async () => {
      const byTenant = new Map(deps.connections.map((c) => [c.tenant_id, c]));
      const accounts = deps.tenants.map((t) => {
        const connection = byTenant.get(t.id);
        return {
          id: t.id,
          name: t.name,
          type: t.type,
          argument: argumentOf(t),
          status: statusOf(connection),
          writes: t.writes,
          ...(connection ? { connected_as: connection.label } : {}),
        };
      });
      const link = deps.manageLink();
      const label: Record<Status, string> = {
        connected: "connected",
        rejected: "CREDENTIALS REJECTED: store new ones via the link",
        not_connected: "not connected",
      };
      const text = [
        "# Hetzner accounts",
        "",
        ...accounts.map(
          (a) =>
            `- **${a.name}** (\`${a.argument}: "${a.id}"\`, ${a.type === "robot" ? "Robot account" : "Cloud project"}): ${label[a.status]}` +
            `${a.connected_as ? ` (${a.connected_as})` : ""}, ${a.writes ? "read & write" : "read-only"}`,
        ),
        "",
        `Connect or reconnect here (valid 30 minutes): ${link}`,
        "A newly connected project works from the next tool call on; pass its id even if an older tool list does not show it yet.",
      ].join("\n");
      return { content: [{ type: "text" as const, text }], structuredContent: { accounts, connect_url: link } };
    },
  );
}
