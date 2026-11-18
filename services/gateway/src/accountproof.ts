import {
  ACCOUNT_PLATFORM_LABEL,
  accountLocator,
  parseAccountHalf,
  statementNamesAccount,
  statementShortIdsIn,
  statementsFor,
  STATEMENT_BEGIN,
  STATEMENT_END,
  verifyStatement,
  type AccountHalf,
  type AccountPlatform,
  type CellsClient,
  type SignedStatement,
  type StatementVerification,
} from '../../../sdk/src/index.ts'
import { safeFetch } from './safefetch.ts'

/**
 * An account on another site answering for a name, checked rather than granted (decision
 * 0040). The shape and the wording are the website proof's (`domainproof.ts`): two halves
 * published by two parties, a verdict with the address that carries it, and never
 * "verified". What differs is the account's half: a statement signed by the name's owner,
 * so that a proof made by one owner does not answer for the next.
 *
 * Every request goes through the fetch guard, pinned to the one host each platform is
 * read from; nothing a name's owner writes can send the resolver anywhere else.
 */

/** How often one account is read again: somebody else's server, and a slow fact. */
const RECHECK_MS = 15 * 60_000
/** How soon somebody setting a proof up may ask for another look (`/recheck`). */
const RETRY_FLOOR_MS = 60_000
/** How long a good answer outlives the platform going quiet (see domainproof.ts). */
const STALE_MS = 12 * 3_600_000
/** At most this many accounts read per sweep, so a sweep ends and the next one starts. */
const PER_SWEEP = 12

export type AccountVerdict = 'answers' | 'silent' | 'unchecked'

export interface AccountProofState {
  platform: AccountPlatform
  /** The account as its own address, `x.com/telmo`. */
  account: string
  handle: string
  /** Where the account's half is, for a reader who wants to look. */
  url: string
  verdict: AccountVerdict
  /** Why it is not `answers`, in words, or null. */
  why: string | null
  /** Who signed the statement that was judged, when one was. */
  signer: StatementVerification['signer']
  /** For a former owner: where their ownership ended. */
  heldUntil: { block: string | null; tx: string } | null
  /** Unix ms of the last answer that settled it, and of the last attempt. */
  checkedAt: number
  triedAt: number
}

/** What a platform returned: who published it, and the text to find statements in. */
export type AccountRead = { author: string | null; content: string } | { gone: string } | { error: string }

const X_HOSTS = new Set(['cdn.syndication.twimg.com', 'publish.x.com', 't.co'])
const GITHUB_HOSTS = new Set(['gist.githubusercontent.com', 'raw.githubusercontent.com'])
const BLUESKY_HOSTS = new Set(['public.api.bsky.app'])

const reason = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 90)

/**
 * The token X's own embeds send with a post's id. It is derived from the id and checks
 * nothing; the formula is the one the published embed code uses.
 */
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}

/**
 * A post on X. First the endpoint X's embeds read, which names the author and gives every
 * link in full; then the official oEmbed, whose links are `t.co` and are read one redirect
 * deep. Neither is promised by X, so a failure of both is `unchecked`, never a no.
 */
