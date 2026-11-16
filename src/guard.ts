/**
 * Cost and damage guard for write requests.
 *
 *  - billed:      creates something Hetzner charges for, or raises a price. Off unless
 *                 the operator allows it; when allowed, it needs an approval that shows
 *                 the price.
 *  - destructive: deletes something or destroys data. Needs an approval that names
 *                 what is affected. Configuration changes that cost nothing and lose
 *                 no data (firewall rules, DNS records, labels) are not guarded.
 *
 * Classification is by operation, not by guessing from the path, so the lists below
 * are the whole policy.
 */
import type { ApiName } from './config.js';

export type GuardKind = 'billed' | 'destructive';

export interface GuardHit {
  kind: GuardKind;
  /** What the request does, as a phrase that follows "This request ...". */
  effect: string;
}

const BILLED_CLOUD: Record<string, string> = {
  create_server: 'creates a server, billed per hour until it is deleted (also while powered off)',
  create_volume: 'creates a volume, billed per GB and month until it is deleted',
  create_load_balancer: 'creates a load balancer, billed per hour until it is deleted',
  create_floating_ip: 'creates a floating IP, billed per month until it is deleted',
  create_primary_ip: 'creates a primary IP, billed per hour until it is deleted',
  create_server_image: 'creates a snapshot or backup image, billed per GB and month until it is deleted',
  change_server_type: 'changes the server type, which changes its price',
  resize_volume: 'enlarges a volume, which raises its price (a volume cannot be shrunk again)',
  change_load_balancer_type: 'changes the load balancer type, which changes its price',
  enable_server_backup: 'enables backups, a surcharge on the server price',
  create_storage_box: 'orders a Storage Box, billed per month until it is deleted',
  change_storage_box_type: 'changes the Storage Box type, which changes its price',
};

const DESTRUCTIVE_CLOUD: Record<string, string> = {
  rebuild_server: 'overwrites the whole disk of the server with an image; all data on it is lost',
  disable_server_backup: 'disables backups and deletes all existing backups of the server',
  rollback_storage_box_snapshot: 'rolls the Storage Box back to a snapshot; newer data is lost',
  import_zone_zonefile: 'replaces all records of the DNS zone with the zone file',
};

const BILLED_ROBOT: Record<string, string> = {
  '/order/server/transaction': 'orders a dedicated server, billed per month (plus a possible setup fee)',
  '/order/server_market/transaction': 'orders a server from the Server Auction, billed per month',
  '/order/server_addon/transaction': 'orders a paid addon for a dedicated server',
};

const DESTRUCTIVE_ROBOT: Record<string, string> = {
  '/server/{server-number}/cancellation': 'cancels the dedicated server; it is wiped and returned at the cancellation date',
  '/ip/{ip}/cancellation': 'cancels the IP address',
  '/subnet/{net-ip}/cancellation': 'cancels the subnet',
  '/boot/{server-number}/linux': 'activates an OS installation; the next reboot wipes the disks',
  '/boot/{server-number}/vnc': 'activates an OS installation; the next reboot wipes the disks',
  '/boot/{server-number}/windows': 'activates an OS installation; the next reboot wipes the disks',
};

export function classify(api: ApiName, method: string, operation: { operationId: string; path: string } | undefined): GuardHit | undefined {
  if (method === 'GET') return undefined;
  if (api === 'robot') {
    const template = operation?.path ?? '';
    if (method === 'POST' && BILLED_ROBOT[template]) return { kind: 'billed', effect: BILLED_ROBOT[template] };
    if (method === 'POST' && DESTRUCTIVE_ROBOT[template]) return { kind: 'destructive', effect: DESTRUCTIVE_ROBOT[template] };
  } else if (operation) {
    if (BILLED_CLOUD[operation.operationId]) return { kind: 'billed', effect: BILLED_CLOUD[operation.operationId] };
    if (DESTRUCTIVE_CLOUD[operation.operationId]) return { kind: 'destructive', effect: DESTRUCTIVE_CLOUD[operation.operationId] };
  }
  if (method === 'DELETE') return { kind: 'destructive', effect: 'deletes the resource permanently' };
  return undefined;
}

// ---------------------------------------------------------------------------
// Price preview from GET /pricing (Cloud API)
// ---------------------------------------------------------------------------

interface Price {
  location?: string;
  price_hourly?: { gross?: string };
  price_monthly?: { gross?: string };
}
interface Priced {
  id?: number;
  name?: string;
  type?: string;
  prices?: Price[];
}
export interface Pricing {
  currency?: string;
  vat_rate?: string;
  server_types?: Priced[];
  load_balancer_types?: Priced[];
  floating_ips?: Priced[];
  primary_ips?: Priced[];
  volume?: { price_per_gb_month?: { gross?: string } };
  image?: { price_per_gb_month?: { gross?: string } };
  server_backup?: { percentage?: string };
}

