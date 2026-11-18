// The meals index: what it keeps, what it refuses, and that it never reads past what it
// was able to read. A fake chain answers only what the index asks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mealWitness, ownerId } from '../../../sdk/src/index.ts'
import { Meals, type MealChain, type MealTx } from '../src/meals.ts'

// A name's owner id is the first twenty bytes of its deed lock's hash, as the cell keeps it.
const h32 = (b: string) => `0x${b.repeat(32)}` as const
const ALICE_PAY = h32('aa')
const BOB_PAY = h32('bb')
const P = { lockHash: h32('11'), address: 'ckt1-payer', deedLock: false, plate: null, capacity: 100_00000000n }
const Q = { lockHash: h32('22'), address: 'ckt1-other', deedLock: false, plate: null, capacity: 100_00000000n }
const owners: Record<string, string> = { 'alice.cell': ownerId(ALICE_PAY), 'bob.cell': ownerId(BOB_PAY) }
const holderOf = (n: string) => owners[n] ?? null

let h = 0
type From = { lockHash: string; address: string; deedLock: boolean; plate: string | null; capacity: bigint }

function tx(opts: { to?: string; note?: string; pays: string; deedLock?: boolean; from: From }): MealTx & { from: From } {
  const hash = `0x${String(++h).padStart(64, '0')}`
  return {
    hash,
    witnesses: opts.to ? ['0x', mealWitness({ to: opts.to, note: opts.note ?? '' })] : ['0x'],
    outputs: [{ lockHash: opts.pays, capacity: 61_00000000n, deedLock: opts.deedLock ?? true, plate: null }],
    inputs: [{ txHash: hash, index: 0 }],
    from: opts.from,
  }
}

function chain(blocks: Record<number, (MealTx & { from: From })[]>, tip: number): MealChain & { asked: number[] } {
  const asked: number[] = []
  return {
    asked,
    async tip() {
      return tip
    },
    async block(n) {
      asked.push(n)
      return { timestamp: 1_700_000_000 + n, txs: blocks[n] ?? [] }
    },
    async inputLock(op) {
      for (const list of Object.values(blocks)) for (const t of list) if (t.hash === op.txHash) return t.from
      return null
    },
  }
}

test('a name keeps its own meals: not a payment elsewhere, not the holder moving it, not a plain transfer, not the payout address', async () => {
  const good = tx({ to: 'alice.cell', note: 'for the coffee', pays: ALICE_PAY, from: P })
  const elsewhere = tx({ to: 'alice.cell', pays: h32('cc'), from: P }) // names alice, pays another deed's lock
  const holderMove = tx({ to: 'alice.cell', pays: ALICE_PAY, from: { lockHash: ALICE_PAY, address: 'ckt1-alice-deed', deedLock: true, plate: null, capacity: 100_00000000n } })
  const plain = tx({ pays: ALICE_PAY, from: Q })
  const forBob = tx({ to: 'bob.cell', pays: BOB_PAY, from: Q })
  const unknown = tx({ to: 'nobody.cell', pays: ALICE_PAY, from: Q }) // no such name
  // The first rule's meal: into the address the name publishes, a plain key's lock. A
  // payment to the owner, not food for the being.
  const toPayout = tx({ to: 'alice.cell', pays: ALICE_PAY, deedLock: false, from: P })
  const m = new Meals(chain({ 10: [good, elsewhere], 11: [holderMove, plain], 12: [forBob, unknown, toPayout] }, 20), 10)
  await m.step(holderOf)
  const a = m.list('alice.cell')
  assert.deepEqual(a.meals.map((x) => x.txHash), [good.hash])
  assert.equal(a.meals[0].note, 'for the coffee')
  assert.equal(a.meals[0].payer.lockHash, P.lockHash)
  assert.equal(a.meals[0].amount, '6100000000')
  assert.equal(a.meals[0].timestamp, 1_700_000_010)
  // The control: the same blocks give bob his.
  assert.deepEqual(m.list('bob.cell').meals.map((x) => x.txHash), [forBob.hash])
  assert.equal(m.list('nobody.cell').total, 0)
})

