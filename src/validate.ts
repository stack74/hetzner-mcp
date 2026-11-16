/**
 * Checks a request against the API reference before it is sent: does the operation
 * exist, are the query parameters and body fields known, are required fields present,
 * do types and enum values fit. This is what a typed tool per endpoint would enforce.
 */
import { readFileSync } from 'node:fs';
import type { ApiName } from './config.js';

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
}

interface Operation {
  api: ApiName;
  operationId: string;
  method: string;
  path: string;
  description: string;
  parameters: { name: string; in: string }[];
  requestBody: Schema | null;
}

interface Indexed {
  op: Operation;
  segments: string[];
  literals: number;
  /** Robot only: input names from the documentation, undefined if none are listed. */
  robotInputs?: Set<string>;
}

export type Validator = (api: ApiName, method: string, path: string, queryKeys: string[], body: unknown) => string[];

export interface Reference {
  validate: Validator;
  /** The operation a request addresses, if the reference knows it. */
  match(api: ApiName, method: string, path: string): { operationId: string; path: string } | undefined;
}

const isParam = (segment: string): boolean => segment.startsWith('{') && segment.endsWith('}');
const split = (path: string): string[] => path.split('/').filter(Boolean);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Lenient where the API coerces (numbers and numeric strings), strict on structure. */
function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  switch (expected) {
    case 'string':
      return actual === 'string' || actual === 'integer' || actual === 'number';
    case 'integer':
      return actual === 'integer' || (actual === 'string' && /^-?\d+$/.test(value as string));
    case 'number':
      return actual === 'integer' || actual === 'number' || (actual === 'string' && (value as string).trim() !== '' && !Number.isNaN(Number(value)));
    default:
      return actual === expected;
  }
}

function closest(name: string, candidates: string[]): string | undefined {
  const lower = name.toLowerCase();
  return candidates.find((c) => c.toLowerCase() === lower || c.startsWith(lower) || lower.startsWith(c) || c.replace(/_/g, '') === lower.replace(/_/g, ''));
}

function unknownField(where: string, name: string, known: string[]): string {
  const hint = closest(name, known);
  return `${where}: unknown field "${name}"${hint ? ` (did you mean "${hint}"?)` : ''}. Allowed: ${known.join(', ') || 'none'}`;
}

