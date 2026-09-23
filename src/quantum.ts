// Which names are owned by a post-quantum key (decision 0016), as a fact anyone can
// check rather than a claim we make.
//
// A name stores only the first twenty bytes of its owner's lock hash, so the name alone
// cannot say what kind of key that is: a hash prefix is not reversible. What can be done
// is the other direction. Every live cell locked by the SPHINCS+ script is listed from
// the indexer, each one's lock hash is taken, and the prefixes are matched against the
// owners of the names we already hold. The scan is over one code hash, so it is one
// query, and it took under two seconds for a thousand cells on the test network.
//
// Two honest limits, both of which shape what the app is allowed to say:
//   - It proves the positive only. A quantum owner that holds no live cell under that
//     lock cannot be seen this way, so a name missing from this list is "not shown to
//     be", never "is not". Our own protect flow funds the owner, so in practice it holds.
//   - It says nothing about the money. The owner key decides who can move the name; a
//     payment goes to the address the name publishes, which is an ordinary key, and a
//     manager may change that address.
import { ccc } from '@ckb-ccc/core'
import { ownerId, SPHINCS_LOCK, type Hex, type LiveAccount } from 'cellula-sdk'

/** Cells to look at in one pass. Far above what the lock holds today, and bounded. */
const MAX_CELLS = 50_000

export class Quantum {
  /** Owner ids (twenty-byte prefixes) proven to be SPHINCS+ locks, that own a name. */
  private owners = new Set<Hex>();
  /** Live cells seen in the last pass, for the health route. */
  private cells = 0
  private scannedAt = 0
  private running = false
  // Written out rather than declared in the constructor's parameters: the resolver runs
  // this file through Node's type stripping, which does not support parameter properties.
  private readonly client: ccc.Client
  private readonly network: 'testnet' | 'mainnet'

  constructor(client: ccc.Client, network: 'testnet' | 'mainnet') {
    this.client = client
    this.network = network
  }

  has(ownerLockHash: Hex): boolean {
    return this.owners.has(ownerLockHash)
  }
  /** Only the owners that hold a name: on mainnet the lock is shared with everyone. */
  list(): Hex[] {
    return [...this.owners]
  }
  stats() {
    return { owners: this.owners.size, cells: this.cells, scannedAt: this.scannedAt || null }
  }

  /**
   * One pass over the lock's live cells, matched against the names in `accounts`.
   * Never throws: an indexer that will not answer leaves the last good list in place,
   * because a badge that flickers is worse than one that lags.
   */
  async refresh(accounts: LiveAccount[]): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const wanted = new Set(accounts.map((a) => a.ownerLockHash))
      if (wanted.size === 0) return
      const lock = SPHINCS_LOCK[this.network]
      const found = new Set<Hex>()
      let n = 0
      for await (const cell of this.client.findCells(
        { script: { codeHash: lock.codeHash, hashType: lock.hashType, args: '0x' }, scriptType: 'lock', scriptSearchMode: 'prefix' },
        'asc',
        1000,
      )) {
        n++
        const id = ownerId(ccc.Script.from(cell.cellOutput.lock).hash() as Hex)
        if (wanted.has(id)) found.add(id)
        if (n >= MAX_CELLS) break
      }
      this.owners = found
      this.cells = n
      this.scannedAt = Date.now()
      console.log(`[quantum] ${found.size} of ${wanted.size} owners are post-quantum, from ${n} live cells`)
    } catch (e) {
      console.error('[quantum] scan failed, keeping the last list:', String(e))
    } finally {
      this.running = false
    }
  }
}
