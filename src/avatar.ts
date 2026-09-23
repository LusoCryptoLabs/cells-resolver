import type { ServerResponse } from 'node:http'
import { ccc } from '@ckb-ccc/core'
import { parseProfile, coverBars, MARK_INK, MARK_TILE, type LiveAccount } from 'cellula-sdk'
import { encodePng, fillRect, rgb } from './png.ts'

/**
 * A name's picture, as an ordinary image URL.
 *
 * `<img src="https://<host>/avatar/alice.cell">` and it works: no wallet, no CKB
 * library, no knowledge that a blockchain is involved. That is the whole point. A name
 * is only useful outside our own app if the rest of the web can draw it, and the rest
 * of the web speaks `<img>`.
 *
 * A name with no published picture still answers, with the mark drawn from its id, so
 * embedding one is never a gamble on a broken image. `?fallback=none` turns that off
 * for a caller that would rather handle the absence itself.
 *
 * ## Serving someone else's bytes safely
 *
 * These bytes were written by a stranger's wallet, and they are served from the
 * resolver's own origin, so this endpoint is the one place where a hostile record could
 * matter. Three things keep it dull:
 *
 *  - the content type comes from `parseProfile`, which sniffs magic bytes and admits
 *    only PNG, JPEG, GIF and WebP. Never SVG, which is a document that can carry script;
 *  - `x-content-type-options: nosniff`, so a browser cannot decide it knows better;
 *  - a `default-src 'none'; sandbox` policy, so even a payload that somehow got treated
 *    as a document could not load, script, or navigate anything.
 */

/** How long a picture may be held. The ETag is the transaction that wrote it, so a
 *  stale copy is corrected on the first revalidation after an edit. */
const MAX_AGE = 300

const ROWS = 11
const HALF = 6
const TILE = '#2b3512'
const INK = '#cbf34d'

/**
 * The same mark the app draws, generated from the account id: 11 by 11, mirrored down
 * the middle, 66 bits of the id choosing the pattern. Kept identical to `ui/src/Mark.tsx`
 * so a name looks the same whoever is drawing it.
 *
 * It is drawn in the default colours even for a name that published its own, because
 * making a published colour readable is a contrast calculation that lives in the app;
 * duplicating it here would be two copies to keep in step. A name that cares about its
 * colour has published a picture.
 */
function markSvg(id: string, size = 128): string {
  const hex = id.replace(/^0x/, '')
  const bit = (n: number) => (parseInt(hex[n >> 2] ?? '0', 16) >> (n & 3)) & 1
  const on = (col: number, row: number) => bit(row * HALF + col) === 1
  const pad = size * 0.08
  const cell = (size - pad * 2) / ROWS
  const gap = cell * 0.08
  const side = cell - gap * 2
  const rects: string[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < ROWS; col++) {
      const src = col < HALF ? col : ROWS - 1 - col
      if (!on(src, row)) continue
      const x = (pad + col * cell + gap).toFixed(2)
      const y = (pad + row * cell + gap).toFixed(2)
      rects.push(`<rect x="${x}" y="${y}" width="${side.toFixed(2)}" height="${side.toFixed(2)}" rx="${(side * 0.2).toFixed(2)}"/>`)
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="${size}" height="${size}" fill="${TILE}"/>` +
    `<g fill="${INK}">${rects.join('')}</g></svg>`
  )
}

/**
 * The same mark, as a PNG.
 *
 * Needed because a link preview will not take SVG for `og:image`, and the mark is exactly
 * the case where there is no photograph to use instead. Drawn as flat squares at whatever
 * size is asked for, so it stays crisp rather than being an upscaled thumbnail.
 */
export function markPng(id: string, size = 512): Buffer {
  const hex = id.replace(/^0x/, '')
  const bit = (n: number) => (parseInt(hex[n >> 2] ?? '0', 16) >> (n & 3)) & 1
  const on = (col: number, row: number) => bit(row * HALF + col) === 1
  const px = new Uint8Array(size * size * 3)
  fillRect(px, size, size, 0, 0, size, size, rgb(TILE))
  const ink = rgb(INK)
  const pad = size * 0.08
  const cell = (size - pad * 2) / ROWS
  const gap = cell * 0.08
  const side = cell - gap * 2
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < ROWS; col++) {
      const src = col < HALF ? col : ROWS - 1 - col
      if (!on(src, row)) continue
      fillRect(px, size, size, pad + col * cell + gap, pad + row * cell + gap, side, side, ink)
    }
  }
  return encodePng(px, size, size)
}

/**
 * The band a name draws for itself when it has published no cover: the same idea as the
 * mark above, in the shape the top of a page wants. The geometry comes from the SDK so the
 * app and this draw one band and not two, and like the mark it keeps the default colours,
 * because making a published colour readable is the app's calculation and not this one's.
 */
function coverSvg(id: string, width = 960, height = 320): string {
  const bars = coverBars(id, width, height)
    .map((b) => `<rect x="${b.x.toFixed(2)}" y="${b.y.toFixed(2)}" width="${b.w.toFixed(2)}" height="${b.h.toFixed(2)}" rx="${(b.w * 0.18).toFixed(2)}"/>`)
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${MARK_TILE}"/>` +
    `<g fill="${MARK_INK}">${bars}</g></svg>`
  )
}

/** The same band as a PNG, for the callers that will not take SVG (link previews). */
function coverPng(id: string, width = 960, height = 320): Buffer {
  const px = new Uint8Array(width * height * 3)
  fillRect(px, width, height, 0, 0, width, height, rgb(MARK_TILE))
  const ink = rgb(MARK_INK)
  for (const b of coverBars(id, width, height)) fillRect(px, width, height, b.x, b.y, b.w, b.h, ink)
  return encodePng(px, width, height)
}

