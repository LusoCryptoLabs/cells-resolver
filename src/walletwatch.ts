import { ccc } from '@ckb-ccc/core'
import type { Hex, PqNetwork } from 'cellula-sdk'

/**
 * Watching the wallet lock a name's owner actually obeys.
 *
 * The quantum lock has a watch because this project chose it (decision 0016). This one is
 * here for the opposite reason: nobody chose it. JoyID is the wallet lock the SDK derives,
 * so for almost every owner it is the code standing between them and their name, and like
 * every upgradable script on CKB, this project's own included, it sits behind type ids its
 * maintainers can upgrade. A watch turns an upgrade from a surprise into a line in
 * `/health`, which is all a watch is for.
 *
 * It is not one script. JoyID is five code cells, each under its own type id. So the
 * thing worth comparing is the set: every cell's code hashed, sorted by type id so the
 * order the library happens to list them in cannot change the answer, and those hashes
 * hashed together into one fingerprint.
 *
 * Two things this is careful about, both learned from the quantum watch:
 *
 *   - it follows the type id when a cell is not where the library says it is, so "moved"
 *     and "changed" are different answers. On mainnet, today, all five have moved: the
 *     outpoints @ckb-ccc/core 1.12.5 carries are spent. That is worth its own line in the
 *     state, because a transaction built with those deps would be rejected by the node.
 *   - a node that will not answer has said nothing, so the previous verdict stands and
 *     the state says when the last real look happened.
 */

/** The type id script, which is how a cell is followed across an upgrade. */
const TYPE_ID = '0x00000000000000000000000000000000000000000000000000545950455f4944'

/**
 * The fingerprints as they were on 2026-09-12, read from the chain and reproduced by
 * following every type id. A change here should arrive as a diff somebody has to
 * approve, not as a value the program quietly learns from whatever it finds.
 */
export const JOYID_FINGERPRINT: Record<PqNetwork, Hex> = {
  testnet: '0x43eda867566d643e59ef52865a97bb33da684d4fdace98afdf2235e4ff4808cb',
  mainnet: '0x286c05938b1b3c79a501b5cbb955d4776ff2d63a433d52626644c7166512ceae',
}

export type WalletVerdict = 'unchanged' | 'changed' | 'gone' | 'unchecked'

export interface WalletState {
  network: PqNetwork
  wallet: 'joyid'
  verdict: WalletVerdict
  /** What we recorded, above. */
  expected: Hex
  /** What is deployed now, or null when the last look failed. */
  actual: Hex | null
  /** How many code cells were found, and how many are no longer where the library says. */
  parts: number
  moved: number
  checkedAt: number
  triedAt: number
  error: string
}

async function fingerprint(client: ccc.Client): Promise<{ hash: Hex; parts: number; moved: number } | null> {
  const info = await client.getKnownScript(ccc.KnownScript.JoyId)
  const hashes: Array<{ typeId: string; hash: Hex }> = []
  let moved = 0

  for (const dep of info.cellDeps) {
    const out = dep.cellDep.outPoint
    let data = (await client.getCellLive({ txHash: out.txHash, index: out.index }, true))?.outputData
    if (data === undefined && dep.type?.args) {
      // Spent. The type id survives an upgrade, so it says where the code went.
      const type = ccc.Script.from({ codeHash: TYPE_ID, hashType: 'type', args: dep.type.args })
      for await (const cell of client.findCells({ script: type, scriptType: 'type', scriptSearchMode: 'exact' }, 'asc', 2)) {
        data = cell.outputData
        break
      }
      moved++
    }
    if (data === undefined) return null // a cell we cannot account for at all
    hashes.push({ typeId: String(dep.type?.args ?? ''), hash: ccc.hashCkb(data) as Hex })
  }
  if (hashes.length === 0) return null

  return { hash: combineCodeHashes(hashes), parts: hashes.length, moved }
}

/**
 * One fingerprint from many code cells, sorted by type id first.
 *
 * The sort is the point. The library lists the deps in whatever order it was written in,
 * and a future version reordering them must not read as JoyID having changed: a watch
 * that cries wolf once is a watch that gets muted. Sorting by the one thing that is
 * stable across an upgrade, the type id, makes the answer depend on the code alone.
 */
export function combineCodeHashes(parts: Array<{ typeId: string; hash: Hex }>): Hex {
  const sorted = [...parts].sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0))
  return ccc.hashCkb(ccc.bytesConcat(...sorted.map((p) => ccc.bytesFrom(p.hash)))) as Hex
}

export class WalletWatch {
  private states = new Map<PqNetwork, WalletState>()
  private clients = new Map<PqNetwork, ccc.Client>()
  private running = false

  add(network: PqNetwork, client: ccc.Client): void {
    this.clients.set(network, client)
    this.states.set(network, {
      network,
      wallet: 'joyid',
      verdict: 'unchecked',
      expected: JOYID_FINGERPRINT[network],
      actual: null,
      parts: 0,
      moved: 0,
      checkedAt: 0,
      triedAt: 0,
      error: '',
    })
  }

  async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (const [network, client] of this.clients) {
        const prev = this.states.get(network)!
        const now = Date.now()
        try {
          const found = await fingerprint(client)
          if (!found) {
            this.states.set(network, { ...prev, verdict: 'gone', actual: null, checkedAt: now, triedAt: now, error: '' })
            console.error(`[wallet] ${network}: a JoyID code cell is neither where it was nor findable by its type id`)
            continue
          }
          const verdict: WalletVerdict = found.hash === prev.expected ? 'unchanged' : 'changed'
          if (verdict === 'changed' && prev.verdict !== 'changed')
            console.error(`[wallet] ${network}: the JoyID code CHANGED. expected ${prev.expected}, found ${found.hash}`)
          else if (verdict === 'unchanged' && prev.verdict === 'unchecked')
            console.log(`[wallet] ${network}: JoyID unchanged (${found.parts} cells, ${found.moved} moved since the library was built)`)
          this.states.set(network, {
            ...prev,
            verdict,
            actual: found.hash,
            parts: found.parts,
            moved: found.moved,
            checkedAt: now,
            triedAt: now,
            error: '',
          })
        } catch (e) {
          this.states.set(network, { ...prev, triedAt: now, error: String((e as Error)?.message ?? e).slice(0, 200) })
        }
      }
    } finally {
      this.running = false
    }
  }

  list(): WalletState[] {
    return [...this.states.values()]
  }

  /** The short answer for /health: false only when something is actually wrong. */
  ok(): boolean {
    return this.list().every((s) => s.verdict === 'unchanged' || s.verdict === 'unchecked')
  }
}
