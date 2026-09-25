// The cellula.id read gateway, a tiny public resolver API for the Cells protocol. Keeps an in-memory snapshot of all
// live names (refreshed on an interval) and answers resolve/reverse/list over HTTP with
// CORS, so any web app can look up a .cell name with one fetch, no CKB knowledge, no
// package, no key. The chain stays the source of truth; this is a cache in front of it.
//
//   node src/server.ts        (PORT, REFRESH_MS, defaults 8787 / 15000)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { ccc } from '@ckb-ccc/core'
import {
  accountId,
  CellsClient,
  deploymentFromJson,
  valueToText,
  parseFiber,
  parseLightning,
  verifyLogin,
  GRACE_SECONDS,
  isLoginDomain,
  PROOF_DOMAIN_KEY,
  type LiveAccount,
  type SaleOffer,
  type SignedLogin,
} from 'cellula-sdk'
import { DEPLOYMENT } from './deployment.ts'
import { avatar, cover, profileJson } from './avatar.ts'
import { serveSite, sitePlain } from './site.ts'
import { registryFor } from './registry.ts'
import { Archive } from './archive.ts'
import { cardHtml, siteCardHtml } from './card.ts'
import { Disputes, parseReport, withdrawnBody } from './disputes.ts'
import { marketRows } from './market.ts'
import { directoryPage } from './directory.ts'
import { Quantum } from './quantum.ts'
import { DomainProofs, cleanDomain } from './domainproof.ts'
import { SealedStore } from './sealed.ts'
import { LockWatch } from './lockwatch.ts'
import { WalletWatch } from './walletwatch.ts'
import { expiringFrom, expiringRss, type ExpiryState } from './expiring.ts'
import { primaryBody, isEthAddress, omniLockArgs, BATCH_MAX, type PrimaryHit, type PrimaryBody } from './primary.ts'
import { openapiSpec } from './openapi.ts'
import { Counts } from './counts.ts'

const PORT = Number(process.env.PORT ?? 8787)
const REFRESH_MS = Number(process.env.REFRESH_MS ?? 15_000)
const REFRESH_TIMEOUT_MS = Number(process.env.REFRESH_TIMEOUT_MS ?? 30_000)
const RATE_MAX = Number(process.env.RATE_MAX ?? 120) // requests per window per IP
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000)
const PRIMARY_TTL_MS = Number(process.env.PRIMARY_TTL_MS ?? 60_000)
// The short domain every name gets a home under. A request arriving for
// `<name>.<domain>` is that name's page, and `<name>@<domain>` is a Lightning Address
// that forwards to whatever the name publishes. Set per deployment, never assumed:
// the testnet instance answers for `testnet.cellula.id`, and `cellula.id` itself is
// reserved for mainnet, so a test name can never look like a real one. Empty disables it.
const GATEWAY_DOMAIN = (process.env.GATEWAY_DOMAIN ?? '').toLowerCase()
const APP_URL = process.env.APP_URL ?? 'https://testnet.cellula.id'
// The hostname a name's own website answers on, and it must not be the one that answers
// the API (decision 0024). Empty disables sites entirely, which is the default: a feature
// that serves strangers' documents should be switched on deliberately, per deployment.
const SITE_DOMAIN = (process.env.SITE_DOMAIN ?? '').toLowerCase()

// Which network the resolver reads. Set per deployment like the domain above; the
// deployment.ts it loads must belong to the same network or it resolves nothing.
const CKB_NETWORK = (process.env.CKB_NETWORK ?? 'testnet').toLowerCase()
/**
 * What this resolver calls its own network, everywhere it says so out loud.
 *
 * It was the literal 'pudge' in four places. The first mainnet container reported
 * `"network": "pudge"` while serving 52 mainnet names and the live mainnet price cell,
 * which is the sentinela's own reading, the OpenAPI document's, and the card's. A label
 * that contradicts the data is worse than no label: it is the one line somebody checks to
 * decide which chain they are looking at.
 */
const NETWORK_NAME = CKB_NETWORK === 'mainnet' ? 'mainnet' : 'pudge'
const NETWORK_LABEL = CKB_NETWORK === 'mainnet' ? 'mainnet' : 'pudge (testnet)'
const cells = new CellsClient(
  CKB_NETWORK === 'mainnet' ? new ccc.ClientPublicMainnet() : new ccc.ClientPublicTestnet(),
  deploymentFromJson(DEPLOYMENT),
)

// Registration dates are not on the cell, so they are derived from the chain's own
// history and kept here. See registry.ts. The scan is incremental and runs beside the
// snapshot refresh; it never blocks a request.
//
// The default follows the network. It was the literal testnet endpoint, so the first
// mainnet resolver, deployed 2026-09-21, scanned TESTNET for mainnet identifiers and found
// nothing, quietly: registration dates simply never appeared and nothing said why. An
// unset variable should mean "the obvious one for this network", never "the one the author
// happened to be using".
const CKB_RPC = process.env.CKB_RPC ?? (CKB_NETWORK === 'mainnet' ? 'https://mainnet.ckb.dev/rpc' : 'https://testnet.ckb.dev/rpc')
const registry = registryFor(CKB_RPC, DEPLOYMENT.account)

// A content-addressed copy of every record set we have seen, so a picture survives its
// witness ageing out of what nodes keep. It is checked, not trusted: every file is named
// by the commitment the chain holds and re-hashed on the way out. See archive.ts.
const archive = new Archive()
// Which names are owned by a post-quantum key, proven from the chain (decision 0016).
// Scanned on its own slower clock: it is one query over a whole lock, not per name.
const quantum = new Quantum(cells.client, CKB_NETWORK === 'mainnet' ? 'mainnet' : 'testnet')
const QUANTUM_MS = Number(process.env.QUANTUM_MS ?? 180_000)
let quantumAt = 0
// Is the code behind that lock still the code we recorded? On mainnet it can be
// replaced by whoever holds the type-id cell, so the arrangement is only defensible if
// we would notice (decision 0016). Mainnet is watched from here even while this runs on
// testnet: a watch that starts the day it is needed is not a watch.
const lockWatch = new LockWatch()
lockWatch.add(CKB_NETWORK === 'mainnet' ? 'mainnet' : 'testnet', cells.client)
if (CKB_NETWORK !== 'mainnet') lockWatch.add('mainnet', new ccc.ClientPublicMainnet())
// The wallet lock almost every owner actually uses, which nobody chose and which its
// makers can replace. Same clock, same shape, its own answer (T-8).
const walletWatch = new WalletWatch()
walletWatch.add(CKB_NETWORK === 'mainnet' ? 'mainnet' : 'testnet', cells.client)
if (CKB_NETWORK !== 'mainnet') walletWatch.add('mainnet', new ccc.ClientPublicMainnet())
const LOCK_MS = Number(process.env.LOCK_MS ?? 600_000)
let lockAt = 0
// Sealed payment requests, so a link can be short (decision 0021). Ciphertext under a
// name derived from a key this side never sees: we hold it, we cannot read it.
const sealed = new SealedStore(process.env.SEALED_DIR ?? `${process.env.DATA_DIR ?? '/app/data'}/sealed`)
const SEALED_PER_HOUR = Number(process.env.SEALED_PER_HOUR ?? 60)
setInterval(() => sealed.sweep(), 3_600_000).unref?.()

// How many people reached each step. Totals only, no identifier of any kind: see
// counts.ts for what that buys and what it costs. Written on a timer rather than per
// request, so a burst of taps is one disk write.
const counts = new Counts(process.env.COUNTS_PATH ?? `${process.env.DATA_DIR ?? '/app/data'}/counts.json`)
setInterval(() => counts.flush(), 30_000).unref?.()
// The disputes policy's two outcomes, notice and withdrawal, read from one public file.
const disputes = new Disputes()
/** Domains answering for names. Filled in the background; never blocks a read. */
const domainProofs = new DomainProofs()
const POLICY_URL = `${APP_URL}/disputes`

