import { ccc } from '@ckb-ccc/core'
import { SPHINCS_LOCK, type Hex, type PqNetwork } from 'cellula-sdk'

/**
 * Watching the lock a quantum-owned name obeys (decision 0016).
 *
 * Our contract enforces no algorithm: an owner action needs a transaction that spends a
 * cell under the owner's lock, and CKB-VM runs whatever code that lock names. On mainnet
 * the SPHINCS+ lock names a **type id**, so its maintainers can upgrade the code behind
 * it, and every name behind that lock would obey the new code without anything about
 * the name changing. That is the arrangement this project chose, because the code is
 * audited and a fix reaching everyone at once is worth something, and choosing it comes
 * with the duty to notice.
 *
 * So this compares the code that is actually deployed against the hash we recorded, on
 * a slow clock. Three things it is careful about:
 *
 *   - It compares the **code's own hash**, not the outpoint. An upgrade consumes the
 *     cell and creates another, and a redeploy of identical bytes is not a change. When
 *     JoyID moved five cells in one transaction, three carried the same code.
 *   - When the outpoint has moved it follows the **type id** to wherever the code lives
 *     now, so "gone" and "changed" are different answers.
 *   - It never reports a network problem as a change. An RPC that will not answer leaves
 *     the previous verdict standing and says when it last managed to look.
 */

export type LockVerdict = 'unchanged' | 'changed' | 'gone' | 'unchecked'

export interface LockState {
  network: PqNetwork
  verdict: LockVerdict
  /** The code hash we recorded, reproduced from source for mainnet. */
  expected: Hex
  /** What is deployed now, or null when the last look failed. */
  actual: Hex | null
  /** Where the code lives now, which moves on an upgrade. */
  outPoint: { txHash: Hex; index: number } | null
  /** Unix ms of the last successful look, and of the last attempt. */
  checkedAt: number
  triedAt: number
  /** Why the last look failed, for the health route. Empty when it did not. */
  error: string
}

async function look(client: ccc.Client, network: PqNetwork): Promise<{ hash: Hex; outPoint: { txHash: Hex; index: number } } | null> {
  const dep = SPHINCS_LOCK[network]
  // Where we last knew it to be.
  const here = await client.getCellLive({ txHash: dep.dep.txHash, index: dep.dep.index }, true)
  if (here?.outputData) return { hash: ccc.hashCkb(here.outputData) as Hex, outPoint: dep.dep }
  // Moved, or gone. A type id survives an upgrade, so it is the way to follow the code.
  if (!dep.typeId) return null
  const type = ccc.Script.from({
    codeHash: '0x00000000000000000000000000000000000000000000000000545950455f4944',
    hashType: 'type',
    args: dep.typeId,
  })
  for await (const cell of client.findCells({ script: type, scriptType: 'type', scriptSearchMode: 'exact' }, 'asc', 2)) {
    return {
      hash: ccc.hashCkb(cell.outputData) as Hex,
      outPoint: { txHash: cell.outPoint.txHash as Hex, index: Number(cell.outPoint.index) },
    }
  }
  return null
}

export class LockWatch {
  private states = new Map<PqNetwork, LockState>()
  private clients = new Map<PqNetwork, ccc.Client>()
  private running = false

  /**
   * Watch one network's lock with the client that can see it. The resolver watches its
   * own network always, and mainnet as well while it runs on testnet, because the point
   * of a watch is to be running before it is needed.
   */
  add(network: PqNetwork, client: ccc.Client): void {
    this.clients.set(network, client)
    this.states.set(network, {
      network,
      verdict: 'unchecked',
      expected: SPHINCS_LOCK[network].dataHash,
      actual: null,
      outPoint: null,
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
          const found = await look(client, network)
          if (!found) {
            this.states.set(network, { ...prev, verdict: 'gone', actual: null, outPoint: null, checkedAt: now, triedAt: now, error: '' })
            console.error(`[lock] ${network}: the SPHINCS+ code cell is not where it was and its type id finds nothing`)
            continue
          }
          const verdict: LockVerdict = found.hash === prev.expected ? 'unchanged' : 'changed'
          if (verdict === 'changed' && prev.verdict !== 'changed')
            console.error(
              `[lock] ${network}: the SPHINCS+ code CHANGED. expected ${prev.expected}, found ${found.hash} at ${found.outPoint.txHash}:${found.outPoint.index}`,
            )
          else if (verdict === 'unchanged' && prev.verdict === 'unchecked')
            console.log(`[lock] ${network}: SPHINCS+ code unchanged (${prev.expected.slice(0, 12)}…)`)
          this.states.set(network, { ...prev, verdict, actual: found.hash, outPoint: found.outPoint, checkedAt: now, triedAt: now, error: '' })
        } catch (e) {
          // A node that will not answer has not told us anything. The last verdict stands.
          this.states.set(network, { ...prev, triedAt: now, error: String((e as Error)?.message ?? e).slice(0, 200) })
        }
      }
    } finally {
      this.running = false
    }
  }

  list(): LockState[] {
    return [...this.states.values()]
  }

  /** The short answer for /health: false only when something is actually wrong. */
  ok(): boolean {
    return this.list().every((s) => s.verdict === 'unchanged' || s.verdict === 'unchecked')
  }
}