test('it stays a few blocks behind the tip and reads each block once', async () => {
  const late = tx({ to: 'alice.cell', pays: ALICE_PAY, from: P })
  const c = chain({ 18: [late] }, 20)
  const m = new Meals(c, 15)
  await m.step(holderOf)
  assert.equal(m.readTo, 17) // tip 20, three confirmations
  assert.equal(m.list('alice.cell').total, 0) // block 18 is not safe yet
  await m.step(holderOf)
  assert.deepEqual(c.asked, [15, 16, 17]) // nothing read twice, nothing past the safe tip
})

test('catching up is bounded per step, and a block that cannot be read stops the cursor there', async () => {
  const c = chain({}, 1000)
  const m = new Meals(c, 1, null, 3, 100)
  await m.step(holderOf)
  assert.equal(m.readTo, 100)
  const broken: MealChain = { ...c, async block(n) { return n === 150 ? null : c.block(n) } }
  const m2 = new Meals(broken, 101)
  await assert.rejects(() => m2.step(holderOf))
  assert.ok((m2.readTo ?? 0) < 150, `cursor ran past an unread block: ${m2.readTo}`)
})

test('the index survives a restart, and a meal is never counted twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meals-'))
  const path = join(dir, 'meals.json')
  const good = tx({ to: 'alice.cell', pays: ALICE_PAY, from: P })
  const c = chain({ 5: [good] }, 10)
  const m = new Meals(c, 5, path)
  await m.step(holderOf)
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).meals.length, 1)
  const again = new Meals(chain({ 5: [good] }, 12), 5, path)
  assert.equal(again.readTo, 7)
  assert.equal(again.list('alice.cell').total, 1)
  await again.step(holderOf)
  assert.equal(again.list('alice.cell').total, 1)
})

test('a network where meals cannot exist yet starts at the tip', async () => {
  const c = chain({}, 500)
  const m = new Meals(c, null)
  await m.step(holderOf)
  assert.equal(m.readTo, 497)
  assert.deepEqual(c.asked, [497])
})

// Decision 0042: a meal can land on the deed's plate, an Omnilock cell owned by the deed's
// lock. The plate is an input of every meal on it, so the meal is how much it grew.
test('on a plate, a meal is how much the plate grew; the holder taking and another plate are not meals', async () => {
  const ALICE = owners['alice.cell']
  const BOB = owners['bob.cell']
  const plateIn = (owner: string, capacity: bigint) => ({ lockHash: h32('ee'), address: 'ckt1-plate', deedLock: false, plate: owner, capacity })
  const at = new Map<string, From>()
  let n = 1000
  const make = (to: string | null, ins: From[], outs: MealTx['outputs']): MealTx => {
    const hash = `0x${String(++n).padStart(64, '0')}`
    ins.forEach((f, i) => at.set(`${hash}:${i}`, f))
    return {
      hash,
      witnesses: to ? [...ins.map(() => '0x'), mealWitness({ to, note: 'a bite' })] : ins.map(() => '0x'),
      outputs: outs,
      inputs: ins.map((_, i) => ({ txHash: hash, index: i })),
    }
  }
  // A stranger tops alice's plate up from 65 to 66 CKB.
  const bite = make('alice.cell', [plateIn(ALICE, 65_00000000n), P], [
    { lockHash: h32('ee'), capacity: 66_00000000n, deedLock: false, plate: ALICE },
    { lockHash: P.lockHash, capacity: 98_99990000n, deedLock: false, plate: null },
  ])
  // The holder empties it: the deed's proxy cell is an input, the plate goes back to 65.
  const taking = make('alice.cell', [plateIn(ALICE, 80_00000000n), { lockHash: ALICE_PAY, address: 'ckt1-alice-deed', deedLock: true, plate: null, capacity: 133_00000000n }], [
    { lockHash: h32('ee'), capacity: 65_00000000n, deedLock: false, plate: ALICE },
    { lockHash: ALICE_PAY, capacity: 133_00000000n, deedLock: true, plate: null },
  ])
  // A top-up of bob's plate that names alice.
  const wrongPlate = make('alice.cell', [plateIn(BOB, 65_00000000n), Q], [
    { lockHash: h32('ef'), capacity: 70_00000000n, deedLock: false, plate: BOB },
  ])
  // A shrink that names alice (the plate refuses it on chain; the index must not count it either).
  const shrink = make('alice.cell', [plateIn(ALICE, 70_00000000n), Q], [
    { lockHash: h32('ee'), capacity: 65_00000000n, deedLock: false, plate: ALICE },
  ])
  const c: MealChain = {
    async tip() {
      return 2000
    },
    async block(b) {
      return { timestamp: 1_700_000_000 + b, txs: b === 1500 ? [bite, taking, wrongPlate, shrink] : [] }
    },
    async inputLock(op) {
      return at.get(`${op.txHash}:${op.index}`) ?? null
    },
  }
  const m = new Meals(c, 1500)
  await m.step(holderOf)
  const a = m.list('alice.cell')
  assert.deepEqual(a.meals.map((x) => x.txHash), [bite.hash])
  assert.equal(a.meals[0].amount, '100000000', 'one CKB, the growth, not the plate')
  assert.equal(a.meals[0].payer.lockHash, P.lockHash, 'the payer is the first input that is not the plate')
  assert.equal(m.list('bob.cell').total, 0)
})