function checkSchema(schema: Schema | undefined, value: unknown, where: string, problems: string[]): void {
  if (!schema || problems.length >= 12) return;

  const variants = schema.oneOf ?? schema.anyOf;
  if (variants) {
    const results = variants.map((variant) => {
      const found: string[] = [];
      checkSchema(variant, value, where, found);
      return found;
    });
    if (!results.some((found) => found.length === 0)) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      problems.push(`${where}: matches none of the ${variants.length} allowed shapes; closest: ${best.join('; ')}`);
    }
    return;
  }
  if (schema.allOf) {
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf) {
      Object.assign(merged.properties!, part.properties ?? {});
      merged.required!.push(...(part.required ?? []));
    }
    checkSchema(merged, value, where, problems);
    return;
  }

  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (value === null) {
    if (types.length && !types.includes('null')) problems.push(`${where}: must not be null (expected ${types.join(' or ')})`);
    return;
  }
  const expected = types.filter((t) => t !== 'null');
  if (expected.length && !expected.some((t) => typeMatches(t, value))) {
    problems.push(`${where}: expected ${expected.join(' or ')}, got ${typeOf(value)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((allowed) => String(allowed) === String(value))) {
    problems.push(`${where}: "${String(value)}" is not allowed. Allowed: ${schema.enum.join(', ')}`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => checkSchema(schema.items, item, `${where}[${index}]`, problems));
    return;
  }
  if (typeof value === 'object' && schema.properties) {
    const record = value as Record<string, unknown>;
    const known = Object.keys(schema.properties);
    for (const name of schema.required ?? []) {
      if (record[name] === undefined) problems.push(`${where}: required field "${name}" is missing`);
    }
    for (const [name, child] of Object.entries(record)) {
      if (child === undefined) continue;
      const childSchema = schema.properties[name];
      if (childSchema) checkSchema(childSchema, child, `${where}.${name}`, problems);
      else if (typeof schema.additionalProperties === 'object') checkSchema(schema.additionalProperties, child, `${where}.${name}`, problems);
      else if (schema.additionalProperties !== true) problems.push(unknownField(where, name, known));
    }
  }
}

function robotInputs(op: Operation): Set<string> | undefined {
  const sections = [...op.description.matchAll(/## Input[^\n]*\n([\s\S]*?)(?=\n## |$)/g)];
  if (sections.length === 0) return undefined;
  const names = sections.flatMap((s) => [...s[1].matchAll(/^- ([^|\n]+?) \|/gm)].map((m) => m[1].split(/[\s([]/)[0]));
  return names.length ? new Set(names) : undefined;
}

export function createReference(specPath: string): Reference {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { operations: Operation[] };
  const index: Indexed[] = spec.operations.map((op) => {
    const segments = split(op.path);
    return { op, segments, literals: segments.filter((s) => !isParam(s)).length, robotInputs: op.api === 'robot' ? robotInputs(op) : undefined };
  });

  const matchPath = (api: ApiName, segments: string[]): Indexed[] =>
    index
      .filter((e) => e.op.api === api && e.segments.length === segments.length && e.segments.every((s, i) => isParam(s) || s === segments[i]))
      .sort((a, b) => b.literals - a.literals);

  const candidates = (api: ApiName, path: string): { segments: string[]; best: Indexed[] } => {
    const segments = split(path.replace(/\.(json|yaml)$/, ''));
    const sameShape = matchPath(api, segments);
    return { segments, best: sameShape.filter((e) => e.literals === sameShape[0]?.literals) };
  };

  const validate: Validator = (api, method, path, queryKeys, body) => {
    const { segments, best } = candidates(api, path);
    const entry = best.find((e) => e.op.method === method);

    if (!entry) {
      if (best.length) {
        return [`${method} is not available for ${best[0].op.path}. Available: ${best.map((e) => e.op.method).join(', ')}`];
      }
      const other = (['cloud', 'hetzner', 'robot'] as ApiName[]).filter((a) => a !== api).find((a) => matchPath(a, segments).length);
      if (other) {
        const use = other === 'robot' ? 'the `robot` object' : 'the `hetzner` object';
        return [`${path} does not exist in the ${api} API but in the ${other} API: use ${use}`];
      }
      const related = index.filter((e) => e.op.api === api && e.segments[0] === segments[0]).map((e) => `${e.op.method} ${e.op.path}`);
      return [
        `No operation ${method} ${path} in the ${api} API reference.` +
          (related.length ? ` Operations under /${segments[0]}: ${[...new Set(related)].slice(0, 12).join(', ')}` : ' Use hetzner_search to find the right path.'),
      ];
    }

    const { op } = entry;
    const problems: string[] = [];
    const bodyObject = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;

    if (api === 'robot') {
      // The Robot reference has no schemas, only named inputs: check the top-level names.
      const known = entry.robotInputs;
      if (known) {
        const names = method === 'GET' ? queryKeys : Object.keys(bodyObject ?? {});
        for (const name of names) {
          if (!known.has(name.replace(/\[.*$/, ''))) problems.push(unknownField(method === 'GET' ? 'query' : 'body', name, [...known]));
        }
      }
    } else {
      const knownQuery = op.parameters.filter((p) => p.in === 'query').map((p) => p.name);
      for (const name of queryKeys) {
        if (!knownQuery.includes(name)) problems.push(unknownField('query', name, knownQuery));
      }
      if (op.requestBody && method !== 'GET') {
        if (body !== undefined && body !== null && !bodyObject) problems.push(`body: expected object, got ${typeOf(body)}`);
        else checkSchema(op.requestBody, bodyObject ?? {}, 'body', problems);
      }
    }
    return problems.length ? problems.concat(`See describe('${op.operationId}') in hetzner_search for all inputs.`) : [];
  };

  return {
    validate,
    match: (api, method, path) => {
      const op = candidates(api, path).best.find((e) => e.op.method === method)?.op;
      return op && { operationId: op.operationId, path: op.path };
    },
  };
}