const amount = (value: string | undefined, digits: number): string | undefined => {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? n.toFixed(digits) : undefined;
};

function priceOf(entry: Priced | undefined, location: unknown, currency: string): string | undefined {
  const prices = entry?.prices ?? [];
  if (prices.length === 0) return undefined;
  const format = (p: Price): string | undefined => {
    const monthly = amount(p.price_monthly?.gross, 2);
    const hourly = amount(p.price_hourly?.gross, 4);
    if (!monthly && !hourly) return undefined;
    return [monthly && `${monthly} ${currency}/month`, hourly && `${hourly} ${currency}/hour`].filter(Boolean).join(', ');
  };
  const exact = typeof location === 'string' ? prices.find((p) => p.location === location) : undefined;
  if (exact) return format(exact);
  // Location unknown or chosen by Hetzner: give the range.
  const monthly = prices.map((p) => Number(p.price_monthly?.gross)).filter(Number.isFinite);
  if (monthly.length === 0) return format(prices[0]);
  const [min, max] = [Math.min(...monthly), Math.max(...monthly)];
  return min === max ? `${min.toFixed(2)} ${currency}/month` : `${min.toFixed(2)} to ${max.toFixed(2)} ${currency}/month depending on the location`;
}

const byNameOrId = (list: Priced[] | undefined, ref: unknown): Priced | undefined =>
  (list ?? []).find((e) => e.name === ref || (ref !== undefined && String(e.id) === String(ref)));

/** Price of a billed Cloud request, including VAT, or undefined when it cannot be derived. */
export function describePrice(operationId: string, body: unknown, pricing: Pricing): string | undefined {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const currency = pricing.currency ?? 'EUR';
  const perGb = (rate: string | undefined, what: string): string | undefined => {
    const price = Number(rate);
    if (!Number.isFinite(price)) return undefined;
    const size = Number(b.size);
    return Number.isFinite(size) && size > 0
      ? `${what} of ${size} GB: ${(price * size).toFixed(2)} ${currency}/month`
      : `${what}: ${price.toFixed(4)} ${currency} per GB and month`;
  };
  let text: string | undefined;
  switch (operationId) {
    case 'create_server':
    case 'change_server_type': {
      const price = priceOf(byNameOrId(pricing.server_types, b.server_type), b.location, currency);
      text = price && `server type ${String(b.server_type)}${typeof b.location === 'string' ? ` in ${b.location}` : ''}: ${price}`;
      break;
    }
    case 'create_load_balancer':
    case 'change_load_balancer_type': {
      const price = priceOf(byNameOrId(pricing.load_balancer_types, b.load_balancer_type), b.location, currency);
      text = price && `load balancer type ${String(b.load_balancer_type)}: ${price}`;
      break;
    }
    case 'create_floating_ip':
    case 'create_primary_ip': {
      const list = operationId === 'create_floating_ip' ? pricing.floating_ips : pricing.primary_ips;
      const price = priceOf((list ?? []).find((e) => e.type === b.type), b.home_location ?? b.location, currency);
      text = price && `${String(b.type)} address: ${price}`;
      break;
    }
    case 'create_volume':
    case 'resize_volume':
      text = perGb(pricing.volume?.price_per_gb_month?.gross, 'volume');
      break;
    case 'create_server_image':
      text = perGb(pricing.image?.price_per_gb_month?.gross, 'image');
      break;
    case 'enable_server_backup': {
      const percentage = amount(pricing.server_backup?.percentage, 0);
      text = percentage && `backups: ${percentage}% on top of the server price`;
      break;
    }
  }
  return text && `${text} (incl. ${amount(pricing.vat_rate, 0) ?? '?'}% VAT)`;
}

/** Names the resource a response body describes, e.g. `server "web-1" (id 42)`. */
export function describeTarget(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const [kind, value] = Object.entries(json as Record<string, unknown>).find(([, v]) => v && typeof v === 'object' && !Array.isArray(v)) ?? [];
  if (!kind || !value) return undefined;
  const r = value as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.name === 'string') parts.push(`"${r.name}"`);
  if (r.id !== undefined) parts.push(`(id ${String(r.id)})`);
  if (typeof r.size === 'number') parts.push(`${r.size} GB`);
  if (typeof r.ip === 'string') parts.push(r.ip);
  const type = (r.server_type as { name?: unknown } | undefined)?.name;
  if (typeof type === 'string') parts.push(`type ${type}`);
  if (typeof r.created === 'string') parts.push(`created ${r.created.slice(0, 10)}`);
  return parts.length ? `${kind.replace(/_/g, ' ')} ${parts.join(' ')}` : undefined;
}
