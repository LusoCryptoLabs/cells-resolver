import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expiringFrom, expiringRss, stateOf } from '../src/expiring.ts'
import { GRACE_SECONDS } from 'cellula-sdk'

/**
 * The feed of names running out.
 *
 * The one thing worth testing hard is the boundary between "lapsed" and "free", because
 * getting it wrong is not cosmetic: it would send somebody to build a transaction the
 * contract refuses, up to thirty days early, and they would blame their wallet.
 */

const DAY = 86_400
const NOW = 1_800_000_000

const at = (days: number) => NOW + days * DAY
const names = [
  { label: 'soon', expiredAt: at(3) },
  { label: 'later', expiredAt: at(200) },
  { label: 'lapsed', expiredAt: at(-5) },
  { label: 'ancient', expiredAt: at(-400) },
  { label: '', expiredAt: 0 }, // the root: no label, never a name
]

test('the three states are exactly the contract’s three states', () => {
  assert.equal(stateOf(at(1), NOW), 'expiring')
  assert.equal(stateOf(at(-1), NOW), 'grace')
  assert.equal(stateOf(at(-31), NOW), 'free')
})

test('the boundary is the grace period, to the second, in both directions', () => {
  // The whole point. One second before it is still the owner's; one second after, anybody
  // may take it. A test at "about thirty days" would pass with the wrong constant.
  const lapsed = at(-10)
  const free = lapsed + GRACE_SECONDS
  assert.equal(stateOf(lapsed, free - 1), 'grace', 'a second before the grace period ends it is not free')
  assert.equal(stateOf(lapsed, free), 'free', 'the instant it ends it is')
  // And the control that the boundary is the grace period and not some other number.
  assert.equal(stateOf(lapsed, lapsed + GRACE_SECONDS - 1), 'grace')
  assert.equal(stateOf(lapsed, lapsed + GRACE_SECONDS + 1), 'free')
})

test('the root is never in the feed', () => {
  // It has no label, cannot be registered and cannot expire. A row for it would be an
  // invitation to try to take the thing the whole linked list hangs from.
  const rows = expiringFrom(names, { days: 3650, nowSeconds: NOW })
  assert.equal(
    rows.find((r) => r.label === ''),
    undefined,
  )
})

test('what has already lapsed comes first, and the window only bounds the future', () => {
  const rows = expiringFrom(names, { days: 30, nowSeconds: NOW })
  assert.deepEqual(
    rows.map((r) => r.label),
    ['ancient', 'lapsed', 'soon'],
    'sorted by expiry, and `later` is beyond a thirty-day window',
  )
  // A lapsed name is never filtered out by the window, however long ago it lapsed: it is
  // the row somebody hunting a name most wants, and a window is about the future.
  const narrow = expiringFrom(names, { days: 1, nowSeconds: NOW })
  assert.deepEqual(
    narrow.map((r) => r.label),
    ['ancient', 'lapsed'],
  )
})

test('a name in grace is never called free, and carries the date it becomes free', () => {
  const [lapsed] = expiringFrom(names, { days: 1, state: 'grace', nowSeconds: NOW })
  assert.equal(lapsed.label, 'lapsed')
  assert.equal(lapsed.state, 'grace')
  assert.equal(lapsed.freeAt, at(-5) + GRACE_SECONDS)
  assert.equal(lapsed.daysToFree, 25)
  assert.ok(lapsed.daysToExpiry < 0, 'a lapsed name counts down past zero, it does not clamp')
  // The control: the ancient one is free, and says zero days to free rather than a
  // negative number, because "free in minus 370 days" is not a thing to print.
  const [ancient] = expiringFrom(names, { days: 1, state: 'free', nowSeconds: NOW })
  assert.equal(ancient.state, 'free')
  assert.equal(ancient.daysToFree, 0)
})

test('the state filter returns only that state, and `all` returns every one', () => {
  const counts = (s: 'all' | 'expiring' | 'grace' | 'free') =>
    expiringFrom(names, { days: 3650, state: s, nowSeconds: NOW }).map((r) => r.state)
  assert.deepEqual(counts('expiring'), ['expiring', 'expiring'])
  assert.deepEqual(counts('grace'), ['grace'])
  assert.deepEqual(counts('free'), ['free'])
  assert.equal(counts('all').length, 4)
})

test('the limit takes the useful end of the list, not an arbitrary one', () => {
  const rows = expiringFrom(names, { days: 3650, limit: 2, nowSeconds: NOW })
  assert.deepEqual(
    rows.map((r) => r.label),
    ['ancient', 'lapsed'],
    'the ones somebody can act on today',
  )
})

test('a window is clamped rather than trusted', () => {
  // Nothing here is expensive, but an unbounded `days` is an unbounded answer, and an
  // answer's size should never be the caller's choice alone.
  assert.equal(expiringFrom(names, { days: 0, nowSeconds: NOW }).length > 0, true)
  assert.equal(expiringFrom(names, { days: -5, nowSeconds: NOW }).length > 0, true)
  assert.ok(expiringFrom(names, { limit: 99_999, days: 999_999, nowSeconds: NOW }).length <= 1000)
})

test('the feed reads as a feed, and says of each name what is true of it', () => {
  const rows = expiringFrom(names, { days: 3650, nowSeconds: NOW })
  const xml = expiringRss(rows, { appUrl: 'https://testnet.cellula.id', nameDomain: 'testnet.cellula.id', now: NOW })
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.equal((xml.match(/<item>/g) ?? []).length, 4)
  assert.match(xml, /ancient\.cell: free now/)
  assert.match(xml, /lapsed\.cell: lapsed, still its owner's for 25 more days/)
  assert.match(xml, /soon\.cell: expires in 3 days/)
  // A `guid` a reader can rely on: the same name at a new expiry is a new item, so a
  // renewal followed by a lapse does not silently reuse the old entry.
  assert.match(xml, /<guid isPermaLink="false">soon\.cell@\d+<\/guid>/)
})

test('a label that could break the feed is escaped, not printed', () => {
  // Labels are validated on chain and cannot contain these, but a feed that trusts that
  // is a feed that breaks the day the label rules widen.
  const xml = expiringRss(expiringFrom([{ label: 'a&b<c', expiredAt: at(-1) }], { nowSeconds: NOW }), {
    appUrl: 'https://x.test',
    nameDomain: 'x.test',
    now: NOW,
  })
  assert.ok(!xml.includes('a&b<c'), 'the raw label reached the XML')
  assert.match(xml, /a&amp;b&lt;c/)
})
