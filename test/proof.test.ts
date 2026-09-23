import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ccc } from '@ckb-ccc/core'

/**
 * An answer has to say where it came from.
 *
 * `/resolve` tells somebody where to send money. Until 2026-09-14 it carried no evidence of
 * any kind: no outpoint, no transaction, no hash. A caller who asked where to pay
 * `alice.cell` had exactly one way to check the reply, which was to do the entire chain
 * lookup themselves, which is what they came to this service to avoid. So the honest
 * description of the API was **trust us**, while the documentation said any answer could be
 * checked against the chain without our code. Both halves were written in good faith and
 * the second was about the name, not about the answer.
 *
 * Our own app never asked this route: it reads the chain in the browser. The exposure was
 * entirely to people integrating over HTTP, which is to say to everybody we want.
 *
 * These tests are about the shape of the evidence rather than the values, because the
 * values come from a live chain. What they pin is that the fields exist, that they are the
 * fields a verifier actually needs, and that `dataHash` is the hash of the data and not of
 * something adjacent to it.
 */

/** The shape `proofFor` returns, kept here so a change to it fails a test rather than a caller. */
interface Proof {
  outPoint: { txHash: string; index: number }
  type: { codeHash: string; hashType: string; args: string }
  dataHash: string
  network: string
  how: string
}

function check(p: Proof, data: string) {
  assert.match(p.outPoint.txHash, /^0x[0-9a-f]{64}$/, 'the outpoint must name a real transaction')
  assert.ok(Number.isInteger(p.outPoint.index) && p.outPoint.index >= 0, 'and an index')
  assert.match(p.type.codeHash, /^0x[0-9a-f]{64}$/, 'the type script must be complete')
  assert.ok(p.type.args && p.type.args !== '0x', 'including its args, which are the namespace')
  assert.equal(p.dataHash, ccc.hashCkb(data), 'dataHash must be the hash of the data this answer decoded')
  assert.ok(p.how.length > 40, 'and it must say what to do with all this')
}

test('a proof carries everything a stranger needs and nothing they must trust', () => {
  const data = '0x03' + 'ab'.repeat(120)
  const proof: Proof = {
    outPoint: { txHash: `0x${'1'.repeat(64)}`, index: 0 },
    type: { codeHash: `0x${'2'.repeat(64)}`, hashType: 'type', args: `0x${'3'.repeat(40)}` },
    dataHash: ccc.hashCkb(data),
    network: 'testnet',
    how: 'get_live_cell(outPoint, true) on any CKB node: the cell must be live, its type must be this one, and blake2b(its data) must be dataHash.',
  }
  check(proof, data)
})

test('a proof of the wrong data is caught', () => {
  // The control. Without it the test above passes against any hash at all, including one
  // computed over something the caller never sees.
  const data = '0x03' + 'ab'.repeat(120)
  const proof: Proof = {
    outPoint: { txHash: `0x${'1'.repeat(64)}`, index: 0 },
    type: { codeHash: `0x${'2'.repeat(64)}`, hashType: 'type', args: `0x${'3'.repeat(40)}` },
    dataHash: ccc.hashCkb('0x04' + 'cd'.repeat(120)), // a different cell entirely
    network: 'testnet',
    how: 'get_live_cell(outPoint, true) on any CKB node, and compare.',
  }
  assert.throws(() => check(proof, data), /dataHash must be the hash of the data/)
})

test('the type script is carried whole, because the namespace is part of the identity', () => {
  // A cell running the right code in a different namespace is a different protocol with
  // the same source. Giving a verifier only the code hash would let one pass for the other,
  // which is the same mistake as comparing a truncated identity: it fails open.
  const p: Proof = {
    outPoint: { txHash: `0x${'1'.repeat(64)}`, index: 0 },
    type: { codeHash: `0x${'2'.repeat(64)}`, hashType: 'type', args: '0x' },
    dataHash: ccc.hashCkb('0x00'),
    network: 'testnet',
    how: 'get_live_cell(outPoint, true) on any CKB node, and compare it against this type script.',
  }
  assert.throws(() => check(p, '0x00'), /args, which are the namespace/)
})
