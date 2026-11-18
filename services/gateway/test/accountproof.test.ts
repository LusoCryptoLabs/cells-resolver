// Accounts answering for a name (decision 0040), and the card a shared statement shows.
// The platforms are not called here: what is tested is every decision that turns what a
// platform returned into a verdict, and what a preview may say, with the chain replaced by
// a verdict handed in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ccc } from '@ckb-ccc/core'
import {
  accountProofText,
  createStatement,
  encodeStatement,
  parseAccountHalf,
  statementLink,
  type AccountHalf,
  type SignedStatement,
  type StatementVerification,
} from '../../../sdk/src/index.ts'
import { AccountProofs, judgeAccount, syndicationToken } from '../src/accountproof.ts'
import { statementCardHtml } from '../src/card.ts'

const client = new ccc.ClientPublicTestnet()
const NS = ('0x' + 'ab'.repeat(32)) as `0x${string}`
const half = parseAccountHalf('github', 'https://gist.github.com/telmo/0123456789abcdef0123') as AccountHalf

async function sign(name: string, text: string): Promise<SignedStatement> {
  return createStatement(new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32)), { ns: NS, name, text, nowSeconds: 1_790_000_000 })
}

function verdict(s: SignedStatement, over: Partial<StatementVerification>): StatementVerification {
  return {
    ok: false,
    problems: [],
    statement: s.statement,
    signatureValid: true,
    tagOk: true,
    namespaceOk: true,
    registered: true,
    unsupportedWallet: false,
    signer: null,
    heldUntil: null,
    historyComplete: true,
    signerLocks: [],
    ...over,
  }
}

test('the account answers only when its owner published words the name signed about it', async () => {
  const good = await sign('telmo', accountProofText('github', 'telmo'))
  const owner = async (s: SignedStatement) => verdict(s, { ok: true, signer: 'owner' })
  const r = await judgeAccount('telmo.cell', half, { author: 'Telmo', content: encodeStatement(good) }, owner)
  assert.equal(r.verdict, 'answers')
  assert.equal(r.account, 'github.com/telmo')
  assert.equal(r.url, 'https://gist.github.com/telmo/0123456789abcdef0123')
})

test('everything short of that is silent, with the reason, or unchecked when nothing was read', async () => {
  const good = await sign('telmo', accountProofText('github', 'telmo'))
  const owner = async (s: SignedStatement) => verdict(s, { ok: true, signer: 'owner' })
  const cases: [string, Parameters<typeof judgeAccount>[2], (s: SignedStatement) => Promise<StatementVerification>, RegExp][] = [
    ['GitHub down', { error: 'GitHub answered 503' }, owner, /503/],
    ['gone', { gone: 'there is no public gist' }, owner, /no public gist/],
    ['another author', { author: 'mallory', content: encodeStatement(good) }, owner, /@mallory/],
    ['no statement', { author: 'telmo', content: 'hello' }, owner, /no statement signed for telmo\.cell/],
    ['a statement for another name', { author: 'telmo', content: encodeStatement(await sign('other', accountProofText('github', 'telmo'))) }, owner, /no statement signed/],
    ['words that name another account', { author: 'telmo', content: encodeStatement(await sign('telmo', 'github.com/telmo2 is mine')) }, owner, /does not name github\.com\/telmo/],
    ['a former owner', { author: 'telmo', content: encodeStatement(good) }, async (s) => verdict(s, { signer: 'former', heldUntil: { block: '22555004', tx: '0x01' } }), /until block 22555004/],
    ['the manager', { author: 'telmo', content: encodeStatement(good) }, async (s) => verdict(s, { signer: 'manager' }), /manager/],
    ['nobody', { author: 'telmo', content: encodeStatement(good) }, async (s) => verdict(s, { signer: null }), /not signed by the owner/],
    ['another network', { author: 'telmo', content: encodeStatement(good) }, async (s) => verdict(s, { namespaceOk: false }), /another deployment/],
  ]
  for (const [what, read, verify, why] of cases) {
    const r = await judgeAccount('telmo.cell', half, read, verify)
    assert.equal(r.verdict, what === 'GitHub down' ? 'unchecked' : 'silent', what)
    assert.match(r.why ?? '', why, what)
  }
})

test('a link to the statement in a post counts as the statement', async () => {
  const x = parseAccountHalf('x', 'https://x.com/telmo/status/1790000000000000001') as AccountHalf
  const s = await sign('telmo', accountProofText('x', 'telmo'))
  const post = `I am telmo.cell ${statementLink('https://testnet.cellula.id', s)}`
  const r = await judgeAccount('telmo.cell', x, { author: 'telmo', content: post }, async (t) => verdict(t, { ok: true, signer: 'owner' }))
  assert.equal(r.verdict, 'answers')
})