// --- rate limiting: an in-memory sliding window per client IP ---------------
const hits = new Map<string, number[]>()
function allow(ip: string): boolean {
  const now = Date.now()
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr)
    return false
  }
  arr.push(now)
  hits.set(ip, arr)
  return true
}
// Drop idle IPs so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now()
  for (const [ip, arr] of hits) {
    const keep = arr.filter((t) => now - t < RATE_WINDOW_MS)
    if (keep.length) hits.set(ip, keep)
    else hits.delete(ip)
  }
}, RATE_WINDOW_MS).unref?.()

// /primary reads the chain live, so cache its answers briefly: nobody can turn it into
// a way to hammer the node by asking for the same addresses.
// The hit is kept, not the body: `expired` is worked out at answer time (src/primary.ts),
// so a name that runs out inside the cached minute is reported the moment it does.
const primaryCache = new Map<string, { hit: PrimaryHit | null; at: number }>()

/**
 * One address's own name, cached, in the shape the route answers with.
 *
 * A CKB address is asked as it is. An Ethereum address is asked as the two OmniLock locks
 * its key owns CKB under (see `omniLockArgs`), current flavour first, because that is what
 * an EVM app holds and it should not have to learn what OmniLock is to show a name. An
 * address this side cannot read at all comes back with `error`, and the caller turns that
 * into a 400 on its own or leaves it in place in a batch.
 */
async function primaryFor(address: string): Promise<PrimaryBody> {
  const cached = primaryCache.get(address)
  if (cached && Date.now() - cached.at < PRIMARY_TTL_MS) return primaryBody(address, cached.hit)
  try {
    let hit: PrimaryHit | null = null
    if (isEthAddress(address)) {
      for (const args of omniLockArgs(address)) {
        const lock = await ccc.Script.fromKnownScript(cells.client, ccc.KnownScript.OmniLock, args)
        hit = await cells.primary(lock)
        if (hit) break
      }
    } else {
      hit = await cells.primary(address)
    }
    if (primaryCache.size > 5000) primaryCache.clear()
    primaryCache.set(address, { hit, at: Date.now() })
    return primaryBody(address, hit)
  } catch (e) {
    return { ...primaryBody(address, null), error: String(e) }
  }
}

/**
 * `POST /primary` with `{ addresses: [...] }`: the same answer for up to fifty addresses
 * in one call, in the order they were sent. A list of thirty addresses on a page used to
 * be thirty calls against a limit of a hundred and twenty a minute per IP; an explorer or
 * a contacts list cannot store a column the way a site with a database can. One address
 * this side cannot read does not fail the others: that entry carries `error` and the
 * rest are answered.
 */
async function primaryBatch(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 16 * 1024) return send(res, 413, { error: 'a batch is at most sixteen kilobytes' })
    chunks.push(c as Buffer)
  }
  let j: any
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return send(res, 400, { error: 'that is a JSON object with an addresses array' })
  }
  const addresses = j?.addresses
  if (!Array.isArray(addresses) || !addresses.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 200))
    return send(res, 400, { error: 'addresses must be an array of address strings' })
  if (addresses.length > BATCH_MAX) return send(res, 400, { error: `at most ${BATCH_MAX} addresses per batch`, max: BATCH_MAX })
  // A few at a time: each uncached address is a chain read, and fifty at once against
  // one node is the thing the rate limit exists to prevent from another direction.
  const results: PrimaryBody[] = new Array(addresses.length)
  const unique = Array.from(new Set(addresses as string[]))
  for (let i = 0; i < unique.length; i += 5) {
    const slice = unique.slice(i, i + 5)
    const bodies = await Promise.all(slice.map((a) => primaryFor(a)))
    for (const b of bodies) addresses.forEach((a: string, k: number) => { if (a === b.address) results[k] = b })
  }
  return send(res, 200, { results })
}

// The reproducible-build hashes the running code cells MUST hash to, or the deployed
// contract is not the published source. `scripts/verify-onchain.mjs` proves a clean
// build reproduces exactly these (see docs/TRUST.md). /verify checks the live cells
// against them, so anyone can confirm the running rules, and catch an upgrade that
// moved the cell without notice.
/**
 * The two hashes here are different things, and telling them apart is the whole point.
 *
 * `hash` is the **data hash**: blake2b of the compiled binary. It answers "is the code
 * running on chain the code that was published", which is what this route is for, and it
 * is what `scripts/verify-onchain.mjs` recomputes from a fresh build.
 *
 * `script` is what actually goes in a transaction: the **type id** and hash type that a
 * cell's `code_hash` and `hash_type` must carry to be guarded by this contract. Under a
 * type id the code can be replaced without the script changing, which is exactly why the
 * data hash above is worth reporting.
 *
 * They were not both published until 2026-09-20, and the first draft of `SALE-LOCK.md`
 * told integrators to build with the data hash. Nothing would have resolved.
 */
/**
 * The reproducible-build hash of each contract, per network.
 *
 * Per network because the same source with a different treasury, sale lock and price cell
 * compiled in is a different binary: one table could only ever have been right about one
 * of them. `scripts/repoint.mjs` patches the block for whichever network it repointed.
 */
const HASHES: Record<string, Record<string, string>> = {
  testnet: {
    'account-cell-type': '0x76ed462c0278e2d3f1413ae6ac254210fb72a8cb2f2c87a1d9d5f37d4e06cc27',
    'account-lock': '0xa46c19f2262abc0d0db0de3952b7477792b36b392645e0f60e74637ae3e3f13b',
    'sale-lock': '0xa8476c83a6752f9894871f780efcc9530d12e392973e9a3e468c4094c71de4d9',
    'price-cell-type': '0x238e74e1d2d5bf8f06f9f4b0bb352c2addd531351a45cfeddf3ff5f6f5662342',
  },
  mainnet: {
    'account-cell-type': '0xf86bdba9ff22b5018dcb90a22cdb3720cd5ea8868ab94959ac8146a6789aae30',
    'account-lock': '0xa46c19f2262abc0d0db0de3952b7477792b36b392645e0f60e74637ae3e3f13b',
    'sale-lock': '0xf1160f64a82e3509211b2903fc54f9f15cbdc4758d058f107608d30727072a93',
    'price-cell-type': '0x238e74e1d2d5bf8f06f9f4b0bb352c2addd531351a45cfeddf3ff5f6f5662342',
  },
}

const EXPECTED: {
  name: string
  hash: string
  dep: { txHash: string; index: number }
  script: { codeHash: string; hashType: string }
}[] = (
  [
    ['account-cell-type', DEPLOYMENT.account],
    ['account-lock', DEPLOYMENT.lock],
    ['sale-lock', DEPLOYMENT.sale],
    ['price-cell-type', DEPLOYMENT.price],
  ] as const
).map(([name, part]) => ({
  name,
  hash: HASHES[CKB_NETWORK]?.[name] ?? '',
  dep: part.dep,
  script: { codeHash: part.codeHash, hashType: part.hashType },
}))
let verifyCache: { at: number; body: unknown } | null = null

// SLIP-44 coin types the resolver names in its friendly output.
const COIN: Record<string, string> = { '0': 'btc', '60': 'eth', '309': 'ckb', '501': 'sol', '195': 'trx', '966': 'matic' }

// --- snapshot ---------------------------------------------------------------
let snapshot: LiveAccount[] = []
let byLabel = new Map<string, LiveAccount>()
// The live price cell (decision 0014), refreshed with the snapshot so /health can
// report the discount in force without a chain read per request.
let priceInfo: { factorBps: number | null; outPoint: { txHash: string; index: number } } | null = null
/**
 * The live listings, scanned beside the names rather than inside them.
 *
 * It is a separate pass over a different lock, and the comment on the lock watcher
 * below says why that stays out of the name refresh: a slow scan must never delay a
 * name. An empty map means "not read yet", which the route reports as such instead of
 * as "nothing is for sale".
 */
let offers = new Map<string, SaleOffer>()
let offersAt = 0
let lastRefresh = 0
let refreshing = false

