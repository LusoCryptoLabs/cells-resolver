import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineCodeHashes, JOYID_FINGERPRINT, WalletWatch } from '../src/walletwatch.ts'

const A = { typeId: '0xaa', hash: '0x1111111111111111111111111111111111111111111111111111111111111111' as const }
const B = { typeId: '0xbb', hash: '0x2222222222222222222222222222222222222222222222222222222222222222' as const }
const C = { typeId: '0xcc', hash: '0x3333333333333333333333333333333333333333333333333333333333333333' as const }

test('the order the library lists the cells in cannot change the answer', () => {
  // A future @ckb-ccc reordering its deps must not read as JoyID having been replaced.
  // A watch that cries wolf once is a watch that gets muted.
  const first = combineCodeHashes([A, B, C])
  assert.equal(combineCodeHashes([C, A, B]), first)
  assert.equal(combineCodeHashes([B, C, A]), first)
})

test('a single cell being replaced changes the fingerprint', () => {
  // The control for the test above: sorting must not be flattening real differences.
  const changed = { typeId: '0xbb', hash: '0x9999999999999999999999999999999999999999999999999999999999999999' as const }
  assert.notEqual(combineCodeHashes([A, changed, C]), combineCodeHashes([A, B, C]))
})

test('a cell moving between type ids changes the fingerprint', () => {
  // Same code, different slots. That is a different deployment and should say so.
  const swapped = [
    { typeId: '0xaa', hash: B.hash },
    { typeId: '0xbb', hash: A.hash },
    C,
  ]
  assert.notEqual(combineCodeHashes(swapped), combineCodeHashes([A, B, C]))
})

test('the two networks are recorded apart', () => {
  // They are not the same deployment, and three of five binaries matching is exactly
  // the kind of near-miss that makes one recorded value for both look reasonable.
  assert.notEqual(JOYID_FINGERPRINT.testnet, JOYID_FINGERPRINT.mainnet)
  for (const v of Object.values(JOYID_FINGERPRINT)) assert.match(v, /^0x[0-9a-f]{64}$/)
})

test('an unchecked watch is not a failing one', () => {
  // Before the first pass there is no news, and news is the only thing worth alerting
  // on. A watch that reports trouble at boot trains its reader to wait and see.
  const w = new WalletWatch()
  w.add('testnet', {} as never)
  assert.equal(w.ok(), true)
  assert.equal(w.list()[0].verdict, 'unchecked')
  assert.equal(w.list()[0].expected, JOYID_FINGERPRINT.testnet)
})

test('a node that will not answer leaves the verdict alone', async () => {
  const w = new WalletWatch()
  const broken = {
    getKnownScript: async () => {
      throw new Error('econnrefused')
    },
  }
  w.add('testnet', broken as never)
  await w.refresh()
  const s = w.list()[0]
  assert.equal(s.verdict, 'unchecked', 'silence is not a change')
  assert.equal(s.checkedAt, 0, 'and it does not count as a look')
  assert.ok(s.triedAt > 0, 'but the attempt is recorded')
  assert.match(s.error, /econnrefused/)
  assert.equal(w.ok(), true)
})
