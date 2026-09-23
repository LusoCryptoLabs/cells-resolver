// The market route exists for one reason: it carries the disputes policy where a raw
// chain scan cannot. So that is what is tested hardest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { marketRows } from '../src/market.ts'

const name = (label: string, ownerLockHash: string, expiredAt = 1_900_000_000) =>
  ({ label, ownerLockHash, expiredAt }) as never

const offer = (priceCkb: number, seller = '0xseller') =>
  ({
    seller,
    sellerLock: {} as never,
    priceShannons: BigInt(Math.round(priceCkb * 1e8)),
    priceCkb,
    toSeller: priceCkb * 0.99,
    toTreasury: priceCkb * 0.01,
    outPoint: { txHash: '0xabc', index: 0 },
    capacity: 24_000_000_000n,
  }) as never

const OPEN = { withdrawn: () => null, noticeOn: () => null }

test('a name is listed when an offer points at it, and not otherwise', () => {
  const names = [name('alice', '0xa'), name('bob', '0xb')]
  const rows = marketRows(names, new Map([['0xa', offer(9000)]]), OPEN)
  assert.deepEqual(rows.map((r) => r.name), ['alice.cell'])
})

test('an offer with no live name behind it is a leftover, not a listing', () => {
  // A sale or a cancellation leaves the offer cell spent, but a scan that runs between
  // blocks can still see one whose name has moved on. Showing it would put a row on a
  // marketplace for something nobody can buy.
  const rows = marketRows([name('alice', '0xa')], new Map([['0xa', offer(9000)], ['0xghost', offer(1)]]), OPEN)
  assert.equal(rows.length, 1)
})

test('THE CONTROL: a withdrawn name leaves the market, and only that one', () => {
  // This is the whole reason the route exists. A marketplace scanning the chain would
  // keep selling a name taken down for impersonating somebody; one mirroring this
  // stops the moment the operator says so.
  const names = [name('alice', '0xa'), name('bank', '0xb')]
  const offers = new Map([
    ['0xa', offer(9000)],
    ['0xb', offer(50)],
  ])
  const open = marketRows(names, offers, OPEN)
  assert.deepEqual(open.map((r) => r.label), ['bank', 'alice'], 'both are for sale before the policy speaks')

  const after = marketRows(names, offers, { withdrawn: (l) => (l === 'bank' ? { claim: 'impersonation' } : null) })
  assert.deepEqual(after.map((r) => r.label), ['alice'])
})

test('a notice is carried rather than hidden, because a notice is not a removal', () => {
  const rows = marketRows([name('alice', '0xa')], new Map([['0xa', offer(9000)]]), {
    withdrawn: () => null,
    noticeOn: (l) => (l === 'alice' ? 'trademark' : null),
  })
  assert.equal(rows[0].notice, 'trademark')
  assert.equal(marketRows([name('alice', '0xa')], new Map([['0xa', offer(9000)]]), OPEN)[0].notice, null)
})

test('cheapest first, and the order does not wander between calls', () => {
  const names = [name('c', '0xc'), name('a', '0xa'), name('b', '0xb')]
  const offers = new Map([
    ['0xc', offer(100)],
    ['0xa', offer(100)],
    ['0xb', offer(5)],
  ])
  const once = marketRows(names, offers, OPEN).map((r) => r.label)
  assert.deepEqual(once, ['b', 'a', 'c'], 'price, then name where two ask the same')
  // The indexer does not promise an order, so the same input in another order must
  // still come back the same way round.
  const again = marketRows([...names].reverse(), offers, OPEN).map((r) => r.label)
  assert.deepEqual(again, once)
})

test('the price is carried as a string, because a price can exceed what a number holds', () => {
  // A one-letter name at the top of the schedule is already 425,000 CKB, and a seller
  // may ask far more. 2^53 shannons is about 90 million CKB; the JSON must not round.
  const big = 200_000_000
  const rows = marketRows([name('a', '0xa')], new Map([['0xa', offer(big)]]), OPEN)
  assert.equal(rows[0].priceShannons, String(BigInt(big) * 100_000_000n))
  assert.ok(Number(rows[0].priceShannons) > Number.MAX_SAFE_INTEGER, 'this case is the one that would round')
})

test('the split adds up to the price, because it is read back and not computed here', () => {
  const rows = marketRows([name('a', '0xa')], new Map([['0xa', offer(1000)]]), OPEN)
  assert.equal(rows[0].toSellerCkb + rows[0].toTreasuryCkb, rows[0].priceCkb)
})

test('a name with no label is not a name', () => {
  // The root account carries an empty label and is not for sale by anybody.
  assert.deepEqual(marketRows([name('', '0xa')], new Map([['0xa', offer(1)]]), OPEN), [])
})