export async function readX(half: Extract<AccountHalf, { platform: 'x' }>): Promise<AccountRead> {
  try {
    const r = await safeFetch(
      `https://cdn.syndication.twimg.com/tweet-result?id=${half.postId}&lang=en&token=${syndicationToken(half.postId)}`,
      { hosts: X_HOSTS, maxBytes: 256 * 1024 },
    )
    if (r.status === 404) return { gone: 'the post is not there: deleted, protected, or never posted' }
    if (r.status === 200 && !r.truncated) {
      const j = JSON.parse(r.body)
      if (j?.__typename === 'TweetTombstone') return { gone: 'the post is not there any more' }
      if (typeof j?.user?.screen_name === 'string') {
        const links = (Array.isArray(j.entities?.urls) ? j.entities.urls : []).map((u: any) => u?.expanded_url).filter((u: unknown) => typeof u === 'string')
        const long = j.note_tweet?.note_tweet_results?.result?.text
        return { author: j.user.screen_name, content: [j.text ?? '', typeof long === 'string' ? long : '', ...links].join('\n') }
      }
    }
  } catch {
    // The official embed below is the second way in.
  }
  try {
    const r = await safeFetch(`https://publish.x.com/oembed?url=${encodeURIComponent(half.url)}&omit_script=1&dnt=true`, { hosts: X_HOSTS, maxBytes: 64 * 1024 })
    if (r.status === 404) return { gone: 'the post is not there: deleted, protected, or never posted' }
    if (r.status !== 200) return { error: `X answered ${r.status}` }
    const j = JSON.parse(r.body)
    const author = String(j?.author_url ?? '').match(/^https:\/\/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})$/)?.[1] ?? null
    const html = String(j?.html ?? '')
    const expanded: string[] = []
    for (const m of [...html.matchAll(/href="(https:\/\/t\.co\/[A-Za-z0-9]{1,20})"/g)].slice(0, 4)) {
      try {
        const t = await safeFetch(m[1], { hosts: X_HOSTS, maxBytes: 8 * 1024 })
        if (t.location) expanded.push(t.location)
      } catch {
        // One link that does not open is not the post's fault.
      }
    }
    return { author, content: [html.replace(/<[^>]*>/g, ' '), ...expanded].join('\n') }
  } catch (e) {
    return { error: `X could not be read: ${reason(e)}` }
  }
}

/** A gist or a file on GitHub, read raw; GitHub itself refuses a gist under another user. */
export async function readGitHub(half: Extract<AccountHalf, { platform: 'github' }>): Promise<AccountRead> {
  try {
    const r = await safeFetch(half.raw, { hosts: GITHUB_HOSTS, maxBytes: 64 * 1024 })
    if (r.status === 404)
      return { gone: half.kind === 'gist' ? `there is no public gist ${half.gistId} owned by ${half.handle}` : `there is no public file ${half.path} in ${half.handle}/${half.repo}` }
    if (r.status !== 200) return { error: `GitHub answered ${r.status}` }
    return { author: half.handle, content: r.body }
  } catch (e) {
    return { error: `GitHub could not be read: ${reason(e)}` }
  }
}

/** A post on Bluesky, from the public API, which names the author and gives links in full. */
export async function readBluesky(half: Extract<AccountHalf, { platform: 'bluesky' }>): Promise<AccountRead> {
  const uri = `at://${half.handle}/app.bsky.feed.post/${half.rkey}`
  try {
    const r = await safeFetch(
      `https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=0&parentHeight=0`,
      { hosts: BLUESKY_HOSTS, maxBytes: 256 * 1024 },
    )
    if (r.status === 400 || r.status === 404) return { gone: 'the post is not there, or the handle does not exist' }
    if (r.status !== 200) return { error: `Bluesky answered ${r.status}` }
    const post = JSON.parse(r.body)?.thread?.post
    if (!post) return { gone: 'the post is not there' }
    const record = post.record ?? {}
    const links = (Array.isArray(record.facets) ? record.facets : [])
      .flatMap((f: any) => (Array.isArray(f?.features) ? f.features : []).map((x: any) => x?.uri))
      .filter((u: unknown) => typeof u === 'string')
    const card = post.embed?.external?.uri ?? record.embed?.external?.uri
    return { author: typeof post.author?.handle === 'string' ? post.author.handle : null, content: [record.text ?? '', ...links, typeof card === 'string' ? card : ''].join('\n') }
  } catch (e) {
    return { error: `Bluesky could not be read: ${reason(e)}` }
  }
}

export function readAccount(half: AccountHalf): Promise<AccountRead> {
  if (half.platform === 'x') return readX(half)
  if (half.platform === 'github') return readGitHub(half)
  return readBluesky(half)
}

type Verdict = Omit<AccountProofState, 'checkedAt' | 'triedAt'>
type Verify = (signed: SignedStatement) => Promise<StatementVerification>

