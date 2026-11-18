import { ccc } from '@ckb-ccc/core'
import { CellsClient, type LiveAccount, type LiveAccountLite } from './client.ts'
import { isValidLabel, parseAccountLite, type Hex } from './codec.ts'
import { deploymentFor, type CellNetwork } from './deployments.ts'

/**
 * A `.cell` name as an address, for any app built on CCC.
 *
 * `@ckb-ccc/core` 1.23.0 added `addressResolver` to the client config (ccc#575): when
 * `Address.fromString` is given a string that is not an encoded address, it asks the
 * resolver whether it handles it and, if so, for the script it points to. This is the
 * `.cell` one. `new ccc.ClientPublicMainnet({ addressResolver: cellResolver() })` and
 * `Address.fromString('alice.cell', client)` gives the CKB address alice.cell publishes.
 *
 * A hint, then a check. The cellula.id resolver is asked where the name's cell is, which
 * saves walking the namespace, and its answer is then checked against the client the app
 * gave us: the cell is live, its type is the namespace's, its data names this label, and
 * the payout record sits in a payload whose hash the cell commits to (`parseAccount`).
 * Only then is the address inside it returned. A wrong or stale hint falls through to
 * reading the chain directly, so the hint can only speed things up, never point them
 * elsewhere. This is what pocket-node asked for (#530) before trusting a resolver.
 *
 * `undefined`, which `fromString` reports as `Address <x> not found`, for a name that is
 * unregistered, expired, withdrawn from cellula.id under its disputes policy, or without
 * a CKB payout (the reserved names publish none on purpose).
 */

/** The shape @ckb-ccc/core 1.23.0 reads from `ClientConfig.addressResolver`, spelled out so this package still builds against older cores. */
export interface CellAddressResolver {
  shouldResolve(address: string): boolean
  resolve(address: string, client: ccc.Client): Promise<ccc.ScriptLike | undefined>
}

export interface CellResolverOptions {
  /**
   * Where the hint comes from, by network. The default is cellula.id and
   * testnet.cellula.id. `null` reads the chain only, which is slower but asks nobody.
   */
  api?: ((network: CellNetwork) => string) | null
  /** How long to wait for the hint before reading the chain instead. */
  hintTimeoutMs?: number
  /** For a test, or a proxy. */
  fetch?: typeof fetch
}

const API: Record<CellNetwork, string> = {
  mainnet: 'https://cellula.id/api',
  testnet: 'https://testnet.cellula.id/api',
}

/** What the hint says: where the cell is, that there is no name, or that it will not say. */
type Hint = { kind: 'cell'; outPoint: { txHash: Hex; index: number } } | { kind: 'none' } | { kind: 'unknown' }

export function cellResolver(opts: CellResolverOptions = {}): CellAddressResolver {
  const api = opts.api === undefined ? (n: CellNetwork) => API[n] : opts.api
  const doFetch = opts.fetch ?? globalThis.fetch
  const timeoutMs = opts.hintTimeoutMs ?? 5000

  async function hint(label: string, network: CellNetwork): Promise<Hint> {
    if (!api || !doFetch) return { kind: 'unknown' }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const r = await doFetch(`${api(network)}/resolve/${encodeURIComponent(label)}.cell`, { signal: ctl.signal })
      // Not registered, or withdrawn under the disputes policy: the resolver's own answer
      // is no, and reading the chain to say yes would undo the second on purpose.
      if (r.status === 404 || r.status === 451) return { kind: 'none' }
      if (!r.ok) return { kind: 'unknown' }
      const j = (await r.json()) as { proof?: { outPoint?: { txHash?: string; index?: number | string } } }
      const op = j.proof?.outPoint
      if (!op?.txHash || op.index === undefined) return { kind: 'unknown' }
      return { kind: 'cell', outPoint: { txHash: op.txHash as Hex, index: Number(op.index) } }
    } catch {
      return { kind: 'unknown' }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The hinted cell, checked against the chain: null when it is not this name's live cell. */
  async function checked(cells: CellsClient, client: ccc.Client, label: string, outPoint: { txHash: Hex; index: number }): Promise<LiveAccount | null> {
    const cell = await client.getCellLive(outPoint, true)
    if (!cell) return null
    const type = cell.cellOutput.type
    if (!type || type.hash() !== cells.accountType().hash()) return null
    const data = cell.outputData as Hex
    let lite: LiveAccountLite
    try {
      lite = { ...parseAccountLite(data), outPoint, capacity: cell.cellOutput.capacity, data }
    } catch {
      return null
    }
    if (lite.label !== label) return null
    // The records, with the witness hashed against the commitment in the cell.
    const [acc] = await cells.hydrateMany([lite])
    return acc ?? null
  }

  async function payout(cells: CellsClient, client: ccc.Client, acc: LiveAccount): Promise<ccc.ScriptLike | undefined> {
    if (acc.expiredAt * 1000 <= Date.now()) return undefined
    const p = await cells.ckbAddressOf(acc)
    if (!p) return undefined
    // A real address parses without asking any resolver, so this cannot come back here.
    return (await ccc.Address.fromString(p.address, client)).script
  }

  return {
    shouldResolve(address: string): boolean {
      return /\.cell$/i.test(address.trim())
    },
    async resolve(address: string, client: ccc.Client): Promise<ccc.ScriptLike | undefined> {
      const label = address.trim().toLowerCase().replace(/\.cell$/, '')
      if (!isValidLabel(label)) return undefined
      const network: CellNetwork = client.addressPrefix === 'ckb' ? 'mainnet' : 'testnet'
      const cells = new CellsClient(client, deploymentFor(network))
      const h = await hint(label, network)
      if (h.kind === 'none') return undefined
      if (h.kind === 'cell') {
        const acc = await checked(cells, client, label, h.outPoint)
        if (acc) return payout(cells, client, acc)
      }
      // No hint, or one the chain did not bear out: the namespace itself.
      let acc: LiveAccount | null
      try {
        acc = await cells.getAccount(`${label}.cell`)
      } catch {
        return undefined
      }
      return acc ? payout(cells, client, acc) : undefined
    },
  }
}