async function refresh(): Promise<void> {
  if (refreshing) return
  refreshing = true
  try {
    // Time-box the scan: a hung RPC must not leave `refreshing` stuck true, which would
    // stop every future refresh. The old snapshot keeps serving until the next tick.
    const next = await Promise.race([
      cells.list(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('refresh timed out')), REFRESH_TIMEOUT_MS)),
    ])
    snapshot = next
    // A name withdrawn as illegal content is neither archived nor re-archived, and
    // neither are those exact bytes under any other name: the claim is that they may
    // not be held, which a copycat registration would otherwise walk straight past.
    const purgedBytes = new Set(next.filter((a) => disputes.purged(a.label)).map((a) => a.witnessHash))
    archive.absorb(next, (a) => disputes.purged(a.label) || purgedBytes.has(a.witnessHash))
    for (const d of disputes.list()) if (d.status === 'withdrawn' && d.claim === 'illegal') archive.forget(d.name)
    priceInfo = await cells.priceCell().catch(() => null)
    byLabel = new Map(next.map((a) => [a.label, a]))
    lastRefresh = Date.now()
    // Beside the snapshot, not inside it: a slow lock scan must never delay a name.
    // The sale-lock scan, on the same principle and its own clock.
    void cells
      .offers()
      .then((o) => {
        offers = o
        offersAt = Date.now()
      })
      .catch((e) => console.error('[market] offers scan failed', String(e)))
    if (Date.now() - lockAt > LOCK_MS) {
      lockAt = Date.now()
      void lockWatch.refresh().catch((e) => console.error('[lock] refresh failed', String(e)))
      void walletWatch.refresh().catch((e) => console.error('[wallet] refresh failed', String(e)))
    }
    if (Date.now() - quantumAt > QUANTUM_MS) {
      quantumAt = Date.now()
      void quantum.refresh(next)
    }
    // Who claims a domain, handed to the watcher to confirm in its own time. Never on
    // the read path: a name's answer must not wait on somebody else's web server.
    void domainProofs
      .sweep(
        next.flatMap((a) => {
          const v = a.records.find((r) => r.key === PROOF_DOMAIN_KEY)?.value
          const d = v ? cleanDomain(safeText(v)) : null
          return d ? [{ name: a.name, domain: d, owner: a.ownerLockHash }] : []
        }),
      )
      .catch((e) => console.error('[domain] sweep failed', String(e)))
    console.log(`[gateway] refreshed: ${next.length} names`)
  } catch (e) {
    console.error('[gateway] refresh failed:', String(e))
  } finally {
    refreshing = false
  }
}

// --- helpers ----------------------------------------------------------------
const label = (s: string) => decodeURIComponent(s).replace(/\.cell$/, '')

/** Decode a record value as text, unless it was written as raw bytes (then show raw). */
function safeText(hex: string): string {
  try {
    const t = valueToText(hex as `0x${string}`)
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i)
      if (c === 0xfffd || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) return hex
    }
    return t
  } catch {
    return hex
  }
}

/** The friendly, decoded view of a name: everything you need to pay it or show it. */
/**
 * Where this answer came from, so it can be checked without believing us.
 *
 * Until 2026-09-14 an answer from `/resolve` carried no evidence of any kind: no outpoint,
 * no transaction, no hash. RESOLVER.md said any answer was checkable against the chain
 * without our code, and that was true of the **name** and false of the **answer**, because
 * nothing in it said which cell it came from. Somebody integrating over HTTP asked where to
 * send money and had no way to check the reply short of redoing the whole lookup, which is
 * what they came here to avoid. Our own app is unaffected: it reads the chain in the
 * browser and never asks this route.
 *
 * With the outpoint and the type script, one `get_live_cell` against any public node
 * settles it: the cell is live, its type is the published namespace, and its data decodes
 * to the addresses above. `dataHash` lets a caller compare without decoding anything.
 *
 * The block is for a light client. One that only watches scripts cannot look a cell up
 * by outpoint, but it can fetch the transaction by hash and then watch from that block
 * for the cell being spent; without the number it would scan from genesis. Asked for by
 * Pocket Node (RaheemJnr/pocket-node#530), 2026-09-23.
 */
function proofFor(a: LiveAccount) {
  return {
    outPoint: a.outPoint,
    // The whole type script, not just its code hash: the args are the namespace, and a
    // cell of the right code in the wrong namespace is a different protocol.
    type: cells.accountType(),
    dataHash: ccc.hashCkb(a.data),
    blockNumber: a.blockNumber ?? null,
    blockHash: a.blockHash ?? null,
    network: CKB_NETWORK,
    how: 'get_live_cell(outPoint, true) on any CKB node: the cell must be live, its type must be this one, and blake2b(its data) must be dataHash. Then decode the data yourself, or fetch its witness by the transaction and hash it against the witness_hash inside. blockNumber and blockHash are where that transaction was committed, so a light client can fetch it by hash and watch for the cell being spent from that block on.',
  }
}

function summary(a: LiveAccount) {
  const addresses: Record<string, string> = {}
  for (const r of a.records) {
    if (r.key.startsWith('address.')) {
      const coin = r.key.slice('address.'.length)
      addresses[COIN[coin] ?? `coin${coin}`] = safeText(r.value)
    }
  }
  const fiber = parseFiber(a.records)
  const lightning = parseLightning(a.records)
  return {
    name: a.name,
    registered: true,
    expiredAt: a.expiredAt,
    expires: new Date(a.expiredAt * 1000).toISOString(),
    expired: a.expiredAt * 1000 < Date.now(),
    owner: a.ownerLockHash,
    addresses,
    fiber: fiber ? { node: fiber.node, addr: fiber.addr } : null,
    lightning,
    records: a.records,
  }
}

function send(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    // The data changes slowly, so let clients and any CDN hold a good answer briefly.
    // Errors and rate-limits are never cached.
    'cache-control': code === 200 ? 'public, max-age=10, stale-while-revalidate=30' : 'no-store',
  })
  res.end(JSON.stringify(body, null, 2))
}

const INFO = {
  service: 'cellula.id resolver',
  what: 'Resolve .cell names on the Nervos blockchain over HTTP. A cache in front of chain; the chain is the source of truth.',
  network: NETWORK_LABEL,
  routes: {
    'GET /resolve/:name': 'everything about a name, decoded: addresses per chain, lightning, fiber endpoint, expiry, owner, plus a `proof` naming the cell it came from so you can check this answer against any CKB node rather than trusting this one',
    'GET /resolve/:name?coinType=309': 'one address by SLIP-44 coin type (0 btc, 60 eth, 309 ckb, 501 sol)',
    'GET /primary/:address': "the address's own canonical name (its reverse record, forward-verified), or null, with when it runs out; a CKB address or an Ethereum 0x one",
    'POST /primary': 'the same answer for up to fifty addresses at once, as JSON {addresses}, results in the same order',
    'GET /reverse/:address?coinType=309': 'names that publish this address as a payout',
    'GET /avatar/:name': "the name's picture, as an ordinary image; falls back to the mark drawn from its id (?fallback=none to 404 instead)",
    'GET /cover/:name': "the wide band across the top of its page, as an ordinary image; falls back to the band drawn from its id (?fallback=none to 404 instead)",
    'GET /profile/:name': 'what a name publishes about itself: display name, bio, location, colour, links, and where its picture lives',
    'GET /name/:name': 'the raw on-chain record set',
    'GET /card/:name': "the link-preview document for a name, which is what a crawler is served when it asks for the name's page",
    'GET /archive/:name': "the record set we kept a copy of, so anyone holding it can publish it again; checked against the chain's own commitment, never trusted",
    'GET /latest?limit=20': 'the most recently registered names, newest first, with when each one was registered',
    'GET /names': 'every registered name',
    'GET /directory?q=&sale=&pay=&page=1&size=10': 'the names a page at a time, searched and filtered here, in label order, with what a list shows of each. Withdrawn names are left out',
    'GET /expiring?days=30&state=all&format=json':
      'names running out: expiring, in grace (lapsed, but for thirty days more nobody else may take them), and free to register now. state filters to one of those; format=rss gives a feed',
    'GET /health': 'snapshot freshness',
    'GET /market': 'every name its owner has listed for sale, cheapest first, with the split of each price the contract enforces. Withdrawn names are left out',
    'GET /recheck/:name': "ask for that name's website proof to be looked at again, at most once a minute; it queues the check rather than running one, and the answer turns up on /resolve within about a minute",
    'GET /disputes': 'the disputes log: every name under a notice or withdrawn from this service, and why (docs/DISPUTES.md)',
    'GET /quantum': 'the owners proven to be post-quantum keys (decision 0016), and under `lock`, whether the code those names obey is still the code we recorded. A name missing from the owners list is not shown to be, never shown not to be',
    'POST /report': 'report a name under the disputes policy, as JSON {name, claim, statement, evidence, contact}; acknowledged within five working days',
    'POST /login':
      'check a "sign in with .cell" signature, as JSON {signed, domain, nonce, allowManager?}; the site issues and spends its own nonce, this service keeps none, and the same check runs locally from the SDK against your own node',
    'POST /r': 'hold a sealed payment request so its link can be short, as JSON {id, blob, days}; the id is a hash of a key this service never sees and the blob is ciphertext under it, so nothing here is readable to us',
    'GET /r/:id': 'a sealed payment request, for whoever holds the key that names it',
    'GET /verify': 'is the running contract the published, reproducible-build source? (yes/no, live)',
    'GET /price': 'what a coin is worth, cached here so a browser need not ask the rate service itself',
    'GET /openapi.json': 'this same list as an OpenAPI document, for a generator, a typed client or an agent',
    'GET /.well-known/lnurlp/:name': 'the Lightning Address lookup (LUD-16), forwarded unchanged to the wallet the name publishes',
    'GET /.well-known/lnurlp/:name/invoice?amount=<msat>&comment=': 'an invoice for that amount from the wallet the name publishes, for a web page that cannot call the wallet itself',
  },
  example: 'curl https://<host>/resolve/satoshi.cell',
}

