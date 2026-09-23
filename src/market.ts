import type { LiveAccount, SaleOffer } from 'cellula-sdk'

/**
 * The names currently for sale, as this service is willing to serve them.
 *
 * The listings are cells under a public lock, so anybody can already read them off a
 * node without asking. This route exists for the one thing a raw scan cannot do:
 * **apply the disputes policy**. A name under a notice or withdrawn stops being offered
 * here the moment the operator says so, and a marketplace mirroring this route inherits
 * that for free. One scanning the chain directly would keep selling a name we took down
 * for impersonating somebody, under our policy's name and not theirs.
 *
 * Nothing here is a price of ours. The asking price lives in the sale lock's own args,
 * so it is inside the lock hash, so it is inside what the name's data records as its
 * owner: it has been on the chain since the listing and nobody, seller included, can
 * move it without an act they sign. The fee split is the contract's arithmetic read
 * back, not a quote.
 */

export interface MarketRow {
  name: string
  label: string
  /** What the buyer brings, in shannons as a string: a price can exceed 2^53. */
  priceShannons: string
  priceCkb: number
  /** The contract's own split of that price. The two add up to the price. */
  toSellerCkb: number
  toTreasuryCkb: number
  /** The seller's lock hash, which is what the name's data records as its owner. */
  seller: string
  /** The offer cell, so a buyer can go and look at it themselves. */
  outPoint: string
  expiresAt: string
  /** A notice, where one stands. Withdrawn names are absent rather than flagged. */
  notice: string | null
}

/**
 * Join the offers to the names, drop what the policy will not serve, cheapest first.
 *
 * The join is on the owner lock hash, because listing a name IS transferring its
 * ownership to the sale lock: the name's own data points at the offer. An offer with no
 * live name behind it is not a listing, it is a leftover from a sale or a cancellation,
 * and it is dropped rather than shown with a blank.
 */
export function marketRows(
  names: readonly LiveAccount[],
  offers: ReadonlyMap<string, SaleOffer>,
  policy: { withdrawn: (label: string) => unknown; noticeOn?: (label: string) => string | null },
): MarketRow[] {
  const out: MarketRow[] = []
  for (const a of names) {
    if (!a.label) continue
    const offer = offers.get(a.ownerLockHash)
    if (!offer) continue
    if (policy.withdrawn(a.label)) continue
    out.push({
      name: `${a.label}.cell`,
      label: a.label,
      priceShannons: offer.priceShannons.toString(),
      priceCkb: offer.priceCkb,
      toSellerCkb: offer.toSeller,
      toTreasuryCkb: offer.toTreasury,
      seller: offer.seller,
      outPoint: `${offer.outPoint.txHash}:${offer.outPoint.index}`,
      expiresAt: new Date(a.expiredAt * 1000).toISOString(),
      notice: policy.noticeOn?.(a.label) ?? null,
    })
  }
  // Cheapest first, and by name where two ask the same, so the order is stable between
  // calls rather than following whatever order the indexer happened to return.
  out.sort((x, y) => x.priceCkb - y.priceCkb || x.label.localeCompare(y.label))
  return out
}
