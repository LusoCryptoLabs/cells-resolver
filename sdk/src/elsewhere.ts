/**
 * Where else a name is someone (docs/INTEGRATIONS.md, phase 1): a Nostr key, so that
 * `alice@cellula.id` verifies on Nostr (NIP-05), and a Bluesky account, so that
 * `alice.cellula.id` is its handle (AT Protocol).
 *
 * The record alone is not enough. Records stay with a name when it changes hands, and a
 * Spore deed can change hands without the name's cell moving at all, so a plain record
 * would keep vouching for a former owner. Each binding is therefore a statement signed by
 * the name (decision 0039), kept in a record: `proof.nostr` or `proof.atproto`. It counts
 * only while `verifyStatement` says the one who signed it is the one who owns the name
 * now, its holder or its seller; after a sale it stops counting until the new owner signs
 * one of their own.
 */
import type { Hex } from './codec.ts'
import { valueToText } from './codec.ts'
import type { CellsClient, LiveAccount } from './client.ts'
import { statementFromToken, verifyStatement, type SignedStatement } from './statement.ts'

export type ElsewhereKind = 'nostr' | 'atproto'

/** The record that keeps each binding's signed statement, as a token. */
export const ELSEWHERE_RECORD: Record<ElsewhereKind, string> = { nostr: 'proof.nostr', atproto: 'proof.atproto' }

/** The words that are signed: short, so a wallet shows them whole. */
export function elsewhereText(kind: ElsewhereKind, value: string): string {
  return kind === 'nostr' ? `My Nostr key is ${value}` : `My Bluesky account is ${value}`
}

/** The binding the words make, or null when they are not exactly one of ours. */
export function parseElsewhereText(text: string): { kind: ElsewhereKind; value: string } | null {
  const n = /^My Nostr key is ([0-9a-f]{64})$/.exec(text)
  if (n) return { kind: 'nostr', value: n[1] }
  const a = /^My Bluesky account is (did:[a-z]+:\S+)$/.exec(text)
  if (a && isAtprotoDid(a[1])) return { kind: 'atproto', value: a[1] }
  return null
}

/**
 * The DIDs an AT Protocol account can have: `did:plc` (24 base32 characters) and `did:web`
 * (a host name). Nothing else is accepted, as the protocol accepts nothing else.
 */
export function isAtprotoDid(s: string): boolean {
  return /^did:plc:[a-z2-7]{24}$/.test(s) || /^did:web:[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)
}

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

function polymod(values: number[]): number {
  const g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= g[i]
  }
  return chk >>> 0
}

/**
 * A Nostr public key as the 64 hex characters NIP-05 wants, from either that or an `npub`
 * (NIP-19, bech32 with its checksum checked). Null for anything else.
 */
export function nostrHex(input: string): string | null {
  const s = input.trim().toLowerCase()
  if (/^[0-9a-f]{64}$/.test(s)) return s
  if (!s.startsWith('npub1') || s.length !== 63) return null
  const data: number[] = []
  for (const c of s.slice(5)) {
    const v = BECH32.indexOf(c)
    if (v < 0) return null
    data.push(v)
  }
  const hrp = [...'npub'].map((c) => c.charCodeAt(0))
  const expanded = [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31)]
  if (polymod([...expanded, ...data]) !== 1) return null
  // five-bit groups back to bytes, the checksum's six groups left out
  let acc = 0
  let bits = 0
  const out: number[] = []
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  if (out.length !== 32) return null
  return out.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The signed statement a name keeps for a binding, shape checked, or null. */
export function elsewhereStatement(account: Pick<LiveAccount, 'label' | 'records'>, kind: ElsewhereKind): { signed: SignedStatement; value: string } | null {
  const r = account.records.find((x) => x.key === ELSEWHERE_RECORD[kind])
  if (!r) return null
  let token: string
  try {
    token = valueToText(r.value as Hex)
  } catch {
    return null
  }
  const signed = statementFromToken(token)
  if (!signed || signed.statement.name !== account.label) return null
  const p = parseElsewhereText(signed.statement.text)
  if (!p || p.kind !== kind) return null
  return { signed, value: p.value }
}

/**
 * The binding a name stands behind today: its Nostr key in hex, or its Bluesky DID. Null
 * when it keeps none, or when the one it keeps was not signed by whoever owns it now.
 */
export async function elsewhereOf(cells: CellsClient, account: LiveAccount, kind: ElsewhereKind): Promise<string | null> {
  const found = elsewhereStatement(account, kind)
  if (!found) return null
  const v = await verifyStatement(cells, found.signed).catch(() => null)
  return v?.ok ? found.value : null
}
