import { parseProfile, payMethodsOf, type LiveAccount, type PayMethod, type SaleOffer } from 'cellula-sdk'

/**
 * The directory of names, a page at a time, searched and filtered here.
 *
 * Reading every name off a node costs one round trip per name for its records: about seven
 * seconds for the 43 names on testnet in September 2026, minutes at a thousand, half an
 * hour at ten thousand, and that was what the app's Explore screen did. This service
 * already holds every live name in memory and refreshes it every few seconds, so it can
 * answer a page at once. The chain stays the source: every row carries the outpoint it was
 * read at, a name's own page in the app reads the chain and not this, and the app reads the
 * chain itself when this does not answer.
 */

export const PAY_METHODS: readonly PayMethod[] = ['ckb', 'lightning', 'fiber', 'btc', 'eth']
const MAX_SIZE = 50

export interface DirectoryQuery {
  /** Part of a label; `.cell` and case are ignored. */
  q?: string
  /** Only names listed for sale. */
  sale?: boolean
  /** Only names that publish a way to be paid by this. */
  pay?: string
  page?: number
  size?: number
}

export interface DirectoryRow {
  name: string
  label: string
  id: string
  expiresAt: string
  /** How many records the name publishes. */
  details: number
  methods: PayMethod[]
  /** The asking price when listed, else null. */
  saleCkb: number | null
  /** Whether it publishes a picture, served at /avatar/:name; else the mark is drawn from the id. */
  avatar: boolean
  accent: string | null
  /** Where the name was read, so a reader can check it against a node. */
  outPoint: string
}

export interface DirectoryPage {
  /** Names served, withdrawn ones left out. */
  total: number
  /** Names that match the query. */
  count: number
  page: number
  size: number
  pages: number
  /**
   * Whether a name spelled exactly like the query exists on the chain, served here or not:
   * "nobody has this one" is a claim about the chain, and a withdrawn name is not free.
   */
  exists: boolean
  rows: DirectoryRow[]
}

// What a name shows in a row, worked out once per account object. The snapshot swaps a
// name's object when the name changes, so a stale answer cannot be served from here.
const shapes = new WeakMap<LiveAccount, { methods: PayMethod[]; avatar: boolean; accent: string | null }>()
function shapeOf(a: LiveAccount) {
  let s = shapes.get(a)
  if (!s) {
    const p = parseProfile(a.records)
    s = { methods: payMethodsOf(a.records), avatar: !!p.avatar, accent: p.accent }
    shapes.set(a, s)
  }
  return s
}

// Sorted once per snapshot, not once per request: the snapshot is a new array each refresh.
let sortedFrom: readonly LiveAccount[] | null = null
let sorted: LiveAccount[] = []
function byLabel(names: readonly LiveAccount[]): LiveAccount[] {
  if (names !== sortedFrom) {
    sorted = names.filter((a) => a.label !== '').sort((x, y) => x.label.localeCompare(y.label))
    sortedFrom = names
  }
  return sorted
}

export function directoryPage(
  names: readonly LiveAccount[],
  offers: ReadonlyMap<string, SaleOffer>,
  query: DirectoryQuery,
  policy: { withdrawn: (label: string) => unknown },
): DirectoryPage {
  const q = (query.q ?? '').trim().toLowerCase().replace(/\.cell$/, '')
  const pay = PAY_METHODS.includes(query.pay as PayMethod) ? (query.pay as PayMethod) : null
  const size = Math.min(MAX_SIZE, Math.max(1, Math.floor(Number(query.size ?? 10)) || 10))
  const all = byLabel(names)
  const exists = q !== '' && all.some((a) => a.label === q)
  const served = all.filter((a) => !policy.withdrawn(a.label))
  const matched = served.filter(
    (a) =>
      (q === '' || a.label.includes(q)) &&
      (!query.sale || offers.has(a.ownerLockHash)) &&
      (!pay || shapeOf(a).methods.includes(pay)),
  )
  const pages = Math.max(1, Math.ceil(matched.length / size))
  const page = Math.min(pages, Math.max(1, Math.floor(Number(query.page ?? 1)) || 1))
  const rows = matched.slice((page - 1) * size, page * size).map((a): DirectoryRow => {
    const s = shapeOf(a)
    const offer = offers.get(a.ownerLockHash)
    return {
      name: `${a.label}.cell`,
      label: a.label,
      id: a.id,
      expiresAt: new Date(a.expiredAt * 1000).toISOString(),
      details: a.records.length,
      methods: s.methods,
      saleCkb: offer ? offer.priceCkb : null,
      avatar: s.avatar,
      accent: s.accent,
      outPoint: `${a.outPoint.txHash}:${a.outPoint.index}`,
    }
  })
  return { total: served.length, count: matched.length, page, size, pages, exists, rows }
}
