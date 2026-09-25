import { ccc } from '@ckb-ccc/core'
import { parseAccountLite, type CellsClient, type Hex, type LiveAccount, type LiveAccountLite } from 'cellula-sdk'

/**
 * Every live name, kept current by reading only what changed.
 *
 * Until 2026-09-25 each refresh read every name again, every fifteen seconds: one indexer
 * query per hundred names, and before the SDK's outpoint cache one transaction per name
 * as well (docs/SCALE.md). The cost grew with the namespace and was paid whether anything
 * had happened or not. This keeps the names by outpoint and asks, on each tick, only about
 * the blocks since the last one read: which account cells were created there and are still
 * live, and which were spent. A tick where nothing happened is one call.
 *
 * A full read still runs, first and then on a slow clock, because an incremental view can
 * drift (a reorg deeper than the overlap, a node that answered wrong) and needs a truth
 * pass. Each full read counts the names the ticks had wrong, so drift is measured rather
 * than assumed.
 */

/** What this needs from a node; an interface so the logic can be tested on a fake chain. */
export interface NameChain {
  /** The last block the indexer has, so a range never asks past what it can answer. */
  indexerTip(): Promise<number>
  /** Account cells created in blocks [from, to) that are still live. */
  createdIn(from: number, to: number): AsyncIterable<LiveAccountLite>
  /** Account cells spent in blocks [from, to), as `txHash:index`. */
  spentIn(from: number, to: number): AsyncIterable<string>
  /** Every live account cell. */
  all(): AsyncIterable<LiveAccountLite>
  /** The records of these cells; a cell whose records do not come back is left out. */
  hydrate(lites: LiveAccountLite[]): Promise<LiveAccount[]>
}

export const outpointKey = (o: { txHash: string; index: number }) => `${o.txHash}:${o.index}`

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}

/**
 * Blocks read again on every tick: a node that indexed a block late, or a reorg of a few
 * blocks, is caught by the next tick instead of by the next full read. About four minutes.
 */
export const OVERLAP = 24
/** Ticks that retry a cell whose records did not come back, before leaving it to a full read. */
const RETRIES = 3

export class LiveNames {
  private byOutpoint = new Map<string, LiveAccount>()
  /** Which outpoint holds each name now. The chain allows one live cell per name. */
  private byId = new Map<string, string>()
  /** Cells seen but not yet read, with how many times reading them failed. */
  private misses = new Map<string, { lite: LiveAccountLite; tries: number }>()
  private names: LiveAccount[] = []
  private running: Promise<boolean> | null = null
  private chain: NameChain
  /** The last block read, -1 before the first full read. */
  readTo = -1
  /** When the last full read finished. */
  fullAt = 0
  /** Names the ticks had wrong at the last full read; null before there were ticks to check. */
  drift: number | null = null

  // Assigned rather than a parameter property: the gateway runs its .ts under Node's
  // strip-only type removal, which cannot desugar those.
  constructor(chain: NameChain) {
    this.chain = chain
  }

  get ready(): boolean {
    return this.readTo >= 0
  }

  /** The names in the order they were read. A new array only when something changed. */
  snapshot(): LiveAccount[] {
    return this.names
  }

  /** Read every name, then whatever happened while reading. Returns whether anything changed. */
  full(): Promise<boolean> {
    return this.once(() => this.readAll())
  }

  /** Read the blocks since the last read. Returns whether anything changed. */
  tick(): Promise<boolean> {
    return this.once(() => this.readNew())
  }

  // One read at a time. A caller that stopped waiting (the server's timeout) must not start
  // a second read over the same state while the first is still running.
  private once(run: () => Promise<boolean>): Promise<boolean> {
    if (this.running) return this.running
    this.running = run().finally(() => {
      this.running = null
    })
    return this.running
  }

  private put(a: LiveAccount): void {
    const k = outpointKey(a.outPoint)
    const was = this.byId.get(a.id)
    // A newer cell for a name replaces the older one even if its spending was not seen,
    // so the set never holds two cells for one name.
    if (was && was !== k) this.byOutpoint.delete(was)
    this.byOutpoint.set(k, a)
    this.byId.set(a.id, k)
  }

  private drop(k: string): boolean {
    const a = this.byOutpoint.get(k)
    if (!a) return false
    this.byOutpoint.delete(k)
    if (this.byId.get(a.id) === k) this.byId.delete(a.id)
    return true
  }