// --- the gateway: a name as a web address and as a Lightning Address ----------

/**
 * The name a crawler is asking about, from the request it actually made: a name's own
 * host (`alice.testnet.cellula.id`) or the path form on the apex (`/alice.cell`, or a
 * bare `/alice`). Empty string when the request is for the site itself rather than a name.
 */
function cardLabelFor(host: string, pathname: string): string {
  if (GATEWAY_DOMAIN && host.endsWith('.' + GATEWAY_DOMAIN)) {
    const sub = host.slice(0, -(GATEWAY_DOMAIN.length + 1))
    if (sub && sub !== 'www') return sub
  }
  const p = pathname.replace(/^\/+|\/+$/g, '')
  if (!p || p.includes('/')) return ''
  return p.replace(/\.cell$/, '')
}

/** A name's public page, mirroring the app's own rule: its own host for a plain name,
 *  the path form for a sub-name, since a wildcard certificate covers one level. */
function pageUrlFor(lbl: string, proto: string): string {
  if (!GATEWAY_DOMAIN) return `${APP_URL}/${lbl}.cell`
  return lbl.includes('.') ? `${proto}://${GATEWAY_DOMAIN}/${lbl}.cell` : `${proto}://${lbl}.${GATEWAY_DOMAIN}/`
}

function redirect(res: ServerResponse, to: string) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' })
  res.end()
}

/**
 * `name@cellula.id`, answered the way every Lightning wallet already expects: the
 * wallet fetches `/.well-known/lnurlp/name`, and this looks the name up on chain and
 * forwards the request to the wallet the name publishes. Nothing here is custodial:
 * no invoice is created here, no money passes through here, and the upstream reply
 * goes back **unchanged**, because the invoice the payer later receives commits to a
 * hash of exactly that metadata. Rewrite a byte of it and strict wallets refuse to pay.
 */
// What this forwarder says it is when it calls a wallet provider. Node's fetch sends
// `user-agent: node` by default, and Alby's firewall answers that agent with a 429 and a
// canned "user node offline" body (measured 2026-09-09 from inside the resolver container:
// plain curl 200, curl -A node 429). A named agent gets the same 200 curl gets.
const LNURL_HEADERS = { accept: 'application/json', 'user-agent': 'cellula.id resolver (+https://cellula.id)' }

/** The LNURL-pay endpoint a name forwards to, or the sentence saying why there is none. */
function lnurlTarget(raw: string): { address: string; url: string } | { reason: string } {
  const w = disputes.withdrawn(label(raw))
  if (w) return { reason: `${label(raw)}.cell is withdrawn from this service under its disputes policy (${w.claim}, since ${w.since})` }
  const a = byLabel.get(label(raw))
  if (!a) return { reason: `${label(raw)}.cell is not registered` }
  const ln = parseLightning(a.records)
  if (!ln?.address) return { reason: `${a.name} publishes no Lightning address` }
  const at = ln.address.lastIndexOf('@')
  const user = ln.address.slice(0, at)
  const domain = ln.address.slice(at + 1)
  return { address: ln.address, url: `https://${domain}/.well-known/lnurlp/${encodeURIComponent(user)}` }
}

function forwardUnchanged(res: ServerResponse, status: number, body: string, address: string) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    'x-cells-forwarded-to': address,
  })
  res.end(body)
}

async function lnurlp(res: ServerResponse, raw: string) {
  // LNURL errors travel as HTTP 200 with `status: "ERROR"` (LUD-06): that is what
  // wallets read, and it also keeps the proxy in front from swapping a 5xx body for
  // its own error page, which would turn a sentence into "error code: 502".
  const t = lnurlTarget(raw)
  if ('reason' in t) return send(res, 200, { status: 'ERROR', reason: t.reason })
  try {
    const r = await fetch(t.url, { signal: AbortSignal.timeout(8_000), headers: LNURL_HEADERS })
    forwardUnchanged(res, r.status, await r.text(), t.address)
  } catch {
    send(res, 200, { status: 'ERROR', reason: `the wallet behind ${t.address} could not be reached` })
  }
}

/**
 * The second half of a Lightning payment, done for a web page. A wallet reads the
 * metadata above and calls its `callback` itself; a page in a browser cannot, because
 * the payee's provider need not allow cross-origin calls. So this reads the metadata,
 * calls the callback with the amount (and the comment, when the provider takes one)
 * and returns the provider's answer unchanged: the invoice commits to the metadata,
 * so nothing here is rewritten. Still nothing custodial: the invoice is the payee's
 * own, and the sats never pass through here.
 */
async function lnurlInvoice(res: ServerResponse, raw: string, query: URLSearchParams) {
  const t = lnurlTarget(raw)
  if ('reason' in t) return send(res, 200, { status: 'ERROR', reason: t.reason })
  const msat = Number(query.get('amount'))
  if (!Number.isInteger(msat) || msat <= 0) return send(res, 200, { status: 'ERROR', reason: 'amount must be a whole number of millisats' })
  try {
    const meta = (await (await fetch(t.url, { signal: AbortSignal.timeout(8_000), headers: LNURL_HEADERS })).json()) as Record<string, unknown>
    if (meta?.status === 'ERROR') return send(res, 200, meta)
    if (typeof meta?.callback !== 'string') return send(res, 200, { status: 'ERROR', reason: `the wallet behind ${t.address} gave no way to make an invoice` })
    if (typeof meta.minSendable === 'number' && msat < meta.minSendable)
      return send(res, 200, { status: 'ERROR', reason: `the wallet behind ${t.address} takes at least ${Math.ceil(meta.minSendable / 1000)} sats` })
    if (typeof meta.maxSendable === 'number' && msat > meta.maxSendable)
      return send(res, 200, { status: 'ERROR', reason: `the wallet behind ${t.address} takes at most ${Math.floor(meta.maxSendable / 1000)} sats` })
    const cb = new URL(meta.callback)
    cb.searchParams.set('amount', String(msat))
    const comment = (query.get('comment') ?? '').trim()
    const allowed = typeof meta.commentAllowed === 'number' ? meta.commentAllowed : 0
    if (comment && allowed > 0) cb.searchParams.set('comment', comment.slice(0, allowed))
    const r = await fetch(cb, { signal: AbortSignal.timeout(10_000), headers: LNURL_HEADERS })
    forwardUnchanged(res, 200, await r.text(), t.address)
  } catch {
    send(res, 200, { status: 'ERROR', reason: `the wallet behind ${t.address} could not be reached` })
  }
}

