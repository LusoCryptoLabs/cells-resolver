// A domain answering for a name: the parsing and the rules that decide a verdict.
//
// The fetches are not tested here, they need a network; what is tested is every decision
// that turns an answer into a verdict, because those are the ones that would be wrong
// quietly. `scripts/71-domain-proof.mjs` runs the same functions against real domains.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanDomain, reads, DomainProofs } from '../src/domainproof.ts'
import type { Hex } from 'cellula-sdk'

const OWNER = '0x58e6c6f873af57732daae458be3c56c2c847b141' as Hex
const OTHER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Hex

test('a domain is a bare host, and everything else is refused', () => {
  assert.equal(cleanDomain('lusocryptolabs.com'), 'lusocryptolabs.com')
  assert.equal(cleanDomain('  LusoCryptoLabs.COM '), 'lusocryptolabs.com')
  for (const bad of [
    'https://lusocryptolabs.com', // a URL, not a host
    'lusocryptolabs.com/path', // a path could point anywhere
    'lusocryptolabs.com:8443', // a port is another service
    '*.lusocryptolabs.com', // a wildcard answers for names nobody checked
    'localhost', // no dot, so no registrable domain
    'a..b.com',
    '',
    null,
  ])
    assert.equal(cleanDomain(bad), null, `${JSON.stringify(bad)} should not be a domain`)
})

test('the domain naming the name, plainly, is enough', () => {
  const body = '# a comment\n\nalice.cell\nbob.cell\n'
  assert.deepEqual(reads(body, 'alice.cell', OWNER), { boundTo: null, matches: true })
  assert.deepEqual(reads(body, 'bob.cell', OWNER), { boundTo: null, matches: true })
})

test('THE CONTROL: a domain that answers and does not name us is a real no', () => {
  // Not an error, not "unchecked": the domain spoke and did not vouch. Returning null
  // here is what lets the caller tell this apart from a server that was unreachable.
  assert.equal(reads('carol.cell\n', 'alice.cell', OWNER), null)
  assert.equal(reads('', 'alice.cell', OWNER), null)
  assert.equal(reads('# alice.cell\n', 'alice.cell', OWNER), null, 'a commented line is not a statement')
})

test('binding to an owner makes a sale break the proof', () => {
  const body = `alice.cell owner=${OWNER}\n`
  assert.deepEqual(reads(body, 'alice.cell', OWNER), { boundTo: OWNER, matches: true })
  const sold = reads(body, 'alice.cell', OTHER)
  assert.equal(sold?.matches, false, 'the domain vouched for a holder who no longer holds it')
  assert.equal(sold?.boundTo, OWNER)
})

test('the binding is case insensitive on both sides, because hex is written both ways', () => {
  const body = `ALICE.CELL owner=${OWNER.toUpperCase().replace('0X', '0x')}\n`
  assert.equal(reads(body, 'alice.cell', OWNER)?.matches, true)
})

test('a line that is not a binding does not become one', () => {
  // Anything after the name that is not `owner=0x…` is ignored rather than guessed at,
  // so a note beside a name cannot turn into a claim about who holds it.
  assert.deepEqual(reads('alice.cell # our main name\n', 'alice.cell', OWNER), { boundTo: null, matches: true })
  assert.deepEqual(reads('alice.cell owner=notahash\n', 'alice.cell', OWNER), { boundTo: null, matches: true })
})

test('a name nobody has looked at yet is already due', () => {
  // The person who just pasted the file is the one asking, and they have not been
  // checked even once. Answering "too soon" to them would be answering a clock that
  // never started.
  assert.equal(new DomainProofs().due('alice.cell'), true)
})

// NOT TESTED HERE: the once-a-minute floor itself. Reaching it needs a name that has
// already been looked at, and putting one into that state means letting the watcher
// fetch a real domain, which is what this file exists to avoid. It is checked on the
// live testnet instead, by pressing "look again" twice: the second press has to answer
// `queued: false`.
