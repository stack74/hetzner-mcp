const TOKEN_PREFIX = 'HETZNER_API_TOKEN';

export const SERVER_NAME = 'hetzner-code-mcp';
export const SERVER_VERSION = '0.1.0';

export type ApiName = 'cloud' | 'hetzner' | 'robot';

/** A Hetzner Cloud project: one API token. */
export interface CloudProject {
  token: string;
  /** false: only GET requests reach this project, also through hetzner_execute. */
  writes: boolean;
  /** true: requests that create billable resources or raise a price are allowed. */
  billed: boolean;
  /** Human-readable name, shown to the model. */
  label?: string;
}

/** A Robot account: one webservice user (account-wide, independent of projects). */
export interface RobotAccount {
  user: string;
  password: string;
  writes: boolean;
  billed: boolean;
  label?: string;
}

export interface Limits {
  executeTimeoutMs: number;
  requestTimeoutMs: number;
  maxOutputChars: number;
  maxRequestsPerRun: number;
  /** false: billed and destructive requests are sent without asking for approval. */
  confirm: boolean;
  baseUrls: Record<ApiName, string>;
}

export interface Config extends Limits {
  /** project name -> credentials */
  projects: Map<string, CloudProject>;
  defaultProject: string | undefined;
  /** Robot account name -> credentials */
  robots: Map<string, RobotAccount>;
  defaultRobot: string | undefined;
  /** true removes hetzner_execute altogether. */
  readOnly: boolean;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    executeTimeoutMs: intEnv(env, 'HETZNER_EXECUTE_TIMEOUT_SECONDS', 120) * 1000,
    requestTimeoutMs: intEnv(env, 'HETZNER_REQUEST_TIMEOUT_SECONDS', 30) * 1000,
    maxOutputChars: intEnv(env, 'HETZNER_MAX_OUTPUT_CHARS', 40_000),
    maxRequestsPerRun: intEnv(env, 'HETZNER_MAX_REQUESTS_PER_RUN', 200),
    confirm: !/^(1|true|yes)$/i.test(env.HETZNER_SKIP_CONFIRMATION ?? ''),
    baseUrls: {
      cloud: (env.HETZNER_CLOUD_API_URL ?? 'https://api.hetzner.cloud/v1').replace(/\/+$/, ''),
      hetzner: (env.HETZNER_API_URL ?? 'https://api.hetzner.com/v1').replace(/\/+$/, ''),
      robot: (env.HETZNER_ROBOT_API_URL ?? 'https://robot-ws.your-server.de').replace(/\/+$/, ''),
    },
  };
}

/**
 * Local (stdio) configuration from the environment. Tokens are bound to one project each.
 *   HETZNER_API_TOKEN          -> project "default"
 *   HETZNER_API_TOKEN_<NAME>   -> project "<name>" (lower-cased)
 *   HETZNER_ROBOT_USER / HETZNER_ROBOT_PASSWORD -> Robot webservice user
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const readOnly = /^(1|true|yes)$/i.test(env.HETZNER_READ_ONLY ?? '');
  const billed = !readOnly && /^(1|true|yes)$/i.test(env.HETZNER_ALLOW_BILLED ?? '');
  const projects = new Map<string, CloudProject>();
  for (const [key, value] of Object.entries(env)) {
    if (!value?.trim()) continue;
    if (key === TOKEN_PREFIX) projects.set('default', { token: value.trim(), writes: !readOnly, billed });
    else if (key.startsWith(`${TOKEN_PREFIX}_`)) {
      projects.set(key.slice(TOKEN_PREFIX.length + 1).toLowerCase(), { token: value.trim(), writes: !readOnly, billed });
    }
  }

  let defaultProject = env.HETZNER_DEFAULT_PROJECT?.trim().toLowerCase() || undefined;
  if (defaultProject && !projects.has(defaultProject)) {
    throw new Error(
      `HETZNER_DEFAULT_PROJECT is "${defaultProject}" but no token HETZNER_API_TOKEN_${defaultProject.toUpperCase()} is set.`,
    );
  }
  if (!defaultProject) {
    if (projects.has('default')) defaultProject = 'default';
    else if (projects.size === 1) defaultProject = [...projects.keys()][0];
  }

  const robots = new Map<string, RobotAccount>();
  const robotUser = env.HETZNER_ROBOT_USER?.trim();
  const robotPassword = env.HETZNER_ROBOT_PASSWORD;
  if (robotUser && robotPassword) robots.set('default', { user: robotUser, password: robotPassword, writes: !readOnly, billed });

  return {
    ...loadLimits(env),
    projects,
    defaultProject,
    robots,
    defaultRobot: robots.size === 1 ? 'default' : undefined,
    readOnly,
  };
}

function pick<T>(kind: string, argument: string, entries: Map<string, T>, fallback: string | undefined, requested: string | undefined, missing: string): T {
  const available = [...entries.keys()];
  if (available.length === 0) throw new Error(missing);
  const name = requested?.trim().toLowerCase() || fallback;
  if (!name) throw new Error(`Several ${kind}s are available and none is the default. Pass "${argument}": one of ${available.join(', ')}.`);
  const entry = entries.get(name);
  if (!entry) throw new Error(`Unknown ${kind} "${name}". Available: ${available.join(', ')}.`);
  return entry;
}

export function resolveProject(config: Config, requested: string | undefined, missing?: string): CloudProject {
  return pick(
    'project',
    'project',
    config.projects,
    config.defaultProject,
    requested,
    missing ?? 'No Hetzner API token configured. Set HETZNER_API_TOKEN (or HETZNER_API_TOKEN_<PROJECT> for several projects) in the MCP server environment.',
  );
}

export function resolveRobot(config: Config, requested: string | undefined, missing?: string): RobotAccount {
  return pick(
    'Robot account',
    'robot_account',
    config.robots,
    config.defaultRobot,
    requested,
    missing ??
      'Robot API is not configured. Set HETZNER_ROBOT_USER and HETZNER_ROBOT_PASSWORD (a webservice user from Robot: Settings -> Web service and app settings) in the MCP server environment.',
  );
}