// Reports under the disputes policy: a few per address an hour, small, appended to a
// file on the volume and read by hand (`cells-reports` on the VPS). The reporter gets an
// id to quote. Nothing about the sender is kept but what they typed.
const reportsByIp = new Map<string, number[]>()
async function report(req: IncomingMessage, res: ServerResponse, ip: string) {
  const now = Date.now()
  const recent = (reportsByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= 5) return send(res, 429, { error: 'too many reports from this address; try again in an hour' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 8192) return send(res, 413, { error: 'a report is at most eight kilobytes' })
    chunks.push(c as Buffer)
  }
  let j: unknown
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return send(res, 400, { error: 'a report is a JSON object' })
  }
  const parsed = parseReport(j)
  if ('error' in parsed) return send(res, 400, parsed)
  recent.push(now)
  reportsByIp.set(ip, recent)
  if (reportsByIp.size > 10_000) reportsByIp.clear()
  const id = disputes.report(parsed)
  console.log(`[report] ${id} ${parsed.name}.cell ${parsed.claim}`)
  return send(res, 200, { ok: true, id, acknowledgedWithin: '5 working days' })
}

const sealsByIp = new Map<string, number[]>()

/**
 * Check a signed "sign in with `.cell`" for a site that does not want to run chain code.
 *
 * The site sends what it already knows (the domain it serves and the nonce it issued)
 * alongside the signature it was handed, and gets back a verdict. **This service is
 * stateless about logins**: it does not issue nonces, does not remember them, and cannot
 * tell whether the one it was handed was already spent. The site must issue its own,
 * store it, and spend it once. Anything else and a signature works twice.
 *
 * Like every other answer here, believing it means believing us. The check is pure and
 * lives in the SDK (`verifyLogin`), so a site that would rather not trust a third party
 * with who is allowed in runs the same function against its own node. That is the
 * recommended shape, and the reply says so.
 */
async function loginVerify(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 16 * 1024) return send(res, 413, { error: 'a login is at most sixteen kilobytes' })
    chunks.push(c as Buffer)
  }
  let j: any
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return send(res, 400, { error: 'that is a JSON object with signed, domain and nonce' })
  }
  if (!j || typeof j !== 'object') return send(res, 400, { error: 'that is a JSON object with signed, domain and nonce' })
  const { signed, domain, nonce, allowManager } = j
  if (typeof domain !== 'string' || !isLoginDomain(domain))
    return send(res, 400, { error: 'domain must be the bare host this site serves, such as example.com' })
  if (typeof nonce !== 'string' || !/^0x[0-9a-f]{2,128}$/i.test(nonce))
    return send(res, 400, { error: 'nonce must be the hex challenge this site issued' })
  if (!signed || typeof signed !== 'object' || !signed.login || !signed.sig)
    return send(res, 400, { error: 'signed must be the {login, sig} the wallet produced' })
  try {
    const v = await verifyLogin(cells, signed as SignedLogin, { domain, nonce, allowManager: allowManager === true })
    return send(res, 200, {
      ...v,
      how: 'This answer is ours. To owe nobody trust, run verifyLogin from the Cells SDK against your own CKB node: it is the same function, and it reads the name from the chain.',
    })
  } catch {
    return send(res, 400, { error: 'that login could not be read' })
  }
}

/**
 * Hold a sealed request so its link can be short (decision 0021). The body is a name
 * and a blob, both opaque here: the name is a hash of a key we never see, and the blob
 * is ciphertext under that key. There is nothing to validate but the shape and the
 * size, which is the point, and nothing to be learnt from what is stored.
 */
async function seal(req: IncomingMessage, res: ServerResponse, ip: string) {
  const now = Date.now()
  const recent = (sealsByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000)
  if (recent.length >= SEALED_PER_HOUR)
    return send(res, 429, { error: 'too many short links from this address; the long link always works' })
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > 96 * 1024) return send(res, 413, { error: 'a sealed request is at most sixty four kilobytes' })
    chunks.push(c as Buffer)
  }
  let j: any
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return send(res, 400, { error: 'that is a JSON object with an id and a blob' })
  }
  const out = sealed.put(String(j?.id ?? ''), String(j?.blob ?? ''), j?.days)
  if (!out.ok) return send(res, out.code, { error: out.error })
  recent.push(now)
  sealsByIp.set(ip, recent)
  if (sealsByIp.size > 10_000) sealsByIp.clear()
  return send(res, 200, { ok: true, expires: out.expires })
}

// --- routing (pure: cache → {code, body}) -----------------------------------
function route(pathname: string, coinType: string | null): { code: number; body: unknown } {
  const seg = pathname.split('/').filter(Boolean)

  if (seg.length === 0) return { code: 200, body: INFO }

  if (seg.length === 1 && seg[0] === 'health') {
    return {
      code: 200,
      body: { ok: lastRefresh > 0, names: snapshot.length, lastRefresh, ageMs: lastRefresh ? Date.now() - lastRefresh : null, network: NETWORK_NAME, price: priceInfo ? { factorBps: priceInfo.factorBps, outPoint: `${priceInfo.outPoint.txHash}:${priceInfo.outPoint.index}` } : null, archive: archive.stats(), quantum: quantum.stats(), sealed: sealed.stats(), disputes: disputes.stats(), domain: domainProofs.stats(), lock: { ok: lockWatch.ok(), watching: lockWatch.list() }, wallet: { ok: walletWatch.ok(), watching: walletWatch.list() } },
    }
  }
  if (seg.length === 1 && seg[0] === 'names') {
    const served = snapshot.filter((a) => !disputes.withdrawn(a.label))
    return { code: 200, body: { count: served.length, names: served.map((a) => a.name) } }
  }
  if (seg.length === 1 && seg[0] === 'market') {
    // Read but not yet scanned is not the same as nothing for sale, and a marketplace
    // mirroring this must be able to tell them apart before it prints "none".
    if (!offersAt) return { code: 503, body: { ready: false, note: 'the listings have not been read yet; try again in a moment' } }
    const rows = marketRows(snapshot, offers, {
      withdrawn: (l) => disputes.withdrawn(l),
      noticeOn: (l) => {
        const d = disputes.get(l)
        return d && d.status === 'notice' ? d.claim : null
      },
    })
    return {
      code: 200,
      body: {
        ready: true,
        count: rows.length,
        asOf: new Date(offersAt).toISOString(),
        note: 'names their owners have listed, with the names this service has withdrawn under its disputes policy left out',
        listings: rows,
      },
    }
  }
  if (seg.length === 2 && seg[0] === 'name') {
    const a = byLabel.get(label(seg[1]))
    return a ? { code: 200, body: rawJson(a) } : { code: 404, body: { name: label(seg[1]) + '.cell', registered: false } }
  }
  if (seg.length === 2 && seg[0] === 'resolve') {
    const a = byLabel.get(label(seg[1]))
    if (!a) return { code: 404, body: { name: label(seg[1]) + '.cell', registered: false } }
    // With ?coinType= it answers one address; without, the whole friendly summary.
    if (coinType) {
      const v = a.records.find((r) => r.key === `address.${coinType}`)?.value ?? null
      return { code: 200, body: { name: a.name, coinType, value: v ? safeText(v) : null } }
    }
    return {
      code: 200,
      body: {
        ...summary(a),
        dispute: disputes.get(a.label),
        // A domain answering for this name, or null. There is no "verified" here on
        // purpose: what travels is the claim, the verdict and the URL that carries it,
        // so the reader can repeat the check without trusting this service.
        domain: domainProofs.get(a.name),
        quantumOwner: quantum.has(a.ownerLockHash),
        proof: proofFor(a),
      },
    }
  }
  if (seg.length === 2 && seg[0] === 'reverse') {
    const address = decodeURIComponent(seg[1])
    const key = `address.${coinType ?? '309'}`
    const names = snapshot
      .filter((a) => !disputes.withdrawn(a.label) && a.records.some((r) => r.key === key && safeText(r.value) === address))
      .map((a) => a.name)
    return { code: 200, body: { address, coinType: coinType ?? '309', names } }
  }
  return { code: 404, body: { error: 'unknown route', ...INFO } }
}

