import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { mealIn, ownerId } from '../../../sdk/src/index.ts'

/**
 * Who fed each name's being (decision 0037), indexed as blocks arrive, so a name's page asks
 * one question instead of walking its address's history in every visitor's browser.
 *
 * A meal is a payment carrying the meal witness for a name, into the lock of that name's
 * deed: the proxy lock over its Spore, which is the name's owner while it is held as a deed
 * (decision 0036). Anyone can put a cell under that lock; only the Spore's holder can take
 * it out, so what a being eats is its holder's and goes with the deed. A payment into the
 * address the name publishes is a payment, not a meal, and a name owned by a key has no
 * being to feed. Until the evening of 2026-09-26 it was the other way round.
 *
 * Since decision 0042 a meal can also land on the deed's plate: an Omnilock cell owned by the
 * deed's lock, which anyone tops up from 1 CKB. There the meal is how much the plate grew,
 * and a transaction that also spends a cell under the deed's lock is its holder taking.
 *
 * Each block is read once, a few blocks behind the tip so a short reorganisation cannot
 * leave a meal that never happened. The name's owner is taken as it is when the block is
 * read, so a block read late (catching up) uses today's deed.
 */

export interface MealRow {
  txHash: string
  block: number
  /** Unix seconds of the block. */
  timestamp: number
  /** The name, with `.cell`. */
  to: string
  /** Shannons that reached the name's address, as a decimal string. */
  amount: string
  payer: { lockHash: string; address: string }
  note: string
}

export interface MealTx {
  hash: string
  witnesses: string[]
  /**
   * `deedLock`: the output's lock is the proxy lock a deed uses (by code hash), whatever its args.
   * `plate`: the owner id a plate lock answers to (deed.ts `plateOwnerFrom`), or null.
   */
  outputs: { lockHash: string; capacity: bigint; deedLock: boolean; plate: string | null }[]
  inputs: { txHash: string; index: number }[]
}

/** What the index asks of the chain, so it can be tested without one. */
export interface MealChain {
  tip(): Promise<number>
  block(n: number): Promise<{ timestamp: number; txs: MealTx[] } | null>
  /**
   * The lock of an input's cell: its hash, the address it reads as, whether it is a deed's
   * lock, the plate owner it answers to (or null), and the cell's capacity.
   */
  inputLock(
    op: { txHash: string; index: number },
  ): Promise<{ lockHash: string; address: string; deedLock: boolean; plate: string | null; capacity: bigint } | null>
}

interface State {
  readTo: number | null
  meals: MealRow[]
}

export class Meals {
  private byName = new Map<string, MealRow[]>()
  private seen = new Set<string>()
  readTo: number | null = null
  /** The tip the last step saw, so a caller can tell how far behind the index is. */
  tip: number | null = null
  private running = false
  private dirty = false

  /**
   * @param from the first block to read when there is no saved state: meals do not exist
   *   before it. `null` starts at the tip, for a network where none can exist yet.
   * @param path where the index is kept between restarts. A path that cannot be written (a
   *   read-only volume, a dev box) leaves the index in memory, rebuilt on every start.
   */
  private chain: MealChain
  private from: number | null
  private path: string | null
  private confirmations: number
  private perStep: number

  constructor(chain: MealChain, from: number | null, path: string | null = null, confirmations = 3, perStep = 400) {
    this.chain = chain
    this.from = from
    this.path = path
    this.confirmations = confirmations
    this.perStep = perStep
    if (!path) return
    try {
      if (existsSync(path)) {
        const s = JSON.parse(readFileSync(path, 'utf8')) as State
        this.readTo = s.readTo
        for (const m of s.meals) this.add(m)
      }
    } catch {
      // An unreadable file is started again from `from`.
    }
  }

  private add(m: MealRow) {
    const k = `${m.txHash}|${m.to}`
    if (this.seen.has(k)) return
    this.seen.add(k)
    const list = this.byName.get(m.to) ?? []
    list.push(m)
    list.sort((a, b) => b.block - a.block)
    this.byName.set(m.to, list)
    this.dirty = true
  }

