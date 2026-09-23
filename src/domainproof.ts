import type { Hex } from 'cellula-sdk'

/**
 * A domain answering for a name, checked rather than granted.
 *
 * **There is no badge here and there will not be one.** `docs/DISPUTES.md` puts "decide
 * who is right when we cannot know" on the list of things this registry will never do,
 * and trademark left that policy on 2026-09-16 for the same reason: adjudicating identity
 * is not ours to do. What this serves instead is a fact two other parties published, with
 * the URL that carries it, so the reader can repeat the check without asking us at all.
 * The wording that follows from that is "lusocryptolabs.com answers for this name", never
 * "verified".
 *
 * **Both halves are required.** The name publishes `proof.domain`, which only its owner or
 * manager can write; the domain publishes the name back. One side alone proves nothing:
 * without the domain's half anybody could claim any domain by typing it into a record, and
 * without the name's half a domain could nominate a name held by a stranger.
 *
 * The domain's half may bind an owner (`name.cell owner=0x…`). With it, selling the name
 * breaks the proof, which is correct, because the domain answered for a particular holder.
 * Without it the proof survives a transfer, and `boundToOwner: false` says so rather than
 * letting the reader assume otherwise.
 */

const WELL_KNOWN = '/.well-known/cells.txt'
const DNS_PREFIX = '_cells.'
/** How often one domain is asked again. Slow: this is somebody else's server. */
const RECHECK_MS = 15 * 60_000
/**
 * How soon somebody who is setting a proof up may ask for another look.
 *
 * The 15 minute clock above is right for a domain that is not expecting anything to
 * change. It is wrong for the one person who just pasted the file and wants to know
 * whether they pasted it correctly, and a quarter of an hour of nothing is where that
 * person gives up.
 */
const RETRY_FLOOR_MS = 60_000
/**
 * How long a good answer outlives the domain going quiet.
 *
 * A domain being unreachable must not flip a true proof to false, or any outage would
 * silently unpublish a business. But a proof taken down must not linger either, so after
 * this the verdict drops to `unchecked` and the app says nothing rather than something
 * stale. Twelve hours is the compromise, and `checkedAt` always travels with the answer.
 */
const STALE_MS = 12 * 3_600_000

export type ProofVerdict = 'answers' | 'silent' | 'unchecked'

export interface ProofState {
  /** The domain the name claims, from its own record. */
  claimed: string
  verdict: ProofVerdict
  /** Where the domain's half was found, for a reader who wants to look. */
  url: string | null
  how: 'well-known' | 'dns' | null
  /** Whether the domain tied the name to this exact owner. */
  boundToOwner: boolean
  /** Why it is not `answers`, in words, or null. */
  why: string | null
  /** Unix ms of the last answer that settled it, and of the last attempt. */
  checkedAt: number
  triedAt: number
}

/** A domain is a bare host: no scheme, no path, no port, no wildcard, no empty label. */
export function cleanDomain(s: unknown): string | null {
  const d = String(s ?? '')
    .trim()
    .toLowerCase()
  return /^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && !d.includes('..') ? d : null
}

/**
 * Does this text name `name`, and does the owner it names, if any, still hold it?
 *
 * Returns null when the name is absent, which is a real negative: the domain answered and
 * did not name us.
 */
export function reads(body: string, name: string, owner: Hex): { boundTo: Hex | null; matches: boolean } | null {
  for (const raw of String(body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const [claimed, ...rest] = line.split(/\s+/)
    if (claimed.toLowerCase() !== name.toLowerCase()) continue
    const bound = rest.map((t) => t.match(/^owner=(0x[0-9a-fA-F]+)$/i)?.[1]).find(Boolean) as Hex | undefined
    if (!bound) return { boundTo: null, matches: true }
    return { boundTo: bound, matches: bound.toLowerCase() === owner.toLowerCase() }
  }
  return null
}

/**
 * Fetch the domain's half, **without following redirects**.
 *
 * The redirect is the hole: `example.com/.well-known/cells.txt` redirecting to a host
 * somebody else runs would let that somebody answer for `example.com`. Requiring the
 * answer at the exact URL costs a domain owner nothing, it is a static file, and closes
 * the case. The content type is checked for the same family of reason: a single-page app
 * that serves its HTML on every path would otherwise "answer" every request, which is the
 * trap the apex `/api/` block exists to avoid.
 */
export async function fetchWellKnown(domain: string): Promise<{ url: string; body: string | null; why: string | null }> {
  const url = `https://${domain}${WELL_KNOWN}`
  try {
    const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8_000) })
    if (r.status >= 300 && r.status < 400)
      return { url, body: null, why: `redirects to ${r.headers.get('location')}, which is not this domain speaking` }
    if (!r.ok) return { url, body: null, why: `HTTP ${r.status}` }
    if (!/text\/plain/i.test(r.headers.get('content-type') ?? ''))
      return { url, body: null, why: 'the answer is not text/plain, so it is a page and not a statement' }
    return { url, body: (await r.text()).slice(0, 8192), why: null }
  } catch (e) {
    return { url, body: null, why: String((e as Error).message ?? e).slice(0, 90) }
  }
}

