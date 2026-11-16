#!/usr/bin/env node
// Downloads the official Hetzner OpenAPI specs and condenses them into spec/operations.json.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCES = {
  cloud: 'https://docs.hetzner.cloud/cloud.spec.json',
  hetzner: 'https://docs.hetzner.cloud/hetzner.spec.json',
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const jsonSchema = (content) => content?.['application/json']?.schema;

const apis = {};
const operations = [];
for (const [api, url] of Object.entries(SOURCES)) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const spec = await res.json();
  apis[api] = {
    baseUrl: spec.servers[0].url,
    source: url,
    overview: spec.info.description ?? '',
    tags: (spec.tags ?? []).map((t) => ({ name: t.name, description: t.description ?? '' })),
  };
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const okStatus = Object.keys(op.responses ?? {}).find((s) => s.startsWith('2'));
      operations.push({
        api,
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        summary: op.summary ?? '',
        description: op.description ?? '',
        tags: op.tags ?? [],
        deprecated: op.deprecated === true,
        parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])],
        requestBody: jsonSchema(op.requestBody?.content) ?? null,
        response: okStatus ? jsonSchema(op.responses[okStatus].content) ?? null : null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Robot webservice (dedicated servers). There is no OpenAPI spec, so the operations
// are read from the HTML documentation: <h1> = section, <h2> = "METHOD /path",
// <h3> = Description / Request limit / Input / Output / Errors.
// ---------------------------------------------------------------------------
const ROBOT_DOC = 'https://robot.hetzner.com/doc/webservice/en.html';
const ROBOT_BASE = 'https://robot-ws.your-server.de';

const decode = (text) =>
  text
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const cellsOf = (row) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1].trim());

function tableToText(inner) {
  const lines = [];
  for (const [, row] of inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    if (/<th[\s>]/.test(row) || /line-through/.test(row)) continue;
    const cells = cellsOf(row);
    if (cells.length === 0) continue;
    const last = cells[cells.length - 1];
    if (last.includes('\n')) {
      // a nested table that was already converted: indent it below its label
      lines.push(`- ${cells.slice(0, -1).join(' | ')}:`, ...last.split('\n').map((l) => `  ${l}`));
    } else {
      lines.push(`- ${cells.join(' | ')}`);
    }
  }
  return `\n${lines.join('\n')}\n`;
}

function htmlToText(html) {
  let text = html.replace(/<\/?span[^>]*>/g, '');
  const innermost = /<table[^>]*>((?:(?!<table)[\s\S])*?)<\/table>/;
  while (innermost.test(text)) text = text.replace(innermost, (_, inner) => tableToText(inner));
  text = text
    .replace(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g, (_, code) => `\n${code.trim()}\n`)
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<li>\s*(?:<p>)?/g, '\n- ')
    .replace(/<\/(p|ul|div|blockquote|aside)>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decode(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function loadRobot() {
  const res = await fetch(ROBOT_DOC);
  if (!res.ok) throw new Error(`${ROBOT_DOC}: HTTP ${res.status}`);
  const html = (await res.text()).replace(/<\/?span[^>]*>/g, '');
  const content = html.slice(html.indexOf("<h1 id='preface'>"));
  const sections = content.split(/(?=<h1 id=)/);
  const robotOps = [];
  let overview = '';
  for (const section of sections) {
    const tag = decode(section.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '').trim();
    if (tag === 'Preface') {
      overview = htmlToText(section.replace(/<h([123])[^>]*>([\s\S]*?)<\/h\1>/g, (_, level, title) => `\n\n${'#'.repeat(Number(level))} ${title}\n\n`));
      continue;
    }
    for (const block of section.split(/(?=<h2 id=)/).slice(1)) {
      const head = block.match(/<h2 id='([^']+)'>\s*(GET|POST|PUT|DELETE)\s+(\S+)\s*<\/h2>/);
      if (!head) continue;
      const [, id, method, path] = head;
      const [intro, ...parts] = block.slice(head[0].length).split(/(?=<h3 id=)/);
      const codeBlocks = [...intro.matchAll(/<pre class="highlight (\w+)[^"]*"><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => ({
        lang: m[1],
        code: decode(m[2]).trim(),
      }));
      const parts3 = parts.map((part) => {
        const m = part.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
        return { title: decode(m[1]).trim(), text: htmlToText(part.slice(m[0].length)) };
      });
      const summary = parts3.find((p) => p.title === 'Description')?.text.split('\n')[0] ?? '';
      robotOps.push({
        api: 'robot',
        operationId: `robot_${id.replace(/-/g, '_')}`,
        method,
        path,
        summary,
        description: parts3
          .filter((p) => p.title !== 'Deprecations' && p.text)
          .map((p) => `## ${p.title}\n${p.text}`)
          .join('\n\n'),
        tags: [`Robot ${tag}`],
        deprecated: false,
        parameters: [],
        requestBody: null,
        response: null,
        examples: {
          request: codeBlocks.filter((b) => b.lang === 'shell' && b.code.startsWith('curl')).map((b) => b.code).join('\n\n'),
          response: codeBlocks.filter((b) => b.lang === 'json').map((b) => b.code).join('\n\n'),
        },
      });
    }
  }
  if (robotOps.length < 50) throw new Error(`Robot documentation layout changed: only ${robotOps.length} operations found`);
  apis.robot = { baseUrl: ROBOT_BASE, source: ROBOT_DOC, overview, tags: [...new Set(robotOps.map((o) => o.tags[0]))].map((name) => ({ name, description: '' })) };
  operations.push(...robotOps);
}
await loadRobot();

const out = fileURLToPath(new URL('../spec/operations.json', import.meta.url));
mkdirSync(fileURLToPath(new URL('../spec/', import.meta.url)), { recursive: true });
writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), apis, operations }));
console.log(`Wrote ${operations.length} operations to ${out}`);