function rawJson(a: LiveAccount) {
  return {
    name: a.name,
    label: a.label,
    id: a.id,
    next: a.next,
    expiredAt: a.expiredAt,
    ownerLockHash: a.ownerLockHash,
    records: a.records,
    capacity: a.capacity.toString(),
    outPoint: a.outPoint,
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    // CORS preflight, and reads only.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      })
      return res.end()
    }
    // Reads, with two exceptions: a report under the disputes policy, and a sealed
    // request left here so its link can be short. Neither is readable to this service.
    const path = (req.url ?? '').split('?')[0].replace(/\/+$/, '')
    const isReport = req.method === 'POST' && path === '/report'
    const isSeal = req.method === 'POST' && path === '/r'
    const isStep = req.method === 'POST' && path === '/step'
    const isLogin = req.method === 'POST' && path === '/login'
    const isPrimaryBatch = req.method === 'POST' && path === '/primary'
    // The site host first (decision 0024): documents strangers wrote answer there, and
    // nothing else may, not even by method. It takes GET and HEAD, HEAD because that is what
    // a link checker sends and Node drops the body for it on its own, and refuses the rest
    // in the host's own voice. Until 2026-09-16 this gate ran host-blind, so a HEAD or a
    // POST on the site host was answered by the API in JSON: no data in it, but a hole in
    // the one rule that hostname has.
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase()
    const onSiteHost = !!SITE_DOMAIN && (host === SITE_DOMAIN || host.endsWith('.' + SITE_DOMAIN))
    if (onSiteHost) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sitePlain(res, 405, 'Only GET here.')
    } else if (req.method !== 'GET' && !isReport && !isSeal && !isStep && !isLogin && !isPrimaryBatch) {
      return send(res, 405, { error: 'method not allowed' })
    }
    if ((req.url ?? '').length > 512) return onSiteHost ? sitePlain(res, 414, 'Too long.') : send(res, 414, { error: 'uri too long' })

    // Rate limit per client IP (the real one is behind the proxy's X-Forwarded-For).
    const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress) ?? 'unknown'
    if (!allow(ip))
      return onSiteHost ? sitePlain(res, 429, 'Too many requests.') : send(res, 429, { error: 'rate limited', limit: RATE_MAX, windowMs: RATE_WINDOW_MS })

    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
    const seg = url.pathname.split('/').filter(Boolean)

    if (isReport) return report(req, res, ip)
    if (isLogin) return loginVerify(req, res)
    if (isSeal) return seal(req, res, ip)
    // One step of the funnel happened somewhere. The name is matched against a fixed
    // list and counted; everything else about the request, including this address, is
    // dropped. The answer is the same whether the name was known or not, so nobody can
    // use this to discover what the list contains.
    if (isStep) {
      const name = url.searchParams.get('s') ?? ''
      counts.add(name)
      res.writeHead(204, { 'access-control-allow-origin': '*' })
      return res.end()
    }
    if (seg.length === 1 && seg[0] === 'counts') return send(res, 200, counts.report())
    // A short link's contents, for whoever has the key that names them. Missing and
    // expired are the same answer, because this side cannot tell them apart either.
    if (seg.length === 2 && seg[0] === 'r') {
      const rec = sealed.get(seg[1])
      return rec
        ? send(res, 200, { blob: rec.blob, expires: rec.expires })
        : send(res, 404, { error: 'this short link has expired or was never here' })
    }
    // "I have just put the file up, look again." It does not look here: it marks the
    // name due, and the sweep that runs every few seconds does the looking. The answer
    // says which of the two happened, because "queued" and "too soon" are different
    // things to the person waiting.
    if (seg.length === 2 && seg[0] === 'recheck') {
      const queued = domainProofs.due(seg[1].toLowerCase())
      return send(res, 200, { queued, retryAfterSeconds: queued ? 0 : 60 })
    }
    if (seg.length === 1 && seg[0] === 'disputes') return send(res, 200, { policy: POLICY_URL, entries: disputes.list() })
    // The owners proven to be post-quantum keys, so a page can mark a name without
    // scanning a whole lock in a browser. Only owners that hold a name are listed.
    if (seg.length === 1 && seg[0] === 'quantum') {
      const { cells: seen, scannedAt } = quantum.stats()
      // The stats carry a count under the same name, so the list is written last.
      return send(res, 200, { cells: seen, scannedAt, lock: lockWatch.list(), wallet: walletWatch.list(), owners: quantum.list() })
    }
    // A withdrawn name is not served by this front door: not resolved, not previewed, not
    // paid through us. It still exists on chain, and the answer says so rather than 404.
    if (seg.length === 2 && ['name', 'resolve', 'profile', 'avatar', 'cover', 'archive'].includes(seg[0])) {
      const w = disputes.withdrawn(label(seg[1]))
      if (w) return send(res, 451, withdrawnBody(label(seg[1]), w, POLICY_URL))
    }

    // A Lightning Address lookup is answered on any host, so it works before the
    // short domain exists and on it afterwards.
    if (seg.length === 4 && seg[0] === '.well-known' && seg[1] === 'lnurlp' && seg[3] === 'invoice')
      return lnurlInvoice(res, decodeURIComponent(seg[2]), url.searchParams)
    if (seg.length === 3 && seg[0] === '.well-known' && seg[1] === 'lnurlp') return lnurlp(res, decodeURIComponent(seg[2]))

    // Under the short domain, a name is a web address: alice.testnet.cellula.id. The
    // app serves both the apex and the names' own hosts now, so nginx only sends the
    // lnurlp path here; this redirect is kept as the fallback for a host that reaches
    // the resolver directly.
    // --- a name's own website, and nothing else on this hostname ------------------
    //
    // This branch runs before every route and returns without falling through, on
    // purpose. The site host serves documents strangers wrote; if the API were reachable
    // on it too, the separation of origins that makes that safe would be undone by a
    // path. So on SITE_DOMAIN there is exactly one thing to ask for: a name. The method
    // gate above has already turned away everything but GET and HEAD here.
    if (onSiteHost) {
      const sub = host === SITE_DOMAIN ? '' : host.slice(0, -(SITE_DOMAIN.length + 1))
      const lbl = label(sub && sub !== 'www' ? sub : (seg[0] ?? ''))
      if (!lbl) return sitePlain(res, 404, 'Ask for a name: /<name>')
      if (disputes.withdrawn(lbl)) return sitePlain(res, 451, 'This name is not served here.')
      const live = byLabel.get(lbl)
      if (!live) return sitePlain(res, 404, `${lbl}.cell is not registered.`)
      const verdict = await serveSite(cells.client, res, live, { ifNoneMatch: req.headers['if-none-match']?.toString() })
      if (verdict === 'served') return
      return sitePlain(
        res,
        verdict === 'no-record' ? 404 : 502,
        {
          'no-record': `${lbl}.cell publishes no website.`,
          unresolvable: `${lbl}.cell points at a file that cannot be found on chain.`,
          'not-servable': `${lbl}.cell points at a file this will not serve as a page.`,
          error: `${lbl}.cell's file could not be read from the chain.`,
          served: '',
        }[verdict],
      )
    }

    // The little document a link crawler reads. Two ways in: this path, so it can be
    // tested and looked at directly, and the X-Card header nginx sets when it recognises
    // a crawler asking for a name's page. The second is the one that matters, because a
    // crawler asks for the page's own URL and never for this one.
    const cardLabel =
      seg.length === 2 && seg[0] === 'card'
        ? label(seg[1])
        : req.headers['x-card']
          ? cardLabelFor(host, url.pathname)
          : null
    if (cardLabel !== null) {
      const proto = (req.headers['x-forwarded-proto']?.toString().split(',')[0] ?? 'https').trim()
      const site = GATEWAY_DOMAIN ? `${proto}://${GATEWAY_DOMAIN}` : APP_URL
      // A crawler that asked for the site rather than for a name still needs the site's
      // own card, or routing crawlers here would quietly remove the landing preview.
      if (!cardLabel) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' })
        return res.end(siteCardHtml(site))
      }
      const a = byLabel.get(cardLabel) ?? null
      // The image has to be fetchable by a stranger's crawler, so it is built from the
      // domain names are served under rather than from a header the proxy rewrites.
      const base = GATEWAY_DOMAIN ? `${site}/api` : `${proto}://${req.headers.host ?? ''}`
      const body = cardHtml({
        acc: a,
        label: cardLabel,
        dispute: disputes.get(cardLabel),
        pageUrl: pageUrlFor(cardLabel, proto),
        imageBase: base,
      })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'x-robots-tag': 'noindex',
      })
      return res.end(body)
    }

    if (GATEWAY_DOMAIN && (host === GATEWAY_DOMAIN || host.endsWith('.' + GATEWAY_DOMAIN))) {
      const sub = host === GATEWAY_DOMAIN ? '' : host.slice(0, -(GATEWAY_DOMAIN.length + 1))
      if (sub && sub !== 'www') return redirect(res, `${APP_URL}/${label(sub)}.cell`)
      if (seg.length === 0) return redirect(res, APP_URL)
      if (seg.length === 1 && !['health', 'names', 'verify'].includes(seg[0])) return redirect(res, `${APP_URL}/${label(seg[0])}.cell`)
    }

    // The directory a page at a time, from the snapshot this service already holds: reading
    // every name's records off a node is a round trip per name, which at thousands of names
    // is minutes. Not ready is a 503, never an empty page, so a client falls back to the
    // chain rather than printing "no names".
    if (seg.length === 1 && seg[0] === 'directory') {
      if (!lastRefresh) return send(res, 503, { ready: false, note: 'the names have not been read yet; try again in a moment' })
      const page = directoryPage(
        snapshot,
        offers,
        {
          q: url.searchParams.get('q') ?? '',
          sale: url.searchParams.get('sale') === '1' || url.searchParams.get('sale') === 'true',
          pay: url.searchParams.get('pay') ?? '',
          page: Number(url.searchParams.get('page') ?? 1),
          size: Number(url.searchParams.get('size') ?? 10),
        },
        { withdrawn: (l) => disputes.withdrawn(l) },
      )
      return send(res, 200, {
        ready: true,
        asOf: new Date(lastRefresh).toISOString(),
        // The listings are scanned apart from the names; before the first scan the sale
        // filter would say "none", so it says it has not read them instead.
        listingsRead: offersAt > 0,
        ...page,
      })
    }

    // The feed: what was registered lately. Served from the history scan rather than
    // from the snapshot, because the snapshot knows what exists and not when it arrived.
    // Names running out, and the ones that are genuinely free. A name that has lapsed is
    // still its owner's for thirty days, so the state is named rather than implied: saying
    // "free" of a name in grace would send somebody to build a transaction the contract
    // refuses. Withdrawn names are left out, the same as everywhere else on this door.
    if (seg.length === 1 && seg[0] === 'expiring') {
      const want = url.searchParams.get('state') ?? 'all'
      const state = (['expiring', 'grace', 'free'].includes(want) ? want : 'all') as ExpiryState | 'all'
      const rows = expiringFrom(
        snapshot.filter((a) => !disputes.withdrawn(a.label)),
        {
          days: Number(url.searchParams.get('days') ?? 30) || 30,
          limit: Number(url.searchParams.get('limit') ?? 100) || 100,
          state,
        },
      )
      if (url.searchParams.get('format') === 'rss') {
        const xml = expiringRss(rows, { appUrl: APP_URL, nameDomain: GATEWAY_DOMAIN || new URL(APP_URL).host, now: Math.floor(Date.now() / 1000) })
        res.writeHead(200, {
          'content-type': 'application/rss+xml; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=300',
        })
        return res.end(xml)
      }
      return send(res, 200, {
        complete: lastRefresh > 0,
        known: snapshot.length,
        graceSeconds: GRACE_SECONDS,
        now: Math.floor(Date.now() / 1000),
        names: rows,
      })
    }
    if (seg.length === 1 && seg[0] === 'latest') {
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 20) || 20, 1), 100)
      const rows = (await registry.latest(snapshot, limit)).filter((r) => !disputes.withdrawn(r.label))
      return send(res, 200, {
        // Say so plainly while the first pass is still running, rather than serving a
        // short list that looks complete.
        complete: registry.ready,
        known: registry.size,
        names: rows.map((r) => ({
          name: `${r.label}.cell`,
          label: r.label,
          registeredAt: r.time ? Math.floor(r.time / 1000) : null,
          registered: r.time ? new Date(r.time).toISOString() : null,
          block: r.block,
          txHash: r.txHash,
          // Relative: the Host header behind the proxy is the upstream's name, not
          // the public one, so an absolute URL built from it points nowhere.
          avatarPath: `/avatar/${r.label}.cell`,
        })),
      })
    }

    // A name's picture as a plain image URL, so any web page can embed it with <img>.
    // Served straight from the snapshot: no chain read, and the bytes are already here.
    if (seg.length === 2 && seg[0] === 'avatar') {
      const lbl = label(seg[1])
      const live = byLabel.get(lbl)
      // A live name is answered from the chain. The archive is consulted only when the
      // chain has stopped yielding this name at all, which is what a lost witness looks
      // like from here, so a picture the owner has since removed can never come back.
      const src = live
        ? { id: live.id, records: live.records, etagSeed: live.outPoint.txHash }
        : (() => {
            const arc = archive.recordsFor(lbl)
            return arc ? { id: accountId(lbl), records: arc.records, etagSeed: arc.witnessHash } : null
          })()
      const served = avatar(res, src, {
        fallback: url.searchParams.get('fallback') !== 'none',
        raster: url.searchParams.get('raster') === '1',
        ifNoneMatch: req.headers['if-none-match']?.toString(),
      })
      if (served) return
      return send(res, 404, { error: src ? 'this name publishes no picture' : 'name not registered', name: lbl + '.cell' })
    }

    // The wide picture, same sourcing as the avatar and the same reason: bytes already
    // in the snapshot, no chain read. Same fallback too, since the band is the name's own
    // id drawn rather than a picture invented for it.
    if (seg.length === 2 && seg[0] === 'cover') {
      const lbl = label(seg[1])
      const live = byLabel.get(lbl)
      const src = live
        ? { id: live.id, records: live.records, etagSeed: live.outPoint.txHash }
        : (() => {
            const arc = archive.recordsFor(lbl)
            return arc ? { id: accountId(lbl), records: arc.records, etagSeed: arc.witnessHash } : null
          })()
      const served = cover(res, src, {
        fallback: url.searchParams.get('fallback') !== 'none',
        raster: url.searchParams.get('raster') === '1',
        ifNoneMatch: req.headers['if-none-match']?.toString(),
      })
      if (served) return
      return send(res, 404, { error: src ? 'this name publishes no cover' : 'name not registered', name: lbl + '.cell' })
    }

    // The archived record set, exactly as the name committed to it, so the owner (or
    // anyone holding a copy) can publish it again and put the bytes back in a recent
    // block. Nothing here can be signed by us: the resolver holds no key, by design.
    if (seg.length === 2 && seg[0] === 'archive') {
      const lbl = label(seg[1])
      const arc = archive.recordsFor(lbl)
      if (!arc) return send(res, 404, { error: 'nothing archived for this name', name: lbl + '.cell' })
      const live = byLabel.get(lbl)
      return send(res, 200, {
        name: `${lbl}.cell`,
        commitment: arc.witnessHash,
        // True when the chain still agrees this is the current record set. False means
        // the name has moved on and this copy is only of historical interest.
        current: live ? live.witnessHash === arc.witnessHash : null,
        bytes: (arc.witness.length - 2) / 2,
        records: arc.records,
        witness: arc.witness,
        note: 'publish these exact records again to move them into a recent block; the chain accepts them only if they hash to the commitment above',
      })
    }

    // The same thing as data, for a caller that wants the words too.
    if (seg.length === 2 && seg[0] === 'profile') {
      const a = byLabel.get(label(seg[1]))
      if (!a) return send(res, 404, { registered: false, name: label(seg[1]) + '.cell' })
      return send(res, 200, profileJson(a))
    }

    // The machine-readable twin of the list at `/`. Built per request so it names the
    // host that answered, which is what a generated client will call.
    if (seg.length === 1 && seg[0] === 'openapi.json') {
      const proto = (req.headers['x-forwarded-proto']?.toString().split(',')[0] ?? 'https').trim()
      const origin = GATEWAY_DOMAIN ? `${proto}://${GATEWAY_DOMAIN}/api` : APP_URL
      return send(res, 200, openapiSpec(origin, NETWORK_LABEL))
    }

    // /verify: do the live code cells hash to the published reproducible-build hashes?
    // Cached briefly; each call reads the code cells, which is heavier than the snapshot.
    if (seg.length === 1 && seg[0] === 'verify') {
      if (verifyCache && Date.now() - verifyCache.at < 60_000) return send(res, 200, verifyCache.body)
      const contracts: Record<string, unknown> = {}
      let allMatch = true
      for (const { name, hash, dep, script } of EXPECTED) {
        try {
          const cell = await cells.client.getCellLive({ txHash: dep.txHash, index: BigInt(dep.index) }, true)
          const onchain = cell ? (ccc.hashCkb(cell.outputData) as string) : null
          const matches = onchain === hash
          if (!matches) allMatch = false
          contracts[name] = { matches, expected: hash, onchain, depOutPoint: `${dep.txHash}:${dep.index}`, script }
        } catch (e) {
          allMatch = false
          contracts[name] = { matches: false, expected: hash, onchain: null, error: String(e), script }
        }
      }
      const body = {
        verified: allMatch,
        // Said here because the two hashes look alike and are not: `expected` and
        // `onchain` are the binary, `script` is what a transaction carries.
        hashes: 'expected and onchain are the compiled binary hashed; script is the code hash and hash type a transaction must use',
        note: allMatch
          ? 'the running contract is byte-for-byte the published source; rebuild it and check yourself with scripts/verify-onchain.mjs'
          : 'a code cell does not match or has moved (a possible upgrade); see the upgrade policy',
        network: NETWORK_NAME,
        contracts,
      }
      verifyCache = { at: Date.now(), body }
      return send(res, 200, body)
    }

    // /primary is the ENS-reverse case: the name an address chose for itself, verified
    // both ways. It reads the reverse record live, so it is cached briefly here.
    if (seg.length === 2 && seg[0] === 'primary') {
      const address = decodeURIComponent(seg[1])
      const body = await primaryFor(address)
      return send(res, body.error ? 400 : 200, body)
    }
    if (isPrimaryBatch) return primaryBatch(req, res)

    if (seg.length === 1 && seg[0] === 'price') {
      // `usd` stays for the CKB-only callers that existed before other chains did.
      // `asOf` is when these figures were read from the source, in milliseconds: a
      // caller that is about to spend money on them needs to know how old they are,
      // and this route will keep serving the last good answer while the source is down.
      const { usd, rates, asOf } = await prices()
      return send(res, usd === null && rates === null ? 502 : 200, { usd, rates, asOf })
    }

    const { code, body } = route(url.pathname, url.searchParams.get('coinType'))
    send(res, code, body)
  } catch (e) {
    console.error('[gateway] handler error:', String(e))
    try {
      send(res, 500, { error: 'internal error' })
    } catch {
      /* response already begun */
    }
  }
}

