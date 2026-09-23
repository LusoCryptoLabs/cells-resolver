import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ccc } from '@ckb-ccc/core'
import { decodeWitness, type LiveAccount, type RecordEntry } from 'cellula-sdk'

/**
 * A content-addressed copy of what every name publishes.
 *
 * Records ride in a transaction's witness, which is not part of the live cell set, so no
 * node is obliged to keep it and no fee pays anyone to. The chain guarantees the content's
 * *integrity* forever, because the cell commits to `blake2b(records)`; it does not
 * guarantee that anyone still has the bytes.
 *
 * This closes that gap the only way it can be closed off-protocol: by keeping a copy, and
 * by making the copy worthless to lie with. Every file is named by the hash the chain
 * committed to and re-hashed on the way out, so this store can hand back the bytes a name
 * published, or nothing at all. It cannot hand back different ones. That is what makes an
 * off-protocol cache acceptable in front of an on-chain commitment: it is not trusted, it
 * is checked.
 *
 * What it buys:
 *   - a picture still renders after its witness has aged out of whatever a node keeps;
 *   - the owner (or anyone at all, holding a copy) can re-publish the identical record set
 *     and put it back in a recent block, for about 0.00002 CKB. See
 *     `sdk/scripts/reseed-live.ts`.
 *
 * What it is not: a guarantee. A guarantee costs 1 CKB per byte and is called cell data.
 */

const DIR = process.env.ARCHIVE_DIR ?? '/app/data/archive'
/** A record set larger than this is not archived; nothing legitimate approaches it. */
const MAX_PAYLOAD = 256 * 1024

export class Archive {
  private dir: string
  /** label -> the witness hash last seen on chain, so a name can be found by name. */
  private index = new Map<string, string>()
  private indexPath: string
  /** Off when the directory cannot be written (a dev box with no volume). */
  enabled = false

  constructor(dir = DIR) {
    this.dir = dir
    this.indexPath = join(dir, 'index.json')
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.writable'), '')
      this.enabled = true
      if (existsSync(this.indexPath)) {
        const j = JSON.parse(readFileSync(this.indexPath, 'utf8'))
        for (const [k, v] of Object.entries(j)) this.index.set(k, String(v))
      }
    } catch (e) {
      console.warn(`[archive] disabled, ${dir} is not writable: ${String(e)}`)
    }
  }

  private pathFor(hash: string): string {
    // The hash is 0x + 64 hex from the chain, but it arrives as a string, so it is
    // re-checked before it is ever used to build a path.
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('archive: not a commitment hash')
    return join(this.dir, `${hash.slice(2).toLowerCase()}.bin`)
  }

  /** Keep this name's record payload, if it is not already kept. */
  put(label: string, witnessHash: string, witness: string): void {
    if (!this.enabled) return
    try {
      const bytes = ccc.bytesFrom(witness as `0x${string}`)
      if (bytes.length > MAX_PAYLOAD) return
      // Never store bytes that do not hash to the name they would be filed under.
      if (ccc.hashCkb(witness as `0x${string}`) !== witnessHash) return
      const p = this.pathFor(witnessHash)
      if (!existsSync(p)) writeFileSync(p, bytes)
      if (this.index.get(label) !== witnessHash) {
        this.index.set(label, witnessHash)
        this.flush()
      }
    } catch {
      /* one unstorable name must never stop a refresh */
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.indexPath, JSON.stringify(Object.fromEntries(this.index)))
    } catch {
      /* the bytes matter more than the index; it is rebuilt on the next refresh */
    }
  }

  /**
   * The bytes filed under `witnessHash`, re-hashed before they are returned. A file that
   * does not hash to its own name is deleted rather than served: it is either corrupt or
   * something that should not be here, and either way it is not what the chain committed to.
   */
  get(witnessHash: string): Uint8Array | null {
    if (!this.enabled) return null
    try {
      const p = this.pathFor(witnessHash)
      if (!existsSync(p)) return null
      const bytes = new Uint8Array(readFileSync(p))
      if (ccc.hashCkb(bytes) !== witnessHash.toLowerCase()) {
        console.warn(`[archive] ${witnessHash.slice(0, 12)}… does not hash to its own name, dropping`)
        unlinkSync(p)
        return null
      }
      return bytes
    } catch {
      return null
    }
  }

  /** The last commitment seen for a name, whether or not the chain still serves it. */
  hashFor(label: string): string | null {
    return this.index.get(label) ?? null
  }

  /** The archived record set for a name, decoded, or null. */
  recordsFor(label: string): { records: RecordEntry[]; witnessHash: string; witness: string } | null {
    const hash = this.hashFor(label)
    if (!hash) return null
    const bytes = this.get(hash)
    if (!bytes) return null
    try {
      const witness = ccc.hexFrom(bytes)
      return { records: decodeWitness(witness).records, witnessHash: hash, witness }
    } catch {
      return null
    }
  }

  /** Take a copy of everything the snapshot can still see. Cheap: writes only new files. */
  absorb(accounts: LiveAccount[], skip?: (a: LiveAccount) => boolean): void {
    if (!this.enabled) return
    for (const a of accounts) {
      // What we were told to forget must not come back on the next refresh: the chain
      // still holds it, which is the whole point of the archive, and the whole reason
      // this exception has to be applied here rather than at read time. The caller
      // decides by content as well as by name, so the same bytes under a second name
      // are not archived either.
      if (skip?.(a)) continue
      this.put(a.label, a.witnessHash, a.witness)
    }
  }

  /**
   * Delete our copy of a name's records, for the one case where declining to serve them
   * is not enough: content we would be committing an offence by holding
   * ([DISPUTES.md](../../../docs/DISPUTES.md)). The chain keeps what it keeps; this is
   * about the bytes on our own disk. Returns true when something was actually removed.
   *
   * The file is named by the commitment, so two names can point at the same bytes. They
   * go anyway, and every name pointing at them loses its entry: the claim says these
   * bytes may not be held, and holding them for a second name would be the same offence.
   * A name that loses its copy is not harmed, it simply falls back to the chain, which is
   * where every record set lives in the first place.
   */
  forget(label: string): boolean {
    if (!this.enabled) return false
    const hash = this.index.get(label)
    if (!hash) return false
    try {
      const also = [...this.index.entries()].filter(([l, h]) => h === hash && l !== label).map(([l]) => l)
      for (const l of [label, ...also]) this.index.delete(l)
      this.flush()
      const p = this.pathFor(hash)
      if (existsSync(p)) unlinkSync(p)
      console.log(`[archive] forgot ${label}: ${hash.slice(0, 12)}… deleted${also.length ? `, and dropped ${also.join(', ')}, which pointed at the same bytes` : ''}`)
      return true
    } catch (e) {
      console.error('[archive] could not forget', label, String(e))
      return false
    }
  }

  stats(): { enabled: boolean; names: number; files: number; bytes: number } {
    if (!this.enabled) return { enabled: false, names: 0, files: 0, bytes: 0 }
    let files = 0
    let bytes = 0
    try {
      for (const f of readdirSync(this.dir)) {
        if (!f.endsWith('.bin')) continue
        files++
        bytes += statSync(join(this.dir, f)).size
      }
    } catch {
      /* stats are a nicety */
    }
    return { enabled: true, names: this.index.size, files, bytes }
  }
}
