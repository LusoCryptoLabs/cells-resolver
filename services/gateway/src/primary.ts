/**
 * The body of `GET /primary/:address`, kept out of the server so it can be tested.
 *
 * Until 2026-09-17 this answered `{ address, name }` and nothing else, which meant an
 * integrator showing "the name you can pay" had no way of knowing from that call whether
 * the registration had lapsed, and had to make a second one to `/resolve` to find out. The
 * forward lookup that proves the name is really theirs already has the account in hand, so
 * the date was being read and thrown away.
 *
 * Three fields, with the same names and the same meaning as `/resolve` gives them, so the
 * two routes never disagree about the same name. `expired` is worked out when the answer
 * is written, not when the chain was read: the cache in front of this route keeps the
 * date, and the flag turns over by itself at the right moment.
 *
 * An expired name is still returned. The resolver says what it knows; what a lapsed name
 * means on somebody's page is theirs to decide, and returning null instead would change
 * the answer under the feet of everyone who integrated before the field existed.
 */

/** What the registry knows about an address's own name: the label and when it runs out. */
export interface PrimaryHit {
  name: string
  expiredAt: number
}

export interface PrimaryBody {
  address: string
  name: string | null
  expiredAt: number | null
  expires: string | null
  expired: boolean
  /** Only on an address this side could not read at all. Absent on every honest answer. */
  error?: string
}

export function primaryBody(address: string, hit: PrimaryHit | null, now = Date.now()): PrimaryBody {
  if (!hit) return { address, name: null, expiredAt: null, expires: null, expired: false }
  return {
    address,
    name: hit.name,
    expiredAt: hit.expiredAt,
    expires: new Date(hit.expiredAt * 1000).toISOString(),
    // Strictly before, as /resolve has it: the very second it runs out, it has not yet.
    expired: hit.expiredAt * 1000 < now,
  }
}

/** An Ethereum address: `0x` and forty hex digits, either case. */
export function isEthAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s)
}

/**
 * The OmniLock lock args an Ethereum key owns CKB under, both flavours.
 *
 * A wallet whose key is Ethereum holds its `.cell` through a CKB lock, and for OmniLock
 * that lock's args are deterministic: one byte of auth flag, the twenty bytes of the
 * Ethereum address, one byte of OmniLock mode. CCC's own EVM signer derives exactly these
 * two (`signerEvm.js`: `0x12` first, which is the current "Ethereum displaying" flag, and
 * `0x01`, the older one it still answers for), so asking the registry for both is what the
 * wallet itself would do. Anything else an Ethereum key could own a name under, a passkey
 * lock for instance, cannot be derived from the address, and is not pretended here.
 */
export function omniLockArgs(eth: string): [current: string, older: string] {
  const hex = eth.slice(2).toLowerCase()
  return [`0x12${hex}00`, `0x01${hex}00`]
}

/** How many addresses one batch may carry. Each is a chain read when not cached. */
export const BATCH_MAX = 50
