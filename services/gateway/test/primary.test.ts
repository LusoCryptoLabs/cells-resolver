import { test } from 'node:test'
import assert from 'node:assert/strict'
import { primaryBody, omniLockArgs, isEthAddress, BATCH_MAX } from '../src/primary.ts'

/**
 * `/primary` says when a name runs out, in the same words as `/resolve`.
 *
 * The thing worth pinning is not the shape but the clock: the flag has to come from the
 * moment of the answer, because the route caches the hit for a minute and a name can run
 * out inside that minute. A flag computed when the chain was read would be a minute late,
 * and nobody would ever notice which minute.
 */

const addr = 'ckt1qzda0cr08m85hc8jlnfp3zer7xulejywt49kt2rr0vthywaa50xwsq'
const t0 = Date.UTC(2026, 8, 17, 12, 0, 0) // 2026-09-17T12:00:00Z, in milliseconds
const inAYear = Math.floor(t0 / 1000) + 365 * 86400
const lastWeek = Math.floor(t0 / 1000) - 7 * 86400

test('an address with no name says so in every field, and is not expired', () => {
  assert.deepEqual(primaryBody(addr, null, t0), {
    address: addr,
    name: null,
    expiredAt: null,
    expires: null,
    expired: false,
  })
})

test('a live name carries its date three ways and is not expired', () => {
  const b = primaryBody(addr, { name: 'maria.cell', expiredAt: inAYear }, t0)
  assert.equal(b.name, 'maria.cell')
  assert.equal(b.expiredAt, inAYear)
  assert.equal(b.expires, new Date(inAYear * 1000).toISOString())
  assert.equal(b.expired, false)
})

test('a lapsed name is still returned, and says it has lapsed', () => {
  const b = primaryBody(addr, { name: 'maria.cell', expiredAt: lastWeek }, t0)
  assert.equal(b.name, 'maria.cell')
  assert.equal(b.expired, true)
})

test('the boundary matches /resolve: at the exact second it has not yet run out', () => {
  const exactly = Math.floor(t0 / 1000)
  assert.equal(primaryBody(addr, { name: 'maria.cell', expiredAt: exactly }, exactly * 1000).expired, false)
  assert.equal(primaryBody(addr, { name: 'maria.cell', expiredAt: exactly }, exactly * 1000 + 1).expired, true)
})

test('the same cached hit turns over by itself when the clock passes the date', () => {
  // This is what lets the route keep an answer for a minute and still be right.
  const hit = { name: 'maria.cell', expiredAt: Math.floor(t0 / 1000) + 30 }
  assert.equal(primaryBody(addr, hit, t0).expired, false)
  assert.equal(primaryBody(addr, hit, t0 + 31_000).expired, true)
})

/**
 * An Ethereum address asks for the name its OmniLock owns. The bytes are the ones CCC's
 * EVM signer builds, so a wallet and this route derive the same lock from the same key;
 * `scripts` in the repository's sdk prove that against CCC itself, this pins the bytes.
 */
const eth = '0xAbCdEf0123456789abcdef0123456789ABCDEF01'

test('an ethereum address is recognised in either case, and nothing else is', () => {
  assert.equal(isEthAddress(eth), true)
  assert.equal(isEthAddress(eth.toLowerCase()), true)
  assert.equal(isEthAddress('0x' + 'a'.repeat(39)), false)
  assert.equal(isEthAddress('0x' + 'g'.repeat(40)), false)
  assert.equal(isEthAddress(addr), false)
})

test('the omnilock args are one flag, the address, one mode byte, in both flavours', () => {
  const [current, older] = omniLockArgs(eth)
  const body = eth.slice(2).toLowerCase()
  assert.equal(current, `0x12${body}00`)
  assert.equal(older, `0x01${body}00`)
  assert.equal(current.length, 2 + 2 + 40 + 2)
})

test('a batch is bounded, because every uncached address is a chain read', () => {
  assert.ok(BATCH_MAX >= 20 && BATCH_MAX <= 100)
})
