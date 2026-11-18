// Format-level address checks for the payout methods a name can publish. They are
// deliberately NOT full checksum validation: the job is to stop an obvious typo or a
// wrong-chain paste before it is written on-chain, where the address is human-visible
// on the name's page anyway. Each returns true for a plausibly-well-formed address.
import { platformLabel, PROOF_DOMAIN_KEY } from './profile.ts'

/** Ethereum (and any EVM chain): 0x + 40 hex. */
export function isEthAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim())
}

/** Solana: a base58 public key, 32-44 chars (base58 excludes 0, O, I, l). */
export function isSolAddress(v: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v.trim())
}

/** Bitcoin: bech32 (bc1…/tb1…) or legacy base58 (1…/3…/m/n/2…). */
export function isBtcAddress(v: string): boolean {
  const s = v.trim()
  return /^(bc1|tb1)[0-9a-z]{20,80}$/i.test(s) || /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(s)
}

/** CKB: a ckb1…/ckt1… bech32 address. The full parse happens on publish (it needs a
 *  client), so this is only the shape gate for enabling the button. */
export function isCkbAddress(v: string): boolean {
  return /^ck[bt]1[0-9a-z]{20,}$/i.test(v.trim())
}

/** A Fiber node public key: 0x + a 33-byte compressed secp256k1 key (66 hex). */
export function isFiberNodeKey(v: string): boolean {
  return /^0x[0-9a-fA-F]{60,72}$/.test(v.trim())
}

/** Short, human names for the common SLIP-44 coin types, for display. */
/** Where a name publishes its Lightning details, mirroring `fiber.node`/`fiber.addr`. */
export const LIGHTNING_ADDRESS_KEY = 'lightning.address'
export const LIGHTNING_OFFER_KEY = 'lightning.offer'

export const COIN_NAMES: Record<string, string> = {
  '0': 'btc',
  '60': 'eth',
  '195': 'trx',
  '309': 'ckb',
  '501': 'sol',
  '966': 'matic',
}

/**
 * A Lightning Address, `name@domain`, which is what nearly every Bitcoin wallet
 * accepts today. It is deliberately the same shape as an email, because that is
 * the point of it, so this is an email check that refuses the obvious rubbish and
 * leaves the rest to the wallet that will resolve it.
 */
export function isLightningAddress(v: string): boolean {
  return /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(v.trim())
}

/**
 * A BOLT12 offer, `lno1…`. Unlike a BOLT11 invoice it is reusable and does not
 * expire, which is the only reason it can live in a record at all: a record is a
 * standing answer to "where do I pay you", and a single-use invoice is not that.
 * Bech32 without a checksum test here, because the wallet paying it will check.
 */
export function isLightningOffer(v: string): boolean {
  return /^lno1[023456789acdefghjklmnpqrstuvwxyz]{20,}$/i.test(v.trim())
}

/**
 * A display label for a record key. An `address.<coin>` key becomes the coin's
 * short name (`address.60` → `eth`), so a person reads `btc`/`eth`/`ckb` rather
 * than a SLIP-44 number; a known platform key becomes the platform's name, so the list
 * an owner reads is not half translated; and any other key is returned unchanged.
 */
export function recordKeyLabel(key: string): string {
  if (key === LIGHTNING_ADDRESS_KEY) return 'lightning'
  if (key === LIGHTNING_OFFER_KEY) return 'lightning offer'
  if (key === PROOF_DOMAIN_KEY) return 'website proof'
  if (key === 'proof.nostr') return 'Nostr proof'
  if (key === 'proof.atproto') return 'Bluesky proof'
  // A known platform gets its own name. An unrecognised key is returned exactly as it
  // is: a name may publish anything, and inventing a prettier spelling for a key nobody
  // knows would hide what is actually on the chain.
  if (!key.startsWith('address.')) return platformLabel(key) ?? key
  const coin = key.slice('address.'.length)
  return COIN_NAMES[coin] ?? `coin ${coin}`
}

/** The format check for a given SLIP-44 coin type (0=BTC, 60=ETH, 501=SOL). */
export function isAddressForCoin(coinType: string, v: string): boolean {
  switch (coinType) {
    case '0':
      return isBtcAddress(v)
    case '60':
      return isEthAddress(v)
    case '501':
      return isSolAddress(v)
    case '309':
      return isCkbAddress(v)
    default:
      return v.trim() !== ''
  }
}
