/**
 * Which names are running out, and which are actually free.
 *
 * Every name lapses unless somebody renews it, and until 2026-09-16 there was no way to
 * watch for that from outside. Inside the app a person sees their own names expiring; a
 * stranger waiting for `alice.cell` to drop had to poll `/names` and diff it themselves.
 * The bots that [RESERVED.md](../../../docs/RESERVED.md) already assumes are watching can
 * do that easily. A person cannot, and the asymmetry was ours to remove rather than to
 * benefit from.
 *
 * There is no "tell me when", because there are no accounts and no email. A feed is the
 * honest substitute: it costs us nothing, it is the same answer for everybody, and it
 * carries no identifier of anyone reading it.
 *
 * ## The three states, and why the middle one is the point
 *
 * - **expiring**: still paid up, running out within the window asked for.
 * - **grace**: past its expiry, and for thirty days more it is *still the owner's*. The
 *   cell is live, the name still resolves, anybody may renew it, and **nobody else may
 *   take it**.
 * - **free**: past expiry plus grace. Recycling is permissionless, so anybody may clear
 *   the cell away and register the label.
 *
 * Collapsing grace into free would be the mistake worth avoiding. A feed that said
 * "alice.cell is available" the second it lapsed would send somebody to build a
 * transaction the contract refuses with `NotExpired`, thirty days early. So the state is
 * named, `freeAt` is given as a timestamp, and the grace period is reported in the answer
 * rather than assumed by the reader.
 */
import { GRACE_SECONDS, type LiveAccount } from 'cellula-sdk'

export type ExpiryState = 'expiring' | 'grace' | 'free'

export interface ExpiringName {
  name: string
  label: string
  /** Unix seconds, from the cell. */
  expiredAt: number
  state: ExpiryState
  /** Unix seconds at which recycling becomes permissible: `expiredAt + GRACE_SECONDS`. */
  freeAt: number
  /** Negative once it has lapsed. Whole days, truncated toward zero. */
  daysToExpiry: number
  /** Zero once it is free. Whole days, rounded up, so "1" never means "in an hour". */
  daysToFree: number
}

export interface ExpiringQuery {
  /** How far ahead to look, in days. Names already lapsed are always included. */
  days?: number
  limit?: number
  state?: ExpiryState | 'all'
  nowSeconds?: number
}

const DAY = 86_400

export function stateOf(expiredAt: number, now: number): ExpiryState {
  if (now < expiredAt) return 'expiring'
  return now < expiredAt + GRACE_SECONDS ? 'grace' : 'free'
}

/**
 * Pure, so it can be tested without a chain: the snapshot in, the rows out.
 *
 * Sorted by `expiredAt` ascending, which puts what is free now first and what expires
 * furthest away last. That is the order somebody hunting a name wants, and it is also the
 * order in which the list stops being interesting, so a small `limit` still gives the
 * useful end.
 */
export function expiringFrom(accounts: Pick<LiveAccount, 'label' | 'expiredAt'>[], q: ExpiringQuery = {}): ExpiringName[] {
  const now = q.nowSeconds ?? Math.floor(Date.now() / 1000)
  const windowDays = Math.min(Math.max(q.days ?? 30, 1), 3650)
  const horizon = now + windowDays * DAY
  const want = q.state ?? 'all'
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000)

  const rows: ExpiringName[] = []
  for (const a of accounts) {
    // The root carries no label and is not a name anybody can register.
    if (!a.label) continue
    if (a.expiredAt > horizon) continue
    const state = stateOf(a.expiredAt, now)
    if (want !== 'all' && state !== want) continue
    const freeAt = a.expiredAt + GRACE_SECONDS
    rows.push({
      name: `${a.label}.cell`,
      label: a.label,
      expiredAt: a.expiredAt,
      state,
      freeAt,
      daysToExpiry: Math.trunc((a.expiredAt - now) / DAY),
      daysToFree: Math.max(0, Math.ceil((freeAt - now) / DAY)),
    })
  }
  rows.sort((x, y) => x.expiredAt - y.expiredAt || x.label.localeCompare(y.label))
  return rows.slice(0, limit)
}

/** One line per name, for a reader that wants a feed rather than an API. */
export function expiringRss(rows: ExpiringName[], opts: { appUrl: string; nameDomain: string; now: number }): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const when = (t: number) => new Date(t * 1000).toUTCString()
  const said = (r: ExpiringName) =>
    r.state === 'free'
      ? 'free now: anybody may register it'
      : r.state === 'grace'
        ? `lapsed, still its owner's for ${r.daysToFree} more day${r.daysToFree === 1 ? '' : 's'}; free on ${when(r.freeAt)}`
        : `expires in ${r.daysToExpiry} day${r.daysToExpiry === 1 ? '' : 's'}, on ${when(r.expiredAt)}`
  const items = rows
    .map(
      (r) => `    <item>
      <title>${esc(r.name)}: ${esc(said(r))}</title>
      <link>${esc(opts.appUrl)}/${esc(r.label)}</link>
      <guid isPermaLink="false">${esc(r.name)}@${r.expiredAt}</guid>
      <pubDate>${when(r.state === 'expiring' ? opts.now : Math.min(r.expiredAt, opts.now))}</pubDate>
      <description>${esc(said(r))}</description>
    </item>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Names running out on ${esc(opts.nameDomain)}</title>
    <link>${esc(opts.appUrl)}</link>
    <description>Names about to lapse, lapsed but still their owner's for thirty days, and free to register now. Read from the chain; nothing here knows who is reading.</description>
    <lastBuildDate>${when(opts.now)}</lastBuildDate>
${items}
  </channel>
</rss>
`
}