/** Why a statement that was found does not answer, in words for the owner's screen. */
function whyNot(v: StatementVerification, name: string): string {
  if (!v.tagOk) return 'its statement is not one this check understands'
  if (!v.namespaceOk) return 'its statement was signed for another deployment of Cells'
  if (!v.signatureValid) return "its statement's signature does not match its words"
  if (!v.registered) return `${name} is not registered`
  if (v.unsupportedWallet) return 'its statement was signed with a kind of wallet this check cannot read'
  if (v.signer === 'manager') return `its statement was signed by the manager of ${name}, not its owner`
  if (v.signer === 'former') return `its statement was signed by a key that owned ${name} until block ${v.heldUntil?.block ?? 'unknown'}; the name has changed hands since`
  return `its statement was not signed by the owner of ${name}`
}

/** What the resolver holds under a short name, or null: the store's `get`, or nothing. */
export type Expand = (id: string) => string | null

/**
 * A short check-page link in a post stands for the statement the resolver holds under it
 * (decision 0039, 2026-09-28). The held token is appended as a block, so the same parser
 * reads it; a short name nothing is held under adds nothing, and the post stays silent.
 */
export function withHeldStatements(content: string, expand?: Expand): string {
  if (!expand) return content
  const blocks: string[] = []
  for (const id of statementShortIdsIn(content)) {
    const token = expand(id)
    if (token) blocks.push(`${STATEMENT_BEGIN}\n${token}\n${STATEMENT_END}`)
  }
  return blocks.length ? `${content}\n${blocks.join('\n')}` : content
}

/**
 * Turn what a platform returned into a verdict. Pure but for `verify`, which reads the
 * chain; the tests hand it a double.
 */
export async function judgeAccount(name: string, half: AccountHalf, read: AccountRead, verify: Verify, expand?: Expand): Promise<Verdict> {
  const base = { platform: half.platform, account: accountLocator(half.platform, half.handle), handle: half.handle, url: half.url, signer: null, heldUntil: null }
  if ('error' in read) return { ...base, verdict: 'unchecked', why: read.error }
  if ('gone' in read) return { ...base, verdict: 'silent', why: read.gone }
  if (!read.author || read.author.toLowerCase() !== half.handle.toLowerCase())
    return { ...base, verdict: 'silent', why: `it was published by ${read.author ? `@${read.author}` : 'somebody else'}, not by ${base.account}` }
  const found = statementsFor(withHeldStatements(read.content, expand), name)
  if (found.length === 0) return { ...base, verdict: 'silent', why: `it carries no statement signed for ${name}` }
  let first: Verdict | null = null
  for (const s of found) {
    if (!statementNamesAccount(s.statement.text, half.platform, half.handle)) {
      first ??= { ...base, verdict: 'silent', why: `its statement does not name ${base.account}` }
      continue
    }
    const v = await verify(s)
    if (v.ok) return { ...base, verdict: 'answers', why: null, signer: v.signer }
    first ??= { ...base, verdict: 'silent', why: whyNot(v, name), signer: v.signer, heldUntil: v.heldUntil }
  }
  return first ?? { ...base, verdict: 'silent', why: `it carries no statement signed for ${name}` }
}

/** Read and judge one claim against the chain `cells` reads. */
export async function checkAccount(cells: CellsClient, name: string, half: AccountHalf, expand?: Expand): Promise<Verdict> {
  return judgeAccount(name, half, await readAccount(half), (s) => verifyStatement(cells, s, { maxSteps: 30 }), expand)
}

export interface AccountClaim {
  /** `alice.cell`. */
  name: string
  platform: AccountPlatform
  /** The record's text as written. */
  value: string
}

/**
 * The resolver's copy: every name's account proofs, refreshed on a slow clock in the
 * background, never on the read path. A claim that has not been read yet is `unchecked`,
 * which the app shows as nothing at all.
 */
export class AccountProofs {
  private readonly state = new Map<string, AccountProofState & { value: string }>()
  private busy = false
  private readonly check: (claim: AccountClaim, half: AccountHalf) => Promise<Verdict>