  /**
   * Read the blocks since the last step, at most `perStep` of them, and keep the meals in
   * them. `holderOf` is a name's owner id now (the twenty bytes the cell keeps), or null
   * for a name that does not exist. One step at a time: a step still running is not
   * started again.
   */
  async step(holderOf: (name: string) => string | null): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const tip = await this.chain.tip()
      this.tip = tip
      const safe = tip - this.confirmations
      if (this.readTo === null) this.readTo = (this.from ?? safe) - 1
      const first = this.readTo + 1
      const last = Math.min(safe, this.readTo + this.perStep)
      if (last < first) return
      const numbers = Array.from({ length: last - first + 1 }, (_, i) => first + i)
      // Blocks are fetched eight at a time and taken in order, so `readTo` never passes a
      // block that was not read.
      for (let i = 0; i < numbers.length; i += 8) {
        const chunk = numbers.slice(i, i + 8)
        const blocks = await Promise.all(chunk.map((n) => this.chain.block(n)))
        for (let j = 0; j < chunk.length; j++) {
          const b = blocks[j]
          if (!b) throw new Error(`block ${chunk[j]} could not be read`)
          for (const tx of b.txs) await this.take(tx, chunk[j], b.timestamp, holderOf)
          this.readTo = chunk[j]
          this.dirty = true
        }
      }
    } finally {
      this.running = false
      this.save()
    }
  }

  private async take(tx: MealTx, block: number, timestamp: number, holderOf: (name: string) => string | null) {
    const meal = mealIn(tx.witnesses)
    if (!meal) return
    const owner = holderOf(meal.to)
    if (!owner) return
    // Into the deed's lock, which is the name's owner: a proxy lock whose hash the name's
    // cell keeps as its owner id. A key-owned name has a key for an owner, never this.
    const fed = (lockHash: string, deedLock: boolean) => deedLock && ownerId(lockHash as `0x${string}`) === owner
    // On the plate: a lock that answers to the same twenty bytes (decision 0042).
    const onPlate = (plate: string | null) => plate !== null && plate.toLowerCase() === owner.toLowerCase()
    let amount = tx.outputs.filter((o) => fed(o.lockHash, o.deedLock) || onPlate(o.plate)).reduce((s, o) => s + o.capacity, 0n)
    if (amount === 0n) return
    // Who paid: the first input that is not the plate. An input under the deed's own lock
    // means the holder is moving what is already inside, which is not a meal. The plate
    // itself is an input of every meal on it; what it held before is not part of the meal.
    let payer: { lockHash: string; address: string } | null = null
    for (const op of tx.inputs) {
      const l = await this.chain.inputLock(op)
      // An input that cannot be read now is read again with the block, not skipped: skipping the
      // plate would count the whole plate as the meal, for good (review of 2026-10-02).
      if (!l) throw new Error(`an input of ${tx.hash} could not be read`)
      if (fed(l.lockHash, l.deedLock)) return
      if (onPlate(l.plate)) {
        amount -= l.capacity
        continue
      }
      payer ??= { lockHash: l.lockHash, address: l.address }
    }
    if (amount <= 0n || !payer) return
    this.add({ txHash: tx.hash, block, timestamp, to: meal.to, amount: amount.toString(), payer, note: meal.note })
  }

  save() {
    if (!this.path || !this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const meals = [...this.byName.values()].flat()
      writeFileSync(this.path, JSON.stringify({ readTo: this.readTo, meals } satisfies State))
      this.dirty = false
    } catch {
      // Read-only here: the index lives in memory.
    }
  }

  /** A name's meals, newest first, `limit` of them from `offset` on. */
  list(name: string, limit = 50, offset = 0): { meals: MealRow[]; total: number } {
    const all = this.byName.get(name) ?? []
    return { meals: all.slice(offset, offset + limit), total: all.length }
  }

  stats() {
    let count = 0
    for (const l of this.byName.values()) count += l.length
    return { readTo: this.readTo, behind: this.tip !== null && this.readTo !== null ? Math.max(0, this.tip - this.readTo) : null, names: this.byName.size, meals: count }
  }
}