function imageHead(res: ServerResponse, type: string, len: number, etag: string) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(len),
    etag,
    'cache-control': `public, max-age=${MAX_AGE}, stale-while-revalidate=86400`,
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': 'inline',
    'cross-origin-resource-policy': 'cross-origin',
  })
}

/**
 * What the avatar route needs to answer, which is deliberately less than a live cell: a
 * name recovered from the archive has records and an id but no out point.
 */
export interface AvatarSource {
  id: string
  records: LiveAccount['records']
  /** Anything that changes exactly when the records do. */
  etagSeed: string
}

/**
 * Answer `GET /avatar/:name`. `acc` is null when nothing of that name is registered.
 * Returns false when the caller asked for a picture that is not there and did not want
 * the fallback, so the server can send its own 404 in the shape the rest of the API uses.
 */
export function avatar(
  res: ServerResponse,
  acc: AvatarSource | null,
  opts: { fallback: boolean; raster?: boolean; ifNoneMatch?: string },
): boolean {
  if (!acc) return false

  const picture = parseProfile(acc.records).avatar
  // `etagSeed` moves when, and only when, the picture could have changed: the
  // transaction that last wrote the records for a live name, the commitment itself for
  // one served out of the archive.
  const etag = `"${acc.etagSeed.slice(2, 18)}${picture ? '' : opts.raster ? '-mark-png' : '-mark'}"`

  if (opts.ifNoneMatch === etag) {
    res.writeHead(304, { etag, 'cache-control': `public, max-age=${MAX_AGE}, stale-while-revalidate=86400` })
    res.end()
    return true
  }

  if (picture) {
    const body = Buffer.from(picture.bytes)
    imageHead(res, picture.mime, body.length, etag)
    res.end(body)
    return true
  }

  if (!opts.fallback) return false

  // A link preview will not take SVG, so a caller that needs a raster asks for one. The
  // page uses the SVG, which is a tenth of the size and scales without blurring.
  if (opts.raster) {
    const body = markPng(acc.id)
    imageHead(res, 'image/png', body.length, etag)
    res.end(body)
    return true
  }
  const body = Buffer.from(markSvg(acc.id), 'utf8')
  imageHead(res, 'image/svg+xml', body.length, etag)
  res.end(body)
  return true
}

/**
 * Answer `GET /cover/:name`, the wide band across the top of a page.
 *
 * Exactly the avatar's shape, fallback included. It began without one, on the reasoning
 * that a page whose owner chose no cover should not be given a picture. That was wrong for
 * the same reason it would be wrong of the avatar: the band is not a picture invented for
 * the name, it is the name's own id drawn, the way the mark is, and it cannot be anything
 * else. Everything that embeds a cover would otherwise need the branch this route exists to
 * remove. `?fallback=none` is there for a caller that would rather have the 404.
 */
export function cover(
  res: ServerResponse,
  acc: AvatarSource | null,
  opts: { fallback: boolean; raster?: boolean; ifNoneMatch?: string },
): boolean {
  if (!acc) return false
  const picture = parseProfile(acc.records).cover
  const etag = `"${acc.etagSeed.slice(2, 18)}-cover${picture ? '' : opts.raster ? '-band-png' : '-band'}"`

  if (opts.ifNoneMatch === etag) {
    res.writeHead(304, { etag, 'cache-control': `public, max-age=${MAX_AGE}, stale-while-revalidate=86400` })
    res.end()
    return true
  }

  if (picture) {
    const body = Buffer.from(picture.bytes)
    imageHead(res, picture.mime, body.length, etag)
    res.end(body)
    return true
  }

  if (!opts.fallback) return false

  if (opts.raster) {
    const body = coverPng(acc.id)
    imageHead(res, 'image/png', body.length, etag)
    res.end(body)
    return true
  }
  const body = Buffer.from(coverSvg(acc.id), 'utf8')
  imageHead(res, 'image/svg+xml', body.length, etag)
  res.end(body)
  return true
}

/**
 * Everything a name publishes about itself, decoded, for a caller that wants the text
 * as well as the picture. The picture is described rather than inlined: it is served as
 * a real image at `/avatar/:name`, and base64 in JSON helps nobody.
 *
 * `avatar.path` is relative on purpose. An absolute URL would have to be built from the
 * request's Host header, and behind the proxy that header is the upstream's name, not
 * the public one, so it produced links to `https://resolver.local/...` that no browser
 * could load. A caller already knows the base it asked on; joining is its job.
 */
export function profileJson(acc: LiveAccount) {
  const p = parseProfile(acc.records)
  return {
    name: acc.name,
    displayName: p.name,
    bio: p.bio,
    location: p.location,
    accent: p.accent,
    avatar: {
      path: `/avatar/${acc.label}.cell`,
      published: !!p.avatar,
      type: p.avatar?.mime ?? null,
      bytes: p.avatar?.bytes.length ?? 0,
      // Where those bytes are, so anyone can check the URL against the chain itself.
      witnessOf: p.avatar ? acc.outPoint.txHash : null,
    },
    cover: {
      path: `/cover/${acc.label}.cell`,
      published: !!p.cover,
      type: p.cover?.mime ?? null,
      bytes: p.cover?.bytes.length ?? 0,
      witnessOf: p.cover ? acc.outPoint.txHash : null,
    },
    links: p.links.map((l) => ({ key: l.key, title: l.title, handle: l.handle, url: l.url })),
    other: p.other,
  }
}

/** A stable, short id for a name, used only for cache keys. */
export const shortId = (a: LiveAccount) => ccc.hexFrom(a.id).slice(2, 10)
