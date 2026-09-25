// The resolver keeps its names by reading only the blocks since the last read. What it must
// get right is what a full read would have found, whatever happened on the chain meanwhile.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveNames, OVERLAP, outpointKey, type NameChain } from '../src/livenames.ts'

interface Cell {
  label: string
  id: string
  txHash: string
  index: number
  block: number
}

/** A chain of one namespace: cells created in blocks, spent in blocks, and an indexer tip. */
class FakeChain implements NameChain {
  tip = 0
  private n = 0
  live = new Map<string, Cell>()
  spent: { block: number; key: string }[] = []
  /** Outpoints whose records never decode, and ones that fail this many more times. */
  broken = new Set<string>()
  flaky = new Map<string, number>()
  /** Blocks the indexer has not answered for yet, though its tip says it has them. */
  lag = 0
  /** The fault the control plants: spends are never reported. */
  blindToSpends = false
  calls = { tip: 0, created: 0, spent: 0, all: 0, hydrated: 0 }

  private cell(label: string): Cell {
    this.n++
    return { label, id: `0x${label}`, txHash: `0xtx${this.n}`, index: 0, block: this.tip }
  }
  private byLabel(label: string): Cell | undefined {
    return [...this.live.values()].find((c) => c.label === label)
  }
  private spend(c: Cell): void {
    this.live.delete(outpointKey(c))
    this.spent.push({ block: this.tip, key: outpointKey(c) })
  }
  block(): void {
    this.tip++
  }
  register(label: string): Cell {
    const c = this.cell(label)
    this.live.set(outpointKey(c), c)
    return c
  }
  edit(label: string): Cell {
    const old = this.byLabel(label)!
    this.spend(old)
    return this.register(label)
  }
  recycle(label: string): void {
    this.spend(this.byLabel(label)!)
  }
  labels(): string[] {
    return [...this.live.values()].map((c) => c.label).filter((l) => l !== '').sort()
  }
  private lite(c: Cell) {
    return { label: c.label, id: c.id, outPoint: { txHash: c.txHash, index: c.index } } as never
  }

  async indexerTip() {
    this.calls.tip++
    return this.tip
  }
  async *createdIn(from: number, to: number) {
    this.calls.created++
    const answered = Math.min(to, this.tip + 1 - this.lag)
    for (const c of this.live.values()) if (c.block >= from && c.block < answered) yield this.lite(c)
  }
  async *spentIn(from: number, to: number) {
    this.calls.spent++
    if (this.blindToSpends) return
    const answered = Math.min(to, this.tip + 1 - this.lag)
    for (const s of this.spent) if (s.block >= from && s.block < answered) yield s.key
  }
  async *all() {
    this.calls.all++
    for (const c of this.live.values()) yield this.lite(c)
  }
  async hydrate(lites: { label: string; id: string; outPoint: { txHash: string; index: number } }[]) {
    this.calls.hydrated += lites.length
    const out = []
    for (const l of lites) {
      const k = outpointKey(l.outPoint)
      if (this.broken.has(k)) continue
      const left = this.flaky.get(k) ?? 0
      if (left > 0) {
        this.flaky.set(k, left - 1)
        continue
      }
      out.push({ label: l.label, id: l.id, outPoint: l.outPoint, records: [] })
    }
    return out as never
  }
}

const labelsOf = (names: LiveNames) => names.snapshot().map((a) => a.label).sort()

test('a full read holds every live name, without the root', async () => {
  const chain = new FakeChain()
  chain.register('')
  chain.register('alice')
  chain.block()
  chain.register('bob')
  const names = new LiveNames(chain)
  await names.full()
  assert.deepEqual(labelsOf(names), ['alice', 'bob'])
  assert.equal(names.readTo, 1)
  assert.equal(names.drift, null)
})

test('a tick reads a registration, an edit and a removal, one cell per name', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  chain.register('bob')
  const names = new LiveNames(chain)
  await names.full()
  chain.block()
  chain.register('carol')
  const edited = chain.edit('alice')
  chain.recycle('bob')
  assert.equal(await names.tick(), true)
  assert.deepEqual(labelsOf(names), ['alice', 'carol'])
  const alice = names.snapshot().find((a) => a.label === 'alice')!
  assert.equal(outpointKey(alice.outPoint), outpointKey(edited))
})

test('a tick with no new block reads nothing and keeps the same list', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  await names.full()
  const before = names.snapshot()
  const calls = { ...chain.calls }
  assert.equal(await names.tick(), false)
  assert.equal(chain.calls.created, calls.created)
  assert.equal(chain.calls.spent, calls.spent)
  assert.equal(names.snapshot(), before)
})

test('reading the same blocks again changes nothing', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  await names.full()
  chain.block()
  chain.register('bob')
  chain.edit('alice')
  await names.tick()
  const once = names.snapshot()
  for (let i = 0; i < 5; i++) {
    chain.block() // new blocks with nothing in them: the overlap re-reads the old ones
    await names.tick()
  }
  assert.deepEqual(labelsOf(names), ['alice', 'bob'])
  assert.equal(names.snapshot(), once)
})