test('a plate meal whose plate input cannot be read is read again later, not counted as the whole plate', async () => {
  const ALICE = owners['alice.cell']
  const hash = `0x${'7'.repeat(64)}`
  const t: MealTx = {
    hash,
    witnesses: ['0x', '0x', mealWitness({ to: 'alice.cell', note: 'a bite' })],
    outputs: [{ lockHash: h32('ee'), capacity: 413_00000000n, deedLock: false, plate: ALICE }],
    inputs: [
      { txHash: hash, index: 0 },
      { txHash: hash, index: 1 },
    ],
  }
  let readable = false
  const c: MealChain = {
    async tip() {
      return 3000
    },
    async block(b) {
      return { timestamp: 1_700_000_000 + b, txs: b === 2500 ? [t] : [] }
    },
    async inputLock(op) {
      if (op.index === 0) return readable ? { lockHash: h32('ee'), address: 'ckt1-plate', deedLock: false, plate: ALICE, capacity: 412_00000000n } : null
      return P
    },
  }
  const m = new Meals(c, 2500)
  await assert.rejects(() => m.step(holderOf), /could not be read/)
  assert.equal(m.list('alice.cell').total, 0, 'nothing recorded')
  assert.ok((m.readTo ?? 0) < 2500, 'the block is read again')
  readable = true
  await m.step(holderOf)
  assert.equal(m.list('alice.cell').meals[0]?.amount, '100000000', 'one CKB once the plate is read, not 413')
})

test('the meals come a page at a time, newest first, with the total', async () => {
  const many = Array.from({ length: 12 }, (_, i) => tx({ to: 'alice.cell', note: `bite ${i}`, pays: ALICE_PAY, from: P }))
  const blocks: Record<number, ReturnType<typeof tx>[]> = {}
  many.forEach((t, i) => (blocks[100 + i] = [t]))
  const m = new Meals(chain(blocks, 200), 100)
  await m.step(holderOf)
  const first = m.list('alice.cell', 5)
  const second = m.list('alice.cell', 5, 5)
  const last = m.list('alice.cell', 5, 10)
  assert.equal(first.total, 12)
  assert.deepEqual(first.meals.map((x) => x.note), ['bite 11', 'bite 10', 'bite 9', 'bite 8', 'bite 7'])
  assert.deepEqual(second.meals.map((x) => x.note), ['bite 6', 'bite 5', 'bite 4', 'bite 3', 'bite 2'])
  assert.deepEqual(last.meals.map((x) => x.note), ['bite 1', 'bite 0'])
  assert.equal(m.list('alice.cell', 5, 50).meals.length, 0, 'past the end is empty, not an error')
})

