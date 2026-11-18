import { parseFiber, parseLightning, type RecordEntry } from './codec.ts'

/**
 * The ways a name can be paid, read off its records, so a list can say at a glance what a
 * name accepts without anyone opening it. The order is the order a payer cares about:
 * what the app pays, what a phone wallet pays, then the rest.
 *
 * Here rather than in the app so that the directory the resolver serves and the one the
 * app draws from the chain answer the same thing for the same records (2026-09-25).
 */
export type PayMethod = 'ckb' | 'lightning' | 'fiber' | 'btc' | 'eth'

export function payMethodsOf(records: readonly RecordEntry[]): PayMethod[] {
  const has = (key: string) => records.some((r) => r.key === key)
  const ln = parseLightning(records as RecordEntry[])
  const out: PayMethod[] = []
  if (has('address.309')) out.push('ckb')
  if (ln?.address || ln?.offer) out.push('lightning')
  if (parseFiber(records as RecordEntry[])) out.push('fiber')
  if (has('address.0')) out.push('btc')
  if (has('address.60')) out.push('eth')
  return out
}