test('a node that answers a block late is caught by the overlap', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  await names.full()
  chain.block()
  chain.register('late')
  chain.lag = 1 // the tip says block 1, the ranges do not answer for it yet
  await names.tick()
  assert.deepEqual(labelsOf(names), ['alice'])
  chain.lag = 0
  chain.block()
  await names.tick()
  assert.deepEqual(labelsOf(names), ['alice', 'late'])
})

test('records that do not come back are tried again, then left to the full read', async () => {
  const chain = new FakeChain()
  const names = new LiveNames(chain)
  await names.full()
  chain.block()
  const c = chain.register('shy')
  chain.flaky.set(outpointKey(c), 1)
  await names.tick()
  assert.deepEqual(labelsOf(names), [])
  await names.tick() // no new block, but the miss is due again
  assert.deepEqual(labelsOf(names), ['shy'])

  chain.block()
  const bad = chain.register('garbage')
  chain.broken.add(outpointKey(bad))
  for (let i = 0; i < 6; i++) await names.tick()
  const tries = chain.calls.hydrated
  await names.tick()
  assert.equal(chain.calls.hydrated, tries, 'a cell that never decodes is not asked about on every tick')
  assert.deepEqual(labelsOf(names), ['shy'])
})

test('an edit whose spend was not seen still leaves one cell for the name', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  await names.full()
  chain.blindToSpends = true
  chain.block()
  const now = chain.edit('alice')
  await names.tick()
  assert.deepEqual(
    names.snapshot().map((a) => outpointKey(a.outPoint)),
    [outpointKey(now)],
  )
})

test('a full read counts and repairs what the ticks got wrong', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  await names.full()
  // A change the ticks never saw: past the overlap before any tick ran, and spends hidden.
  chain.blindToSpends = true
  for (let i = 0; i <= OVERLAP; i++) chain.block()
  chain.recycle('alice')
  chain.register('bob')
  await names.tick()
  assert.deepEqual(labelsOf(names), ['alice', 'bob'])
  chain.blindToSpends = false
  await names.full()
  assert.deepEqual(labelsOf(names), ['bob'])
  assert.equal(names.drift, 1)
})

test('what happens during a full read is read before it ends', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  chain.register('bob')
  const names = new LiveNames(chain)
  // The chain moves while the whole set is being paged through, and the pages already
  // read do not change: bob was read before he was removed, carol is created after the
  // page she would have been on.
  const all = chain.all.bind(chain)
  chain.all = async function* () {
    const pages: never[] = []
    for await (const l of all()) pages.push(l)
    for (const l of pages) yield l
    chain.block()
    chain.register('carol')
    chain.recycle('bob')
  }
  await names.full()
  assert.deepEqual(labelsOf(names), ['alice', 'carol'])
})

test('a tick asked for while a full read runs waits for it instead of racing it', async () => {
  const chain = new FakeChain()
  chain.register('alice')
  const names = new LiveNames(chain)
  const a = names.full()
  const b = names.tick()
  assert.equal(await a, await b)
  assert.equal(chain.calls.all, 1)
})

/** Registrations, edits and removals at random, with a tick every few blocks. */
async function history(seed: number, chain: FakeChain, names: LiveNames) {
  let s = seed
  const rnd = (n: number) => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s % n
  }
  await names.full()
  for (let b = 0; b < 200; b++) {
    chain.block()
    for (let op = rnd(3); op > 0; op--) {
      const have = chain.labels()
      const r = rnd(10)
      if (r < 4 || have.length === 0) chain.register(`n${seed}-${b}-${op}`)
      else if (r < 8) chain.edit(have[rnd(have.length)])
      else chain.recycle(have[rnd(have.length)])
    }
    if (rnd(3) === 0) await names.tick()
  }
  await names.tick()
}

test('THE CONTROL: after random history, the ticks agree with a full read', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const chain = new FakeChain()
    const names = new LiveNames(chain)
    await history(seed, chain, names)
    const fromTicks = names.snapshot().map((a) => outpointKey(a.outPoint)).sort()
    const truth = [...chain.live.keys()].sort()
    assert.deepEqual(fromTicks, truth, `seed ${seed}`)
    await names.full()
    assert.equal(names.drift, 0, `seed ${seed}: the full read found nothing to repair`)
  }
})

test('and the control can fail: with spends unseen, removed names linger', async () => {
  let lingered = 0
  for (let seed = 1; seed <= 40; seed++) {
    const chain = new FakeChain()
    chain.blindToSpends = true
    const names = new LiveNames(chain)
    await history(seed, chain, names)
    const fromTicks = names.snapshot().map((a) => outpointKey(a.outPoint)).sort()
    if (fromTicks.join() !== [...chain.live.keys()].sort().join()) lingered++
  }
  assert.ok(lingered > 0, 'the property must be able to see a broken spend path')
})
