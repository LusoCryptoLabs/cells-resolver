import { decodeRequest, type SignedRequest } from './request.ts'

/**
 * The short link (decision 0021).
 *
 * A signed request written into the link itself is between nine hundred and twenty
 * thousand characters, because a signature is sixty five bytes at best, six hundred
 * from a passkey and sixteen thousand from a post-quantum key. No encoding fixes that:
 * to be as short as the links people are used to, the request has to stop travelling
 * in the link and become something the link points at.
 *
 * Pointing at a server usually means handing that server the contents, and the
 * contents here are an IBAN, a name and an amount. So the request is sealed in the
 * browser before it leaves, and the key to open it lives in the link's fragment,
 * after the `#`, which a browser never sends to the server. What we store is bytes we
 * cannot read; what we file them under is a hash of the key, so the file name leads
 * nowhere either. The promise made in decisions 0017 and 0018 holds: no bank account
 * of anyone's ever reaches our disk in a form we could read.
 *
 * What is genuinely given up is self-containment. The long link works forever with
 * nobody's help; the short one needs this resolver to be up and to still hold the
 * bytes. Both are offered, and the long one is still the honest fallback.
 */

/** 128 bits: 22 characters of base64url, and the floor on how short a link can be. */
const KEY_BYTES = 16
/** 72 bits of file name, 12 characters. Guessing one gains an unreadable blob. */
const ID_BYTES = 9
/** Bumped only if the sealed format changes, which would strand old links. */
export const SEAL_VERSION = 1

/** What a sealed request's length is rounded up to, so the length says little (`sealRequest`). */
export const SEAL_PAD = 512

// The key does two jobs, so it is split into two before doing either: one hash names
// the blob, the other opens it. Knowing the name can never yield the opener.
const ID_INFO = 'cells:shortlink:id:v1'
const ENC_INFO = 'cells:shortlink:key:v1'

function subtle(): SubtleCrypto {
  const c = globalThis.crypto
  if (!c?.subtle) throw new Error('cells: this browser cannot make short links; use the long one')
  return c.subtle
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** A link key: 22 characters of base64url, the only secret in the whole scheme. */
export function newLinkKey(): string {
  const b = new Uint8Array(KEY_BYTES)
  globalThis.crypto.getRandomValues(b)
  return toBase64Url(b)
}

/** Is this the shape of a link key? Cheap enough to run before touching the network. */
export function isLinkKey(key: string): boolean {
  if (!/^[A-Za-z0-9_-]{22}$/.test(key)) return false
  try {
    return fromBase64Url(key).length === KEY_BYTES
  } catch {
    return false
  }
}

async function derive(key: string, info: string, bytes: number): Promise<Uint8Array> {
  const seed = new Uint8Array([...new TextEncoder().encode(info), ...fromBase64Url(key)])
  const h = new Uint8Array(await subtle().digest('SHA-256', seed))
  return h.slice(0, bytes)
}

/** What the resolver files a sealed request under. Derived from the key, never the reverse. */
export async function sealedId(key: string): Promise<string> {
  if (!isLinkKey(key)) throw new Error('cells: that is not a link key')
  return toBase64Url(await derive(key, ID_INFO, ID_BYTES))
}

async function aesKey(key: string): Promise<CryptoKey> {
  const raw = await derive(key, ENC_INFO, 16)
  return subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface Sealed {
  /** The secret, which goes in the link's fragment and nowhere else. */
  key: string
  /** The name the resolver stores it under. */
  id: string
  /** Version, nonce and ciphertext, base64url: what the resolver holds. */
  blob: string
}

/** Seal a signed request so it can be stored by someone who must not be able to read it. */
export async function sealRequest(signed: SignedRequest, key = newLinkKey()): Promise<Sealed> {
  const iv = new Uint8Array(12)
  globalThis.crypto.getRandomValues(iv)
  // Padded with spaces to a multiple of SEAL_PAD bytes before it is sealed. The resolver
  // cannot read a blob, but it can measure one, and without this a request's length gave
  // away its kind: a bank transfer's holder and IBAN are longer than a CKB address. JSON
  // ignores trailing spaces, so every reader, old ones included, opens it unchanged.
  const json = new TextEncoder().encode(JSON.stringify(signed))
  const plain = new Uint8Array(Math.ceil((json.length + 1) / SEAL_PAD) * SEAL_PAD).fill(0x20)
  plain.set(json)
  const ct = new Uint8Array(
    await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await aesKey(key), plain as BufferSource),
  )
  const out = new Uint8Array(1 + iv.length + ct.length)
  out[0] = SEAL_VERSION
  out.set(iv, 1)
  out.set(ct, 1 + iv.length)
  return { key, id: await sealedId(key), blob: toBase64Url(out) }
}

/**
 * Open a sealed request. Every check the long link goes through still runs: what comes
 * out of the seal is parsed by `decodeRequest`, and then verified against the chain the
 * same way, because a request that arrived by a short link is not more trustworthy for
 * having arrived that way. A wrong key, a changed byte or a truncated blob all fail here.
 */
export async function openSealed(key: string, blob: string): Promise<SignedRequest> {
  if (!isLinkKey(key)) throw new Error('cells: that is not a link key')
  let bytes: Uint8Array
  try {
    bytes = fromBase64Url(blob.trim())
  } catch {
    throw new Error('cells: this short link holds nothing readable')
  }
  if (bytes.length < 1 + 12 + 16 || bytes[0] !== SEAL_VERSION)
    throw new Error('cells: this short link holds nothing readable')
  let plain: ArrayBuffer
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: bytes.slice(1, 13) as BufferSource },
      await aesKey(key),
      bytes.slice(13) as BufferSource,
    )
  } catch {
    // One wrong character in the fragment lands here, and so does a tampered blob:
    // the tag covers everything, so there is no telling the two apart, and no need to.
    throw new Error('cells: this link does not open; check it was copied whole')
  }
  return decodeRequest(toBase64Url(new Uint8Array(plain)))
}

/**
 * The link itself: `https://cellula.id/pay#<key>`, forty five characters of it, of
 * which the domain is eighteen and the key twenty two. It rides on the same path the
 * long link uses, so nothing has to tell them apart before the page loads and no
 * one-letter name is quietly taken by a route.
 */
export function shortLink(origin: string, key: string): string {
  return `${origin.replace(/\/+$/, '')}/pay#${key}`
}

/** The key out of a short link, or null if it is not one. */
export function linkKeyFrom(url: string): string | null {
  const i = url.indexOf('#')
  const key = i < 0 ? url : url.slice(i + 1)
  return isLinkKey(key) ? key : null
}
