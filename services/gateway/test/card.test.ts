// The site's own card, the page a crawler reads for the site's front door. On mainnet it is
// the page to index; on the test network it sends a search engine to mainnet's twin and asks
// not to be indexed itself, while its link preview stays what it was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { siteCardHtml } from '../src/card.ts'

const canonical = (html: string) => html.match(/<link rel="canonical" href="([^"]+)">/)?.[1]

test('on mainnet the site card is its own canonical page, and indexable', () => {
  const html = siteCardHtml('https://cellula.id')
  assert.equal(canonical(html), 'https://cellula.id/')
  assert.doesNotMatch(html, /name="robots"/)
})

test("on the test network it points at mainnet's twin and asks not to be indexed", () => {
  const html = siteCardHtml('https://testnet.cellula.id', 'https://cellula.id')
  assert.equal(canonical(html), 'https://cellula.id/')
  assert.match(html, /<meta name="robots" content="noindex, follow">/)
  // A preview of the test site is still a preview of the test site.
  assert.match(html, /<meta property="og:url" content="https:\/\/testnet\.cellula\.id\/">/)
  assert.match(html, /<meta property="og:image" content="https:\/\/testnet\.cellula\.id\/og\.png">/)
})

test("a name's card links back to the profiles it names, as rel=me, for Mastodon's check", async () => {
  const { cardHtml } = await import('../src/card.ts')
  const { textToValue } = await import('../../../sdk/src/index.ts')
  const rec = (key: string, v: string) => ({ key, label: '', value: textToValue(v), ttl: 300 })
  const acc = { records: [rec('profile.mastodon', '@alice@mastodon.social'), rec('profile.github', 'alice')] } as never
  const html = cardHtml({ acc, label: 'alice', pageUrl: 'https://alice.cellula.id/', imageBase: 'https://cellula.id' })
  assert.match(html, /<link rel="me" href="https:\/\/mastodon\.social\/@alice">/)
  assert.match(html, /<link rel="me" href="https:\/\/github\.com\/alice">/)
  // The control: a name nobody holds, and a withdrawn one, vouch for nobody.
  assert.doesNotMatch(cardHtml({ acc: null, label: 'alice', pageUrl: 'https://alice.cellula.id/', imageBase: 'https://cellula.id' }), /rel="me"/)
  const withdrawn = cardHtml({ acc, label: 'alice', pageUrl: 'https://alice.cellula.id/', imageBase: 'https://cellula.id', dispute: { status: 'withdrawn', claim: 'x', since: '2026-10-02' } })
  assert.doesNotMatch(withdrawn, /rel="me"/)
})
