import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Sealed requests: the store behind a short link (decision 0021).
 *
 * A payment request written into a link is a thousand characters, or twenty thousand
 * when a post-quantum key signed it, which is not a link anybody sends. The short form
 * puts the request here and the key to open it in the link's fragment, which browsers
 * do not send to servers. So this holds ciphertext under a name derived from that key,
 * and can read none of it: no IBAN, no amount, no name, not even which name.
 *
 * That makes it storage for strangers, which needs limits rather than good intentions:
 * a size, a lifetime, a ceiling on the whole store, and a rate per address applied by
 * the caller. Full is answered honestly rather than by evicting somebody's live link.
 */

/** A blob is base64url of nonce plus ciphertext. Sixty four kilobytes covers a
 * post-quantum signature three times over, and nothing legitimate is larger. */
const MAX_BLOB = 64 * 1024
/** Ninety days by default, and a shade over a year at most: an unpaid request that
 * old is not waiting for payment any more. */
const DEFAULT_DAYS = 90
const MAX_DAYS = 400
/** The store's own ceiling, so a stranger cannot fill the disk the resolver runs on. */
const MAX_FILES = 50_000
const MAX_BYTES = 256 * 1024 * 1024

const ID = /^[A-Za-z0-9_-]{12}$/

export interface SealedRecord {
  blob: string
  /** Unix seconds. */
  expires: number
}

export class SealedStore {
  private dir: string
  private enabled: boolean
  private files = 0
  private bytes = 0

  constructor(dir: string) {
    this.dir = dir
    this.enabled = false
    try {
      mkdirSync(dir, { recursive: true })
      this.enabled = true
      this.sweep()
    } catch (e) {
      console.error('[sealed] no store, short links are off:', String(e))
    }
  }

  get on(): boolean {
    return this.enabled
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  /** Drop what has expired and recount. Cheap at this size, and the count has to be
   * honest for the ceiling to mean anything. */
  sweep(): void {
    if (!this.enabled) return
    const now = Math.floor(Date.now() / 1000)
    let files = 0
    let bytes = 0
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      const p = join(this.dir, f)
      try {
        const rec = JSON.parse(readFileSync(p, 'utf8')) as SealedRecord
        if (!rec?.expires || rec.expires <= now) {
          rmSync(p, { force: true })
          continue
        }
        files++
        bytes += statSync(p).size
      } catch {
        rmSync(p, { force: true }) // unreadable is as good as gone
      }
    }
    this.files = files
    this.bytes = bytes
  }

  /**
   * Hold a sealed request. The id is a hash of the key, so only whoever holds the key
   * can name this blob: replacing one is therefore the same person, and allowed.
   */
  put(id: string, blob: string, days?: number): { ok: true; expires: number } | { ok: false; code: number; error: string } {
    if (!this.enabled) return { ok: false, code: 503, error: 'this resolver is not holding short links' }
    if (!ID.test(id)) return { ok: false, code: 400, error: 'that is not a short-link name' }
    if (typeof blob !== 'string' || !/^[A-Za-z0-9_-]+$/.test(blob))
      return { ok: false, code: 400, error: 'a sealed request is base64url and nothing else' }
    if (blob.length > MAX_BLOB) return { ok: false, code: 413, error: 'a sealed request is at most sixty four kilobytes' }
    const d = Math.min(MAX_DAYS, Math.max(1, Math.floor(Number(days ?? DEFAULT_DAYS)) || DEFAULT_DAYS))
    const expires = Math.floor(Date.now() / 1000) + d * 86_400
    const already = existsSync(this.pathFor(id))
    if (!already && (this.files >= MAX_FILES || this.bytes >= MAX_BYTES)) {
      this.sweep()
      if (this.files >= MAX_FILES || this.bytes >= MAX_BYTES)
        return { ok: false, code: 507, error: 'this resolver is holding as many short links as it can; use the long link' }
    }
    try {
      const body = JSON.stringify({ v: 1, blob, expires })
      writeFileSync(this.pathFor(id), body)
      if (!already) this.files++
      this.bytes += body.length
      return { ok: true, expires }
    } catch (e) {
      console.error('[sealed] could not hold', id, String(e))
      return { ok: false, code: 500, error: 'could not hold this request' }
    }
  }

  /** What is held under that name, or null: expired, never here, or unreadable. */
  get(id: string): SealedRecord | null {
    if (!this.enabled || !ID.test(id)) return null
    try {
      const rec = JSON.parse(readFileSync(this.pathFor(id), 'utf8')) as SealedRecord
      if (!rec?.blob || !rec.expires || rec.expires <= Math.floor(Date.now() / 1000)) return null
      return { blob: rec.blob, expires: rec.expires }
    } catch {
      return null
    }
  }

  stats(): { on: boolean; held: number; bytes: number } {
    return { on: this.enabled, held: this.files, bytes: this.bytes }
  }
}