// The CKB/USD rate the app's own price line uses, read here once and cached briefly
// instead of every visitor's browser calling CoinGecko directly (that call was
// intermittently CORS-blocked once the calling IP had made a few, which a shared
// low-traffic testnet address hits fast).
type Rates = Record<string, Record<string, number>>
/**
 * The last answer that actually came from the source, and when it came. `at` is the
 * moment of that fetch and never of a failure: an earlier version kept the old numbers
 * on a blip but re-stamped `at` with the current time, so a source that stayed down
 * left the cache looking fresh forever and the same figures were served for as long as the process
 * lived, with nothing saying they were old. What a caller does with an old rate is the
 * caller's business, but it has to be able to tell, so `asOf` goes out with every answer.
 */
let priceCache: { at: number; usd: number | null; rates: Rates | null } | null = null
const PRICE_CACHE_MS = 60_000
/** After a failure, how long before trying the source again. Short, but not every hit. */
const PRICE_RETRY_MS = 15_000
let priceTriedAt = 0
// The coins a name can be asked for money in, and the currencies people think in.
const COINS: Record<string, string> = {
  'nervos-network': 'ckb',
  bitcoin: 'btc',
  ethereum: 'eth',
  solana: 'sol',
  // Polygon charges its fee in POL, not in ether, and the shop says on the page what a
  // USDC transfer costs on each chain it takes. Priced with ether that sentence is out
  // by a factor of twenty five thousand: POL was 10 cents the day this was added and
  // ether was 2,618 dollars. The unit is `pol`, not `matic`: the coin was renamed and
  // the old id on this source is a separate, frozen row.
  'polygon-ecosystem-token': 'pol',
}
const CURRENCIES = 'usd,eur,gbp'

