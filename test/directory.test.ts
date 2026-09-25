// The directory serves the app's Explore screen from memory instead of the app reading every
// name off a node. What it must get right is what a reader would otherwise have read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textToValue } from 'cellula-sdk'
import { directoryPage } from '../src/directory.ts'

const rec = (key: string, text: string) => ({ key, label: '', value: textToValue(text), ttl: 300 })
const name = (label: string, owner = `0x${label}`, records: ReturnType<typeof rec>[] = []) =>
  ({ label, name: `${label}.cell`, id: `0xid${label}`, ownerLockHash: owner, expiredAt: 1_900_000_000, records, outPoint: { txHash: `0xtx${label}`, index: 0 } }) as never
const offer = (priceCkb: number) => ({ priceCkb, seller: '0xs' }) as never
const OPEN = { withdrawn: () => false }
const NONE = new Map()

test('names come in label order, a page at a time, the root sentinel left out', () => {
  const names = [name('carol'), name(''), name('alice'), name('bob')]
  const p1 = directoryPage(names, NONE, { size: 2 }, OPEN)
  assert.deepEqual(p1.rows.map((r) => r.label), ['alice', 'bob'])
  assert.equal(p1.total, 3)
  assert.equal(p1.pages, 2)
  const p2 = directoryPage(names, NONE, { size: 2, page: 2 }, OPEN)
  assert.deepEqual(p2.rows.map((r) => r.label), ['carol'])
})

test('a page past the end is the last page, and sizes are bounded', () => {
  const names = [name('alice'), name('bob'), name('carol')]
  assert.equal(directoryPage(names, NONE, { size: 2, page: 9 }, OPEN).page, 2)
  assert.equal(directoryPage(names, NONE, { size: 500 }, OPEN).size, 50)
  assert.equal(directoryPage(names, NONE, { size: 0 }, OPEN).size, 10)
})

test('search is part of a label, without the .cell and without case', () => {
  const names = [name('alice'), name('malik'), name('bob')]
  const p = directoryPage(names, NONE, { q: 'ALI.cell' }, OPEN)
  assert.deepEqual(p.rows.map((r) => r.label), ['alice', 'malik'])
  assert.equal(p.count, 2)
  assert.equal(p.total, 3)
})

test('the sale filter follows the offers, and a listed row carries its price', () => {
  const names = [name('alice', '0xa'), name('bob', '0xb')]
  const p = directoryPage(names, new Map([['0xb', offer(900)]]), { sale: true }, OPEN)
  assert.deepEqual(p.rows.map((r) => [r.label, r.saleCkb]), [['bob', 900]])
})

test('the payment filter reads the records the way the app does', () => {
  const names = [name('alice', '0xa', [rec('address.309', 'ckt1q...')]), name('bob', '0xb', [rec('address.0', 'bc1q...')])]
  assert.deepEqual(directoryPage(names, NONE, { pay: 'ckb' }, OPEN).rows.map((r) => r.label), ['alice'])
  assert.deepEqual(directoryPage(names, NONE, { pay: 'btc' }, OPEN).rows.map((r) => r.label), ['bob'])
  // An unknown method is no filter at all, rather than an empty page.
  assert.equal(directoryPage(names, NONE, { pay: 'doge' }, OPEN).count, 2)
})

test('a row says what the app draws: details, methods, picture or mark, accent', () => {
  const names = [name('alice', '0xa', [rec('address.309', 'ckt1q...'), rec('profile.accent', '#11aa33')])]
  const [r] = directoryPage(names, NONE, {}, OPEN).rows
  assert.equal(r.details, 2)
  assert.deepEqual(r.methods, ['ckb'])
  assert.equal(r.avatar, false)
  assert.equal(r.accent, '#11aa33')
  assert.equal(r.outPoint, '0xtxalice:0')
})

test('THE CONTROL: a withdrawn name leaves the rows, and is still not free', () => {
  // The rows follow the disputes policy like every other route. "Nobody has this one" is
  // a claim about the chain, so a withdrawn name, which still exists there, must not be
  // offered as free: a reader would be sent to register something the contract refuses.
  const names = [name('alice'), name('mallory')]
  const policy = { withdrawn: (l: string) => l === 'mallory' }
  const p = directoryPage(names, NONE, { q: 'mallory' }, policy)
  assert.equal(p.count, 0)
  assert.equal(p.total, 1)
  assert.equal(p.exists, true)
  // and without the policy, the same query finds it: the rule is what hides it
  assert.equal(directoryPage(names, NONE, { q: 'mallory' }, OPEN).count, 1)
})

test('exists is exact, not a substring', () => {
  const names = [name('alice')]
  assert.equal(directoryPage(names, NONE, { q: 'ali' }, OPEN).exists, false)
  assert.equal(directoryPage(names, NONE, { q: 'alice' }, OPEN).exists, true)
})
