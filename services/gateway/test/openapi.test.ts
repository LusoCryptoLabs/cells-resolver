// The defence against the OpenAPI document drifting away from the server it claims to
// describe. It cannot import the server, which opens a socket and starts reading the
// chain the moment it is loaded, so it reads the source as text and compares the two
// lists of routes. That is enough to catch the drift that actually happens: a route
// added to the handler and to the prose list, and forgotten here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripTypeScriptTypes } from 'node:module'
import { openapiSpec } from '../src/openapi.ts'

const spec = openapiSpec('https://example.test/api', 'pudge (testnet)') as any
const source = readFileSync(join(import.meta.dirname, '../src/server.ts'), 'utf8')

/** The routes the service advertises to a person, from the INFO block in the handler. */
function advertised(): string[] {
  const block = source.slice(source.indexOf('const INFO = {'), source.indexOf("  example: 'curl"))
  return [...block.matchAll(/'(GET|POST) ([^']+)':/g)].map((m) => `${m[1]} ${m[2]}`)
}

/**
 * Routes deliberately absent from the document, each for a reason. The card is HTML
 * for a link crawler and is served to crawlers at the name's own URL, not at this
 * path; the invoice route is one call inside the LNURL flow, whose entry point is the
 * lookup above it; the document does not describe itself.
 */
const NOT_DESCRIBED = new Set(['GET /card/:name', 'GET /.well-known/lnurlp/:name/invoice?amount=<msat>&comment=', 'GET /openapi.json'])

/** The advertised route written the way OpenAPI writes it: `:name` becomes `{name}`. */
function asSpecPath(route: string): { method: string; path: string } {
  const [method, rest] = route.split(' ')
  const path = rest.split('?')[0].replace(/:([a-zA-Z]+)/g, '{$1}')
  return { method: method.toLowerCase(), path }
}

test('the server file is syntactically whole', () => {
  // This suite reads the handler as text, so a syntax error in it would pass every
  // check below and fail only on the next deploy, which is how a stray apostrophe
  // inside a single-quoted string got through once. Node's own stripper parses it.
  // Not `node --check`, which reads a .ts file as JavaScript and so judges nothing.
  assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: 'strip' }))
})

test('every route the service advertises is in the document', () => {
  const missing: string[] = []
  for (const route of advertised()) {
    if (NOT_DESCRIBED.has(route)) continue
    const { method, path } = asSpecPath(route)
    if (!spec.paths[path]?.[method]) missing.push(`${method.toUpperCase()} ${path}`)
  }
  assert.deepEqual(missing, [], 'described nowhere in openapi.ts')
})

test('the document describes nothing the service does not advertise', () => {
  const known = new Set(advertised().map((r) => JSON.stringify(asSpecPath(r))))
  const extra: string[] = []
  for (const [path, methods] of Object.entries<any>(spec.paths))
    for (const method of Object.keys(methods)) if (!known.has(JSON.stringify({ method, path }))) extra.push(`${method.toUpperCase()} ${path}`)
  assert.deepEqual(extra, [], 'in the document but not served')
})

test('the handler answers every path the document names', () => {
  // The handler dispatches on the first path segment, so each documented path must have
  // its segment somewhere in the source. A path nobody routes would pass typechecking
  // and fail only in front of whoever generated a client from this.
  const unrouted = Object.keys(spec.paths)
    .map((p) => p.split('/').filter(Boolean)[0])
    .filter((seg) => seg && !seg.startsWith('{'))
    // Most are matched as a path segment, `seg[0] === 'resolve'`; the two that accept a
    // body are matched on the whole path, `path === '/report'`. Either counts as routed.
    .filter((seg) => !source.includes(`'${seg}'`) && !source.includes(`'/${seg}'`))
  assert.deepEqual([...new Set(unrouted)], [])
})

test('it is a well formed document that a generator can read', () => {
  assert.equal(spec.openapi, '3.1.0')
  assert.ok(spec.info.title && spec.info.version)
  assert.equal(spec.servers[0].url, 'https://example.test/api')
  const ids = new Set<string>()
  for (const [path, methods] of Object.entries<any>(spec.paths)) {
    for (const [method, op] of Object.entries<any>(methods)) {
      assert.ok(op.operationId, `${method} ${path} has no operationId`)
      assert.ok(!ids.has(op.operationId), `operationId ${op.operationId} is used twice`)
      ids.add(op.operationId)
      assert.ok(op.summary, `${method} ${path} has no summary`)
      assert.ok(Object.keys(op.responses ?? {}).length > 0, `${method} ${path} documents no response`)
      for (const [code, r] of Object.entries<any>(op.responses)) assert.ok(r.description, `${method} ${path} ${code} has no description`)
      // A path parameter must be declared, or a generated client cannot fill it in.
      for (const m of path.matchAll(/\{(\w+)\}/g))
        assert.ok(
          (op.parameters ?? []).some((p: any) => p.name === m[1] && p.in === 'path'),
          `${method} ${path} does not declare ${m[1]}`,
        )
    }
  }
  // It travels as JSON, so it must survive the trip.
  assert.ok(JSON.parse(JSON.stringify(spec)))
})

test('the site host is answered before the API can, whatever the method', () => {
  // Decision 0024: on SITE_DOMAIN there is exactly one thing to ask for, a name. That held
  // for GET and for nothing else until 2026-09-16, because the method gate ran before the
  // host was looked at, so a HEAD or a POST there was answered by the API in JSON. This
  // pins the order: the host is read, and the site host's own refusal exists, before the
  // first JSON 405 the API sends. Order in the source is what it proves; the behaviour was
  // checked live with a HEAD, a POST and a GET on the host, against the API host as control.
  const gate = source.indexOf("send(res, 405, { error: 'method not allowed' })")
  const hostRead = source.indexOf('const onSiteHost =')
  const siteRefusal = source.indexOf("sitePlain(res, 405, 'Only GET here.')")
  assert.ok(gate > 0, 'the API no longer refuses a method anywhere; this test needs rewriting')
  assert.ok(hostRead > 0 && hostRead < gate, 'the host is read after the API has already refused the method')
  assert.ok(siteRefusal > 0 && siteRefusal < gate, 'the site host has no refusal of its own before the API answers')
  // HEAD is let through on the site host: a link checker sends it, and Node drops the body itself.
  assert.ok(source.includes("req.method !== 'GET' && req.method !== 'HEAD'"), 'HEAD is no longer accepted on the site host')
})
