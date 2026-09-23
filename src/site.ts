import type { ServerResponse } from 'node:http'
import { ccc } from '@ckb-ccc/core'
import type { LiveAccount } from 'cellula-sdk'
// The reader is the published package now, not a copy in this tree: what runs here is
// what anyone else gets from npm, so a bug found there is a bug found here.
import { readFile as ckbfsContent, cellForTypeId, typeIdOf } from 'ckbfs-reader'

/**
 * A name's own website, served from the chain (decision 0024).
 *
 * ## Why this answers on a hostname of its own
 *
 * What is served here is a document a stranger wrote. An origin is the unit of trust a
 * browser understands, so the separation from the API has to be a different host and not a
 * different path: on the API's own origin a hostile page could read whatever that origin
 * can, and that origin answers the resolver and sits beside the shop. `SITE_DOMAIN` is
 * therefore required, and nothing here answers unless the request arrived on it.
 *
 * ## What a site may do
 *
 * Almost nothing, and the policy is most of this file's reason to exist.
 *
 *  - `sandbox`, with no `allow-same-origin`, so the document lands in an opaque origin of
 *    its own. Two names served from one host cannot reach each other either.
 *  - no `allow-scripts`. A page of HTML and CSS is what it says it is when you read it;
 *    once script runs, what the page does stops being what its bytes show, and a site
 *    nobody can audit from its own bytes gives up the only thing being on chain bought it.
 *  - `default-src 'none'`, so it fetches nothing. That is not only safety: a page that
 *    loads from a server is one that server can change afterwards, and one that tells that
 *    server who is reading it. Then it is not on the chain, it merely starts there.
 *  - inline style and `data:` images are what remain, which is the whole vocabulary of a
 *    self-contained page. An earlier version of this policy forbade inline style, which
 *    reads as strict and silently threw away the page's own `<style>`.
 */

const POLICY = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const DWEB_KEY = 'dweb.ckbfs'
/** Content types a site may be served as. Anything else is a download, not a page. */
const SERVABLE = new Set(['text/html', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/json'])
/** How long a read is held. The record can change, so this is short rather than clever. */
const TTL_MS = 60_000
/** A ceiling on what is held in memory, so a big file cannot be used to grow this forever. */
const MAX_CACHED = 32

interface Cached {
  at: number
  body: Buffer
  type: string
  etag: string
}
const cache = new Map<string, Cached>()

export type SiteResult = 'served' | 'no-record' | 'unresolvable' | 'not-servable' | 'error'

/**
 * Serve `acc`'s site, or say why not. The caller decides what a refusal looks like, because
 * a resolver answering JSON and a site host answering a page want different shapes.
 */
export async function serveSite(
  client: ccc.Client,
  res: ServerResponse,
  acc: LiveAccount,
  opts: { ifNoneMatch?: string } = {},
): Promise<SiteResult> {
  const rec = acc.records.find((r) => r.key === DWEB_KEY)
  if (!rec) return 'no-record'
  let uri: string
  try {
    uri = new TextDecoder().decode(ccc.bytesFrom(rec.value))
  } catch {
    return 'unresolvable'
  }
  const typeId = typeIdOf(uri)
  if (!typeId) return 'unresolvable'

  const hit = cache.get(typeId)
  const fresh = hit && Date.now() - hit.at < TTL_MS ? hit : null
  let entry: Cached
  if (fresh) {
    entry = fresh
  } else {
    try {
      const cell = await cellForTypeId(client, typeId)
      if (!cell) return 'unresolvable'
      const file = await ckbfsContent(client, cell)
      const type = (file.contentType || 'text/html').split(';')[0].trim().toLowerCase()
      if (!SERVABLE.has(type)) return 'not-servable'
      entry = {
        at: Date.now(),
        body: Buffer.from(file.content),
        type: type.startsWith('text/') || type === 'application/json' ? `${type}; charset=utf-8` : type,
        // The type id plus the content's own hash: it moves when, and only when, the bytes do.
        etag: `"${typeId.slice(2, 18)}-${ccc.hashCkb(file.content).slice(2, 18)}"`,
      }
      if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
      cache.set(typeId, entry)
    } catch {
      return 'error'
    }
  }

  if (opts.ifNoneMatch === entry.etag) {
    res.writeHead(304, { etag: entry.etag, 'cache-control': 'public, max-age=60' })
    res.end()
    return 'served'
  }
  res.writeHead(200, {
    'content-type': entry.type,
    'content-length': String(entry.body.length),
    etag: entry.etag,
    'cache-control': 'public, max-age=60',
    'content-security-policy': POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Never in a frame on another origin: a sandboxed page is still a page somebody could
    // wrap to make it look like part of theirs.
    'x-frame-options': 'DENY',
  })
  res.end(entry.body)
  return 'served'
}

/**
 * A refusal on the site host, as a page rather than as JSON.
 *
 * Under the same policy the sites themselves get, because a reader who lands here arrived
 * expecting somebody's website and the answer should not be the one place on this host
 * that behaves differently.
 */
export function sitePlain(res: ServerResponse, code: number, text: string): void {
  const body = Buffer.from(`${text}\n`, 'utf8')
  res.writeHead(code, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'content-security-policy': POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(body)
}