test('claims are kept per name and platform, and a changed claim loses its verdict', async () => {
  let calls = 0
  const proofs = new AccountProofs(async (_c, h) => {
    calls++
    return { platform: h.platform, account: 'github.com/telmo', handle: h.handle, url: h.url, verdict: 'answers', why: null, signer: 'owner', heldUntil: null }
  })
  const claim = { name: 'telmo.cell', platform: 'github' as const, value: 'https://gist.github.com/telmo/0123456789abcdef0123' }
  await proofs.sweep([claim, { name: 'bad.cell', platform: 'x', value: 'not an address' }])
  assert.equal(proofs.get('telmo.cell')[0]?.verdict, 'answers')
  assert.equal(proofs.get('bad.cell').length, 0) // an address that is not one is not a claim
  await proofs.sweep([claim])
  assert.equal(calls, 1) // not again inside fifteen minutes
  assert.equal(proofs.due('telmo.cell'), false) // and not on request inside a minute
  await proofs.sweep([{ ...claim, value: 'https://gist.github.com/telmo/ffffffffffffffffffff' }])
  assert.equal(calls, 2)
  await proofs.sweep([])
  assert.equal(proofs.get('telmo.cell').length, 0)
})

test("the token X's embeds send is the published formula's", () => {
  assert.equal(syndicationToken('20'), '6dq1a2xwd93')
})

test('a preview puts the name over the words only when its owner signed them', async () => {
  const s = await sign('telmo', 'I wrote <script>alert(1)</script> the article.')
  const base = { pageUrl: 'https://testnet.cellula.id/signed?s=abc', imageBase: 'https://testnet.cellula.id/api', origin: 'https://testnet.cellula.id' }
  const owner = statementCardHtml({ ...base, v: verdict(s, { ok: true, signer: 'owner' }) })
  assert.match(owner, /<title>Signed by telmo\.cell<\/title>/)
  assert.match(owner, /og:description" content="“I wrote &lt;script&gt;alert\(1\)&lt;\/script&gt; the article\.”"/)
  assert.match(owner, /avatar\/telmo\.cell\?raster=1/)
  assert.equal(owner.includes('<script>'), false)
  assert.match(owner, /noindex/)

  const former = statementCardHtml({ ...base, v: verdict(s, { signer: 'former', heldUntil: { block: '22555004', tx: '0x01' } }) })
  assert.match(former, /<title>Signed by a former owner of telmo\.cell<\/title>/)
  assert.match(former, /until block 22555004/)
  assert.equal(former.includes('avatar/telmo.cell'), false)

  // Nobody who holds the name signed it: the words are not shown at all.
  const nobody = statementCardHtml({ ...base, v: verdict(s, { signer: null }) })
  assert.match(nobody, /<title>Not signed by telmo\.cell<\/title>/)
  assert.equal(nobody.includes('the article'), false)
  const forged = statementCardHtml({ ...base, v: verdict(s, { signatureValid: false }) })
  assert.equal(forged.includes('the article'), false)
  const none = statementCardHtml({ ...base, v: null })
  assert.match(none, /Who signed these words\?/)
})

test('a short link in a post stands for the statement the resolver holds under it', async () => {
  const { statementShortId, statementToken } = await import('../../../sdk/src/index.ts')
  const x = parseAccountHalf('x', 'https://x.com/telmo/status/1790000000000000002') as AccountHalf
  const s = await sign('telmo', accountProofText('x', 'telmo'))
  const token = statementToken(s)
  const id = await statementShortId(token)
  const post = `I am telmo.cell https://testnet.cellula.id/signed/${id}`
  const owner = async (t: SignedStatement) => verdict(t, { ok: true, signer: 'owner' })
  const held = await judgeAccount('telmo.cell', x, { author: 'telmo', content: post }, owner, (k) => (k === id ? token : null))
  assert.equal(held.verdict, 'answers')
  // The controls: nothing held under the name, and no way to look, both stay silent.
  const empty = await judgeAccount('telmo.cell', x, { author: 'telmo', content: post }, owner, () => null)
  assert.equal(empty.verdict, 'silent')
  const blind = await judgeAccount('telmo.cell', x, { author: 'telmo', content: post }, owner)
  assert.equal(blind.verdict, 'silent')
})