  private async readAll(): Promise<boolean> {
    // Bring the ticks' view up to now first, so what the full read finds different is
    // their error and not just what happened since the last tick.
    if (this.ready) await this.readNew()
    const exactTo = this.readTo
    const tip = await this.chain.indexerTip()
    const kept = new Map<string, LiveAccount>()
    const missing: LiveAccountLite[] = []
    for await (const lite of this.chain.all()) {
      if (lite.label === '') continue // the root sentinel is not a name
      const k = outpointKey(lite.outPoint)
      const have = this.byOutpoint.get(k)
      if (have) kept.set(k, have)
      else missing.push(lite)
    }
    for (const a of await this.chain.hydrate(missing)) kept.set(outpointKey(a.outPoint), a)

    // What the ticks had wrong, and only that. A name created or spent while the pages
    // were being read is the chain moving, not an error, and at a thousand names a day it
    // would land inside a full read often enough to raise false alarms (the sentinela
    // emails when this is not 0). So a cell counts only if its block is one the ticks had
    // already read up to.
    if (this.ready) {
      const now = await this.chain.indexerTip()
      const spentSince = new Set<string>()
      if (now > exactTo) for await (const k of this.chain.spentIn(exactTo + 1, now + 1)) spentSince.add(k)
      let wrong = 0
      for (const [k, a] of kept) if (!this.byOutpoint.has(k) && !((a.blockNumber ?? 0) > exactTo)) wrong++
      for (const k of this.byOutpoint.keys()) if (!kept.has(k) && !spentSince.has(k)) wrong++
      this.drift = wrong
    }

    this.byOutpoint = new Map()
    this.byId = new Map()
    for (const a of kept.values()) this.put(a)
    // What did not come back now is left for the next full read, not retried every tick:
    // a cell whose records never decode would otherwise cost a round trip each time.
    this.misses = new Map(
      missing.filter((l) => !kept.has(outpointKey(l.outPoint))).map((l) => [outpointKey(l.outPoint), { lite: l, tries: RETRIES }]),
    )
    this.names = [...this.byOutpoint.values()]
    this.readTo = Math.max(this.readTo, tip)
    this.fullAt = Date.now()
    // Whatever happened while every name was being read.
    await this.readNew()
    return true
  }

  private async readNew(): Promise<boolean> {
    const tip = await this.chain.indexerTip()
    let changed = false
    if (tip > this.readTo) {
      const from = Math.max(0, this.readTo + 1 - OVERLAP)
      const to = tip + 1
      // Both questions at once: they do not depend on each other, because a range only
      // ever answers created cells that are still live, and a tick is then two round trips
      // instead of three (about 0.35 s against a public node, 2026-09-25).
      const [spent, created] = await Promise.all([collect(this.chain.spentIn(from, to)), collect(this.chain.createdIn(from, to))])
      for (const k of spent) {
        if (this.drop(k)) changed = true
        this.misses.delete(k)
      }
      for (const lite of created) {
        if (lite.label === '') continue
        const k = outpointKey(lite.outPoint)
        if (!this.byOutpoint.has(k) && !this.misses.has(k)) this.misses.set(k, { lite, tries: 0 })
      }
    }
    const due = [...this.misses.values()].filter((m) => m.tries < RETRIES)
    if (due.length) {
      for (const a of await this.chain.hydrate(due.map((m) => m.lite))) {
        const k = outpointKey(a.outPoint)
        if (!this.misses.has(k)) continue
        this.misses.delete(k)
        this.put(a)
        changed = true
      }
      for (const m of due) if (this.misses.has(outpointKey(m.lite.outPoint))) m.tries++
    }
    this.readTo = Math.max(this.readTo, tip)
    if (changed) this.names = [...this.byOutpoint.values()]
    return changed
  }
}

/** The chain as a CCC client answers it, for the namespace `cells` is pointed at. */
export function nameChain(cells: CellsClient): NameChain {
  const client = cells.client
  const script = cells.accountType()
  const search = (from: number, to: number) => ({
    script,
    scriptType: 'type' as const,
    scriptSearchMode: 'exact' as const,
    filter: { blockRange: [from, to] as [number, number] },
  })
  // Which cells a transaction spent, read once: the overlap asks about its block again on
  // every tick for the next few minutes.
  const spentBy = new Map<string, { block: number; keys: string[] }>()
  return {
    async indexerTip() {
      // Over the client's own connection, so the tip and the ranges come from one node.
      const tip = (await (client as ccc.ClientJsonRpc).requestor.request('get_indexer_tip', [])) as {
        block_number: string
      } | null
      if (!tip) throw new Error('the node has no indexer tip')
      return Number(BigInt(tip.block_number))
    },
    async *createdIn(from, to) {
      // On chain only: `findCells` also merges the client's cache of cells it has sent, and
      // takes no block range. This client sends nothing.
      for await (const c of client.findCellsOnChain({ ...search(from, to), withData: true }, 'asc', 100)) {
        const data = c.outputData as Hex
        yield {
          ...parseAccountLite(data),
          outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) },
          capacity: c.cellOutput.capacity,
          data,
        }
      }
    },
    async *spentIn(from, to) {
      for await (const t of client.findTransactions(search(from, to), 'asc', 100)) {
        if (!t.isInput) continue
        let tx = spentBy.get(t.txHash)
        if (!tx) {
          const res = await client.getTransaction(t.txHash)
          if (!res) throw new Error(`the transaction ${t.txHash} is not available`)
          tx = {
            block: Number(t.blockNumber),
            keys: res.transaction.inputs.map((i) => outpointKey({ txHash: i.previousOutput.txHash, index: Number(i.previousOutput.index) })),
          }
          spentBy.set(t.txHash, tx)
        }
        const k = tx.keys[Number(t.cellIndex)]
        if (k) yield k
      }
      for (const [h, v] of spentBy) if (v.block < from - OVERLAP) spentBy.delete(h)
    },
    all: () => cells.liveCellsLite(),
    hydrate: (lites) => cells.hydrateMany(lites),
  }
}
