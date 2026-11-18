// The fetch guard: every rule that keeps a stranger's address from becoming a request to
// something inside this machine's network. No network here; a fake resolver stands in
// for DNS, which is the part an attacker controls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { LookupAddress } from 'node:dns'
import { RefusedAddress, checkAddress, guardedLookup, isPublicAddress, safeFetch, safeFetchFollowing } from '../src/safefetch.ts'

const resolveTo =
  (...addresses: string[]) =>
  (_host: string, cb: (err: NodeJS.ErrnoException | null, a: LookupAddress[]) => void) =>
    cb(
      null,
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    )

test('only public addresses are public', () => {
  for (const ok of ['8.8.8.8', '140.82.112.3', '2606:4700::1111', '2a00:1450:4003:80e::200e', '::ffff:8.8.8.8'])
    assert.equal(isPublicAddress(ok), true, ok)
  for (const bad of [
    '127.0.0.1',
    '10.1.2.3',
    '172.17.0.1', // the Docker bridge, where the other containers are
    '192.168.1.1',
    '169.254.169.254', // a cloud provider's metadata service
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:10.0.0.1',
    '64:ff9b::a00:1', // NAT64 for 10.0.0.1
    'not an address',
  ])
    assert.equal(isPublicAddress(bad), false, bad)
})

test('an address the guard will not fetch is refused before any connection', () => {
  const refused = [
    'http://example.com/', // not https
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://0177.0.0.1/', // a URL parser reads it as 127.0.0.1
    'https://0x7f.1/',
    'https://2130706433/',
    'https://localhost/',
    'https://example.com:8443/', // another service on the same host
    'https://user:pass@example.com/',
    'ftp://example.com/',
    'not a url',
  ]
  for (const raw of refused) assert.throws(() => checkAddress(raw), RefusedAddress, raw)
  assert.equal(checkAddress('https://Example.com/a?b=1').hostname, 'example.com')
})

test('a call pinned to hosts reaches only those', () => {
  const hosts = new Set(['gist.githubusercontent.com'])
  assert.equal(checkAddress('https://gist.githubusercontent.com/a/b/raw', hosts).hostname, 'gist.githubusercontent.com')
  assert.throws(() => checkAddress('https://evil.example/a/b/raw', hosts), RefusedAddress)
  assert.throws(() => checkAddress('https://gist.githubusercontent.com.evil.example/', hosts), RefusedAddress)
})

test('a host is refused when any of its addresses is private', async () => {
  const call = (resolve: ReturnType<typeof resolveTo>, options: { all?: boolean } = {}) =>
    new Promise<{ err: any; rest: any[] }>((done) => guardedLookup(resolve)('wallet.example', options, (err: any, ...rest: any[]) => done({ err, rest })))

  const pub = await call(resolveTo('8.8.8.8'))
  assert.equal(pub.err, null)
  assert.deepEqual(pub.rest, ['8.8.8.8', 4])

  const all = await call(resolveTo('8.8.8.8', '2606:4700::1111'), { all: true })
  assert.equal(all.err, null)
  assert.equal(all.rest[0].length, 2)

  // One public answer and one private one is the rebinding shape: refused whole.
  const mixed = await call(resolveTo('8.8.8.8', '10.0.0.5'))
  assert.equal(mixed.err?.code, 'ENOTPUBLIC')
  const inside = await call(resolveTo('127.0.0.1'))
  assert.equal(inside.err?.code, 'ENOTPUBLIC')
})

test('the connection itself goes through the guard', async () => {
  // A name that resolves to the machine's own loopback, as `x@localtest.me` would. The
  // refusal comes from the lookup the socket uses, so nothing is dialled at all.
  await assert.rejects(safeFetch('https://wallet.example/.well-known/lnurlp/x', {}, resolveTo('127.0.0.1')), (e: any) => e.code === 'ENOTPUBLIC')
  await assert.rejects(safeFetch('https://wallet.example/', {}, resolveTo('172.17.0.1')), (e: any) => e.code === 'ENOTPUBLIC')
  // And a refused address is refused without a lookup.
  await assert.rejects(safeFetch('https://127.0.0.1:9443/internal/metadata'), RefusedAddress)
  await assert.rejects(safeFetchFollowing('http://wallet.example/'), RefusedAddress)
})