/** The same claim in DNS, for a domain whose owner would rather not serve a file. */
export async function fetchDnsTxt(domain: string): Promise<{ url: string; body: string | null; why: string | null }> {
  const host = DNS_PREFIX + domain
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=TXT`
  try {
    const r = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8_000) })
    const j = (await r.json()) as { Answer?: { data?: string }[] }
    const answers = (j.Answer ?? []).map((a) => String(a.data ?? '').replace(/^"|"$/g, ''))
    return answers.length
      ? { url: `TXT ${host}`, body: answers.join('\n'), why: null }
      : { url: `TXT ${host}`, body: null, why: 'no TXT record' }
  } catch (e) {
    return { url: `TXT ${host}`, body: null, why: String((e as Error).message ?? e).slice(0, 90) }
  }
}

/** Ask both halves once. Exported so a script can run the same code the resolver runs. */
export async function check(domain: string, name: string, owner: Hex): Promise<Omit<ProofState, 'claimed' | 'checkedAt' | 'triedAt'>> {
  const [file, dns] = await Promise.all([fetchWellKnown(domain), fetchDnsTxt(domain)])
  for (const [how, got] of [['well-known', file], ['dns', dns]] as const) {
    if (!got.body) continue
    const r = reads(got.body, name, owner)
    if (!r) continue
    if (!r.matches)
      return { verdict: 'silent', url: got.url, how, boundToOwner: true, why: `it names ${name} but binds it to ${r.boundTo}, and the owner is now ${owner}` }
    return { verdict: 'answers', url: got.url, how, boundToOwner: !!r.boundTo, why: null }
  }
  // Both silent. A reachable domain that did not name us is a real no; two network
  // failures are not, and the caller keeps whatever it knew before.
  const reachable = file.body !== null || dns.body !== null
  return {
    verdict: reachable ? 'silent' : 'unchecked',
    url: null,
    how: null,
    boundToOwner: false,
    why: reachable ? `${domain} answered and does not name ${name}` : `${file.why}; ${dns.why}`,
  }
}

/**
 * The resolver's copy: one verdict per name, refreshed on a slow clock in the background.
 *
 * Nothing on the read path ever waits for a third party's server. A name whose proof has
 * not been looked at yet answers `unchecked`, which the app shows as nothing at all.
 */
export class DomainProofs {
  private readonly state = new Map<string, ProofState>()
  private busy = false

  /** What is known about `name` right now, or null when it claims no domain. */
  get(name: string): ProofState | null {
    const s = this.state.get(name.toLowerCase())
    if (!s) return null
    // A good answer that has outlived the domain going quiet stops being an answer.
    if (s.verdict === 'answers' && Date.now() - s.checkedAt > STALE_MS)
      return { ...s, verdict: 'unchecked', why: 'the domain has not answered recently enough to keep saying so' }
    return s
  }

  /** Every verdict, for `/health`. */
  stats(): { claims: number; answering: number; silent: number; unchecked: number } {
    let answering = 0
    let silent = 0
    let unchecked = 0
    for (const name of this.state.keys()) {
      const v = this.get(name)?.verdict
      if (v === 'answers') answering++
      else if (v === 'silent') silent++
      else unchecked++
    }
    return { claims: this.state.size, answering, silent, unchecked }
  }

  /**
   * Ask for one name to be looked at again on the next sweep, at most once a minute.
   *
   * It marks the name due rather than fetching here, for two reasons. Nothing on the
   * read path may wait on a third party's web server, which is the rule the whole class
   * exists to keep. And an endpoint that fetched on demand would be a way to make this
   * machine fetch a URL of somebody's choosing, over and over; a sweep that is seconds
   * away costs nothing and keeps both properties.
   *
   * False means it was tried too recently for another look to tell anybody anything new.
   */
  due(name: string): boolean {
    const key = name.toLowerCase()
    const s = this.state.get(key)
    if (!s) return true // never looked at, so it is already due
    if (Date.now() - s.triedAt < RETRY_FLOOR_MS) return false
    this.state.set(key, { ...s, triedAt: 0 })
    return true
  }

  /**
   * Bring the set of claims up to date with the snapshot, and re-check what is due.
   *
   * `claims` is every name that published a `proof.domain`, with its owner. A name that
   * stops claiming, or changes what it claims, loses its old verdict at once: a stale
   * "answers" pointing at a domain the name no longer names would be the worst kind of
   * wrong, because it would look deliberate.
   */
  async sweep(claims: { name: string; domain: string; owner: Hex }[]): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const seen = new Set<string>()
      const now = Date.now()
      for (const c of claims) {
        const key = c.name.toLowerCase()
        seen.add(key)
        const had = this.state.get(key)
        if (had && had.claimed !== c.domain) this.state.delete(key)
        const cur = this.state.get(key)
        if (cur && now - cur.triedAt < RECHECK_MS) continue
        const r = await check(c.domain, c.name, c.owner)
        this.state.set(key, {
          claimed: c.domain,
          ...r,
          // A failed look leaves the previous answer standing; only a real verdict moves
          // `checkedAt`, which is what `get` measures staleness against.
          checkedAt: r.verdict === 'unchecked' ? (cur?.checkedAt ?? 0) : now,
          triedAt: now,
        })
      }
      for (const key of [...this.state.keys()]) if (!seen.has(key)) this.state.delete(key)
    } finally {
      this.busy = false
    }
  }
}