  constructor(check: (claim: AccountClaim, half: AccountHalf) => Promise<Verdict>) {
    this.check = check
  }

  private static key(name: string, platform: AccountPlatform): string {
    return `${name.toLowerCase()}|${platform}`
  }

  /** What is known about the accounts `name` claims, one entry per platform it claims. */
  get(name: string): AccountProofState[] {
    const out: AccountProofState[] = []
    const prefix = `${name.toLowerCase()}|`
    for (const [key, s] of this.state) {
      if (!key.startsWith(prefix)) continue
      const shown: AccountProofState = {
        platform: s.platform,
        account: s.account,
        handle: s.handle,
        url: s.url,
        verdict: s.verdict,
        why: s.why,
        signer: s.signer,
        heldUntil: s.heldUntil,
        checkedAt: s.checkedAt,
        triedAt: s.triedAt,
      }
      out.push(
        s.verdict === 'answers' && Date.now() - s.checkedAt > STALE_MS
          ? { ...shown, verdict: 'unchecked', why: `${ACCOUNT_PLATFORM_LABEL[s.platform]} has not answered recently enough to keep saying so` }
          : shown,
      )
    }
    return out.sort((a, b) => a.platform.localeCompare(b.platform))
  }

  stats(): { claims: number; answering: number; silent: number; unchecked: number } {
    let answering = 0
    let silent = 0
    let unchecked = 0
    for (const s of this.state.values()) {
      const v = s.verdict === 'answers' && Date.now() - s.checkedAt > STALE_MS ? 'unchecked' : s.verdict
      if (v === 'answers') answering++
      else if (v === 'silent') silent++
      else unchecked++
    }
    return { claims: this.state.size, answering, silent, unchecked }
  }

  /** Mark a name's accounts due for the next sweep, at most once a minute (as domainproof.ts). */
  due(name: string): boolean {
    const prefix = `${name.toLowerCase()}|`
    let queued = false
    for (const [key, s] of this.state) {
      if (!key.startsWith(prefix) || Date.now() - s.triedAt < RETRY_FLOOR_MS) continue
      this.state.set(key, { ...s, triedAt: 0 })
      queued = true
    }
    return queued
  }

  /**
   * Bring the claims up to date with the snapshot and read what is due. A claim that
   * changes or goes loses its verdict at once: an "answers" left pointing at an account
   * the name no longer claims would look deliberate.
   */
  async sweep(claims: AccountClaim[]): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const seen = new Set<string>()
      const now = Date.now()
      let read = 0
      for (const c of claims) {
        const half = parseAccountHalf(c.platform, c.value)
        if (!half) continue
        const key = AccountProofs.key(c.name, c.platform)
        seen.add(key)
        const had = this.state.get(key)
        if (had && had.value !== c.value) this.state.delete(key)
        const cur = this.state.get(key)
        if (cur && now - cur.triedAt < RECHECK_MS) continue
        if (read >= PER_SWEEP) {
          // Not read this time: keep what was known, or say nothing yet.
          if (!cur) this.state.set(key, { ...unread(half), checkedAt: 0, triedAt: 0, value: c.value })
          continue
        }
        read++
        let r: Verdict
        try {
          r = await this.check(c, half)
        } catch (e) {
          r = { ...unread(half), why: `could not be checked: ${reason(e)}` }
        }
        this.state.set(key, {
          ...r,
          checkedAt: r.verdict === 'unchecked' ? (cur?.checkedAt ?? 0) : Date.now(),
          triedAt: Date.now(),
          value: c.value,
        })
      }
      for (const key of [...this.state.keys()]) if (!seen.has(key)) this.state.delete(key)
    } finally {
      this.busy = false
    }
  }
}

function unread(half: AccountHalf): Verdict {
  return { platform: half.platform, account: accountLocator(half.platform, half.handle), handle: half.handle, url: half.url, verdict: 'unchecked', why: null, signer: null, heldUntil: null }
}