type PriceAnswer = { usd: number | null; rates: Rates | null; asOf: number | null }
/** The cache as an answer, whatever its age. `asOf` is what lets a caller judge it. */
const cached = (): PriceAnswer => ({ usd: priceCache?.usd ?? null, rates: priceCache?.rates ?? null, asOf: priceCache?.at ?? null })

async function prices(): Promise<PriceAnswer> {
  const now = Date.now()
  if (priceCache && now - priceCache.at < PRICE_CACHE_MS) return cached()
  // A source that is failing is not asked again on every request, and a failure never
  // becomes the cache: the last good numbers stay, with their own age, and the caller
  // decides whether that age is still worth anything.
  if (now - priceTriedAt < PRICE_RETRY_MS) return cached()
  priceTriedAt = now
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${Object.keys(COINS).join(',')}&vs_currencies=${CURRENCIES}`
    const r = await fetch(url, { signal: AbortSignal.timeout(6_000) })
    const j = r.ok ? await r.json() : null
    const rates: Rates = {}
    for (const [id, unit] of Object.entries(COINS)) {
      const row = j?.[id]
      if (!row) continue
      const cleaned: Record<string, number> = {}
      for (const c of CURRENCIES.split(',')) if (typeof row[c] === 'number' && row[c] > 0) cleaned[c] = row[c]
      if (Object.keys(cleaned).length) rates[unit] = cleaned
    }
    // An empty answer is a failure wearing a 200. Replacing good figures with nothing
    // and calling it fresh is the same mistake as re-stamping them.
    if (!Object.keys(rates).length) return cached()
    priceCache = { at: now, usd: rates.ckb?.usd ?? null, rates }
    return cached()
  } catch {
    return cached()
  }
}

// --- boot -------------------------------------------------------------------
await refresh() // warm the cache before serving

// SELFTEST=1 exercises the routes against the live cache in-process and exits.
if (process.env.SELFTEST) {
  const first = snapshot.find((a) => a.label !== '')?.label ?? 'satoshi'
  for (const p of ['/', '/health', '/names', `/name/${first}`, `/resolve/${first}`]) {
    const { code, body } = route(p, null)
    console.log(`\nGET ${p}  -> ${code}\n${JSON.stringify(body, null, 2)}`)
  }
  // /primary is async (live reverse-record read); exercise it against a real address.
  const withCkb = snapshot.find((a) => a.records.some((r) => r.key === 'address.309'))
  if (withCkb) {
    const addr = safeText(withCkb.records.find((r) => r.key === 'address.309')!.value)
    console.log(`\nGET /primary/${addr.slice(0, 18)}…  -> ${JSON.stringify(await cells.primaryName(addr))}`)
  }
  process.exit(0)
}

setInterval(refresh, REFRESH_MS)
// The history scan is slower than a snapshot refresh and nothing waits on it, so it
// warms in the background and then follows the chain on its own, longer interval.
registry.scan()
setInterval(() => registry.scan(), Math.max(REFRESH_MS * 4, 60_000)).unref?.()
const server = createServer(handle)
server.requestTimeout = 15_000 // a request must finish reasonably fast
server.headersTimeout = 12_000 // and send its headers even faster (slow-loris guard)
server.listen(PORT, () => {
  console.log(`[gateway] listening on http://localhost:${PORT} (refresh ${REFRESH_MS}ms, rate ${RATE_MAX}/${RATE_WINDOW_MS}ms)`)
})
