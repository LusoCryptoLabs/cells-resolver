import { accountId, DATA_HEADER_LEN, OFF_ACCOUNT, OFF_VERSION, ROOT_ID, VERSION_V3 } from 'cellula-sdk'
import { ccc } from '@ckb-ccc/core'
import type { LiveAccount } from 'cellula-sdk'

/**
 * When each name was registered.
 *
 * Nothing on the cell records this. `expiredAt` is the only date a name carries, and it
 * cannot be inverted into a registration: the term is chosen at registration and pushed
 * out again by every renewal. The cell's own out point is no better, because an edit or
 * a transfer replaces the cell, so it dates the last change rather than the first.
 *
 * So it is derived from the chain's history instead. Every transaction touching the
 * account type script, walked in ascending block order: the first block an account id
 * appears as an output is the block it was registered in. Later appearances of the same
 * id are its edits, renewals and transfers.
 *
 * The scan is incremental. The indexer's cursor is kept, so after the first pass each
 * refresh reads only what is new, and history that is already settled is never re-read.
 *
 * Known limit: a name that lapses, is cleared away, and is registered again by someone
 * else keeps its id, because the id is derived from the label. This will report its
 * first registration, not the current owner's. Recording it here rather than pretending
 * otherwise; fixing it means tracking recycles too, which nothing needs yet.
 */

const PAGE = '0x64' // 100 transactions per indexer page
const FETCH_CONCURRENCY = 8 // the scan is dominated by per-transaction reads

export interface Registration {
  id: string
  label: string
  block: number
  txHash: string
  /** Filled lazily, only for the entries actually served. */
  time?: number
}

export class Registry {
  private firstSeen = new Map<string, Registration>()
  private cursor: string | null = null
  private blockTime = new Map<number, number>()
  private scanning = false
  /** False until the first full pass finishes, so callers can say "still reading". */
  ready = false
  lastScan = 0

  // Declared and assigned rather than written as constructor parameter properties: the
  // gateway runs straight off .ts under Node's strip-only type removal, which cannot
  // desugar them ("TypeScript parameter property is not supported in strip-only mode").
  private rpc: string
  private codeHash: string
  private hashType: string

  constructor(rpc: string, codeHash: string, hashType: string) {
    this.rpc = rpc
    this.codeHash = codeHash
    this.hashType = hashType
  }

  private async call(method: string, params: unknown[]): Promise<any> {
    const r = await fetch(this.rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    })
    const j = await r.json()
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
    return j.result
  }

  /** The account id and label out of a cell's data, without decoding the whole thing. */
  private static parse(dataHex: string): { id: string; label: string } | null {
    // The v3 layout (decision 0015): a version byte, a 98-byte header, the label.
    // The id is not on the cell; it is the label's hash, and the root's is zero.
    const d = Buffer.from(dataHex.slice(2), 'hex')
    if (d.length < DATA_HEADER_LEN || d[OFF_VERSION] !== VERSION_V3) return null
    const label = d.subarray(OFF_ACCOUNT).toString('utf8')
    return { id: label === '' ? ROOT_ID : accountId(label), label }
  }

  /** Run `jobs` a few at a time, so a scan is not one round trip deep per transaction. */
  private static async pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(n, items.length) }, async () => {
        while (true) {
          const i = next++
          if (i >= items.length) return
          out[i] = await fn(items[i])
        }
      }),
    )
    return out
  }

  /**
   * Read whatever history has appeared since the last pass. Safe to call on a timer:
   * a pass already running is left alone rather than queued behind itself.
   */
  async scan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      while (true) {
        const page = await this.call('get_transactions', [
          {
            script: { code_hash: this.codeHash, hash_type: this.hashType, args: '0x' },
            script_type: 'type',
            group_by_transaction: true,
          },
          'asc',
          PAGE,
          this.cursor,
        ])
        const objs: any[] = page.objects ?? []
        if (objs.length === 0) break

        const txs = await Registry.pool(objs, FETCH_CONCURRENCY, (t: any) => this.call('get_transaction', [t.tx_hash]))
        objs.forEach((t, i) => {
          const tx = txs[i]?.transaction
          if (!tx) return
          const block = parseInt(t.block_number, 16)
          for (const [io, idx] of t.cells as [string, string][]) {
            if (io !== 'output') continue
            const data = tx.outputs_data[parseInt(idx, 16)]
            const parsed = data && Registry.parse(data)
            // The root cell carries no label and is not a registration.
            if (!parsed || !parsed.label) continue
            if (this.firstSeen.has(parsed.id)) continue
            this.firstSeen.set(parsed.id, { id: parsed.id, label: parsed.label, block, txHash: t.tx_hash })
          }
        })

        this.cursor = page.last_cursor
        // A short page means we have caught up; the cursor resumes from here next time.
        if (objs.length < 100) break
      }
      this.ready = true
      this.lastScan = Date.now()
    } catch (e) {
      console.error('[registry] scan failed:', String(e))
    } finally {
      this.scanning = false
    }
  }

  /** Block timestamps, fetched only for the blocks actually being served, then kept. */
  private async times(blocks: number[]): Promise<void> {
    const missing = [...new Set(blocks)].filter((b) => !this.blockTime.has(b))
    if (missing.length === 0) return
    await Registry.pool(missing, FETCH_CONCURRENCY, async (b) => {
      try {
        const h = await this.call('get_header_by_number', ['0x' + b.toString(16)])
        if (h?.timestamp) this.blockTime.set(b, parseInt(h.timestamp, 16))
      } catch {
        /* a header we cannot read just leaves the entry without a time */
      }
    })
  }

  /**
   * The most recently registered names, newest first, restricted to the ones still
   * live: a feed should not advertise a name that has since been cleared away.
   */
  async latest(live: LiveAccount[], limit: number): Promise<Registration[]> {
    const byId = new Map(live.map((a) => [a.id.toLowerCase(), a]))
    const rows = [...this.firstSeen.values()]
      .filter((r) => byId.has(r.id.toLowerCase()))
      .sort((a, b) => b.block - a.block)
      .slice(0, limit)
    await this.times(rows.map((r) => r.block))
    return rows.map((r) => ({ ...r, time: this.blockTime.get(r.block) }))
  }

  /** How much history is known, for /health. */
  get size(): number {
    return this.firstSeen.size
  }
}

/** Build one from a deployment record. */
export function registryFor(rpc: string, account: { codeHash: string; hashType: string }): Registry {
  return new Registry(rpc, account.codeHash, account.hashType)
}

export const hexId = (id: string) => ccc.hexFrom(id).toLowerCase()
