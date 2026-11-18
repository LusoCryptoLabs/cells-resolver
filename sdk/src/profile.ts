import { ccc } from '@ckb-ccc/core'
import type { Hex, RecordEntry } from './codec.ts'
import { oneRecordPerKey, valueToText } from './codec.ts'

/**
 * What a name publishes about itself, besides where to pay it.
 *
 * Records are free-form: the type script never looks at them (it only checks that the
 * witness hashes to what the cell commits to, and that the owner or manager signed),
 * so any key with any value is valid on chain. That freedom is the point, and it is
 * also why nothing here trusts what it reads. Every value on this page was written by
 * a stranger's wallet and is rendered in a browser, so each one is parsed into a shape
 * the page can render safely, or dropped. Nothing is passed through as it was found.
 *
 * The keys below are the conventional ones. Anything else a name publishes still shows
 * up, under "other details", as escaped text.
 */

export const PROFILE_NAME_KEY = 'profile.name'
export const PROFILE_BIO_KEY = 'profile.bio'
export const PROFILE_AVATAR_KEY = 'profile.avatar'
/** The wide picture across the top of the page, as image bytes, like the avatar. */
export const PROFILE_COVER_KEY = 'profile.cover'
export const PROFILE_ACCENT_KEY = 'profile.accent'
export const PROFILE_LOCATION_KEY = 'profile.location'
/**
 * Which of a name's own records its page should keep behind a tap: a comma-separated
 * list of record keys.
 *
 * It is a display choice, not a secret. Every record is on the chain and served by any
 * resolver, so this hides a value from a glance, a screen in a room or a screenshot, and
 * from nobody else. It is written on the chain like everything else, and a reader is
 * free to ignore it. Anything that must not be seen belongs in a signed payment request
 * (decision 0017), which never touches the chain, or nowhere at all.
 */
export const PROFILE_HIDDEN_KEY = 'profile.hidden'

/**
 * The domain a name claims, as a bare host: `example.com`.
 *
 * Half of a proof, and worthless alone. The other half is the domain publishing the name
 * back, at `https://<domain>/.well-known/cells.txt` or in a TXT record at
 * `_cells.<domain>`, which only somebody who controls the domain can do. A resolver
 * joins the two; nothing here is decided by the registry.
 *
 * It is deliberately not rendered as an ordinary record, which is why `parseProfile`
 * drops the whole `proof.` namespace: a claim shown before it is checked is worth less
 * than nothing, because writing it costs a transaction fee and buys the appearance of
 * a verification that nobody performed.
 */
export const PROOF_DOMAIN_KEY = 'proof.domain'

/**
 * The most a single image record may be **on the way in**, in bytes.
 *
 * It was 64 KB, which was wrong twice over. A record value is length-prefixed with a
 * u16, so 65,535 is the hard ceiling and 65,536 could never be encoded at all: the
 * documented maximum was one byte past what the codec accepts. And the type script
 * cannot verify a witness of 64 KiB or more (see MAX_RECORDS_BYTES, measured), so an
 * avatar anywhere near the old figure took the whole record set past the wall the
 * moment a second image or a few text records sat beside it.
 *
 * 24 KB each, with both images and every text record together bounded by
 * MAX_RECORDS_BYTES, keeps a full profile at less than half of what the chain will
 * verify. The bytes are fee-only, so this is a budget and not a price: 24 KB costs
 * about 0.0005 CKB to publish and nothing to keep. What it really buys is that every
 * later edit, transfer and renewal has to carry these bytes again.
 */
export const MAX_IMAGE_BYTES = 24 * 1024
/** @deprecated the old name for the avatar's own budget; both images share one figure. */
export const MAX_AVATAR_BYTES = MAX_IMAGE_BYTES
/**
 * The most a picture already on chain may be for a page to still show it.
 *
 * Deliberately the codec's own ceiling rather than the budget above: a name that
 * published a larger picture under an older rule keeps showing it. Tightening what may
 * be written should never make what was written disappear.
 */
export const MAX_IMAGE_READ_BYTES = 65_535

/**
 * Image types an avatar may be, decided by magic bytes rather than by anything the
 * owner declares.
 *
 * SVG is deliberately absent. It is a document, it can carry script and remote
 * references, and it would run on the name's own page. The four raster formats cannot.
 * Sniffing rather than trusting a declared type is the same decision: the type is used
 * to build a `data:` URI the browser will honour, so it has to come from the bytes.
 */
const MAGIC: { mime: string; test: (b: Uint8Array) => boolean }[] = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: 'image/webp',
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
]

/** The image type these bytes actually are, or null if they are not a supported image. */
export function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null
  return MAGIC.find((m) => m.test(bytes))?.mime ?? null
}

/**
 * Every character that changes how text reads without being seen: control characters,
 * the direction controls, and everything Unicode marks as ignorable in display, which is
 * the zero-width ones, the invisible operators, the soft hyphen, the Hangul fillers, the
 * variation selectors and the tag characters. A list of ranges kept here by hand missed
 * fifteen of them (review of 2026-09-27), so the set is Unicode's own.
 */
const INVISIBLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}]/gu

/** `s` with every character above replaced by `by`: nothing for a name, a space for a note. */
export function stripInvisible(s: string, by = ''): string {
  return s.replace(INVISIBLE, by)
}

/**
 * Text fit to render: the invisible characters above removed, runs of whitespace
 * collapsed, and cut to `max`.
 *
 * The overrides matter more than they look. U+202E in a display name reverses the text
 * after it, so a name can be made to read as another one; the zero-width characters do
 * the same job by hiding where a string really ends.
 */
export function clampText(s: string, max: number): string {
  const cleaned = stripInvisible(s).replace(/\s+/g, ' ').trim()
  return cleaned.length > max ? cleaned.slice(0, max).trimEnd() : cleaned
}

/**
 * Letters from other alphabets that read as a Latin one, by code point. Not Unicode's
 * whole confusables table: enough for the words of the proof sentence, in the alphabets
 * used to imitate Latin text, capitals included where their small letter reads otherwise.
 */
const LOOKALIKE = new Map<number, string>([
  // Cyrillic
  [0x410, 'a'], [0x430, 'a'], [0x412, 'b'], [0x432, 'b'], [0x421, 'c'], [0x441, 'c'], [0x501, 'd'], [0x415, 'e'], [0x435, 'e'],
  [0x41d, 'h'], [0x43d, 'h'], [0x4ba, 'h'], [0x4bb, 'h'], [0x406, 'i'], [0x456, 'i'], [0x408, 'j'], [0x458, 'j'], [0x41a, 'k'],
  [0x43a, 'k'], [0x4c0, 'l'], [0x4cf, 'l'], [0x41c, 'm'], [0x43c, 'm'], [0x41e, 'o'], [0x43e, 'o'], [0x420, 'p'], [0x440, 'p'],
  [0x51a, 'q'], [0x51b, 'q'], [0x433, 'r'], [0x405, 's'], [0x455, 's'], [0x422, 't'], [0x442, 't'], [0x474, 'v'], [0x475, 'v'],
  [0x51c, 'w'], [0x51d, 'w'], [0x425, 'x'], [0x445, 'x'], [0x423, 'y'], [0x443, 'y'], [0x4ae, 'y'], [0x4af, 'y'],
  // Greek
  [0x391, 'a'], [0x3b1, 'a'], [0x392, 'b'], [0x3b2, 'b'], [0x395, 'e'], [0x3b5, 'e'], [0x397, 'h'], [0x3b7, 'n'], [0x399, 'i'],
  [0x3b9, 'i'], [0x39a, 'k'], [0x3ba, 'k'], [0x39c, 'm'], [0x39d, 'n'], [0x3bd, 'v'], [0x39f, 'o'], [0x3bf, 'o'], [0x3a1, 'p'],
  [0x3c1, 'p'], [0x3a4, 't'], [0x3c4, 't'], [0x3a5, 'y'], [0x3c5, 'u'], [0x3a7, 'x'], [0x3c7, 'x'], [0x396, 'z'], [0x3c9, 'w'],
  // Armenian
  [0x561, 'w'], [0x566, 'q'], [0x570, 'h'], [0x578, 'n'], [0x57d, 'u'], [0x581, 'g'], [0x584, 'p'], [0x585, 'o'], [0x555, 'o'],
  // Latin letters outside a to z, and the small capitals
  [0x131, 'i'], [0x237, 'j'], [0x251, 'a'], [0x261, 'g'], [0x1d00, 'a'], [0x299, 'b'], [0x1d04, 'c'], [0x1d05, 'd'], [0x1d07, 'e'],
  [0x262, 'g'], [0x29c, 'h'], [0x26a, 'i'], [0x1d0a, 'j'], [0x1d0b, 'k'], [0x29f, 'l'], [0x1d0d, 'm'], [0x274, 'n'], [0x1d0f, 'o'],
  [0x1d18, 'p'], [0x280, 'r'], [0xa731, 's'], [0x1d1b, 't'], [0x1d1c, 'u'], [0x1d20, 'v'], [0x1d21, 'w'], [0x28f, 'y'], [0x1d22, 'z'],
])

/** Text reduced to the Latin letters it reads as: folded, stripped of accents and lookalikes, nothing else kept. */
function readsAs(s: string): string {
  const folded = s.normalize('NFKC').normalize('NFD').replace(/\p{M}/gu, '')
  return Array.from(folded, (c) => LOOKALIKE.get(c.codePointAt(0)!) ?? c)
    .join('')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
}

/** The words the page uses when a domain has answered for a name (Profile.tsx, NamePage.tsx). */
const PROOF_WORDS = ['answersforthisname', 'answersforthename', 'vouchesforthename', 'vouchesforthisname']

/**
 * Whether text reads as the sentence the page prints when a domain has answered for a
 * name. That sentence is only printed after the resolver found the domain's own half, and
 * a bio saying "binance.com answers for this name" sat right above where it goes, looking
 * the same (review of 2026-09-27). Read through lookalike letters, fullwidth forms,
 * accents and punctuation, since those are the ways to say it without spelling it.
 */
export function imitatesProof(text: string): boolean {
  const flat = readsAs(text)
  return PROOF_WORDS.some((w) => flat.includes(w))
}

/** Profile text as it may be shown, or '' when it is empty or imitates the proof sentence. */
function shown(s: string, max: number): string {
  const t = clampText(s, max)
  return imitatesProof(t) ? '' : t
}

/**
 * A handle, reduced to the characters handles are made of. Defends the URLs built from it.
 *
 * People paste the whole profile URL, because that is what is in the address bar and on
 * the clipboard. So a value carrying a path is reduced to its last segment first:
 * `https://github.com/telmo` and `github.com/telmo/` and `@telmo` all mean `telmo`.
 * Stripping the punctuation without doing that produced `httpsgithub.comtelmo`, a link
 * that went nowhere and looked like the user's own mistake.
 */
/**
 * A Mastodon account, which is a user at a server: `@alice@mastodon.social`, `alice@mastodon.social`
 * or `https://mastodon.social/@alice`. The general handle cleaning drops the `@` and keeps a
 * URL's last segment, which loses the server, so Mastodon is read here instead. The link is
 * built from the parts, never taken from the record.
 */
export function mastodonAccount(v: string): { handle: string; url: string } | null {
  const s = v.trim()
  const at = /^@?([A-Za-z0-9_]{1,30})@([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)$/i.exec(s)
  const url = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+)\/@([A-Za-z0-9_]{1,30})\/?$/i.exec(s)
  const user = at ? at[1] : url ? url[5] : null
  const host = (at ? at[2] : url ? url[1] : '').toLowerCase()
  if (!user || !host) return null
  return { handle: `@${user}@${host}`, url: `https://${host}/@${user}` }
}

function clampHandle(s: string): string {
  let v = s.trim()
  if (v.includes('/')) {
    const parts = v.replace(/[?#].*$/, '').split('/').filter(Boolean)
    // Drop the scheme and host, keep the last path segment, which is the handle on
    // every platform here (…/telmo, …/in/telmo, …/user/telmo, …/profile/telmo).
    v = parts[parts.length - 1] ?? ''
  }
  return v
    .replace(/^@+/, '')
    .replace(/[^A-Za-z0-9._~-]/g, '')
    .slice(0, 64)
}

/**
 * One label of an international host, from the ASCII form a URL gives (`xn--…`, without
 * the prefix) back to what it reads as, or null when it is not valid Punycode (RFC 3492).
 * Needed because a browser's URL hands every host over in ASCII and has nothing to turn
 * it back.
 */
export function punycodeToUnicode(input: string): string | null {
  const base = 36
  const out: number[] = []
  const cut = Math.max(0, input.lastIndexOf('-'))
  for (let j = 0; j < cut; j++) {
    if (input.charCodeAt(j) >= 0x80) return null
    out.push(input.charCodeAt(j))
  }
  const digit = (c: number) => (c >= 0x30 && c < 0x3a ? c - 22 : c >= 0x41 && c < 0x5b ? c - 0x41 : c >= 0x61 && c < 0x7b ? c - 0x61 : base)
  let n = 128
  let bias = 72
  let i = 0
  for (let at = cut > 0 ? cut + 1 : 0; at < input.length; ) {
    const before = i
    for (let w = 1, k = base; ; k += base) {
      if (at >= input.length) return null
      const d = digit(input.charCodeAt(at++))
      if (d >= base) return null
      i += d * w
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias
      if (d < t) break
      w *= base - t
      if (i > 0x10ffff * 64 || w > 0x10ffff * 64) return null
    }
    const len = out.length + 1
    let delta = before === 0 ? Math.floor((i - before) / 700) : (i - before) >> 1
    delta += Math.floor(delta / len)
    let k = 0
    while (delta > 455) {
      delta = Math.floor(delta / 35)
      k += base
    }
    bias = k + Math.floor((36 * delta) / (delta + 38))
    n += Math.floor(i / len)
    i %= len
    if (n > 0x10ffff) return null
    out.splice(i++, 0, n)
  }
  return String.fromCodePoint(...out)
}

const SCRIPTS = ['Latin', 'Cyrillic', 'Greek', 'Armenian', 'Georgian', 'Cherokee', 'Hebrew', 'Arabic', 'Thai', 'Devanagari', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Bopomofo'].map(
  (s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')] as const,
)
const NO_SCRIPT = /[\p{Script=Common}\p{Script=Inherited}]/u
const CJK_MIXES = [['Latin', 'Han', 'Hiragana', 'Katakana'], ['Latin', 'Han', 'Bopomofo'], ['Latin', 'Han', 'Hangul']]
/**
 * Whether one label of a host mixes alphabets: `paypal` spelt with one Cyrillic letter,
 * which no honest domain needs and every lookalike does. Digits and hyphens belong to no
 * alphabet. Latin beside Japanese, Chinese or Korean writing is the one mix that is
 * ordinary, and is allowed, as browsers allow it.
 */
export function mixesScripts(label: string): boolean {
  const seen = new Set<string>()
  for (const c of label) if (!NO_SCRIPT.test(c)) seen.add(SCRIPTS.find(([, re]) => re.test(c))?.[0] ?? 'other')
  return seen.size > 1 && !CJK_MIXES.some((mix) => [...seen].every((s) => mix.includes(s)))
}

/**
 * An `https:` URL, or null.
 *
 * A bare host gets `https://` put in front, because that is how people write a website
 * down. Anything else has to already be https: `javascript:`, `data:` and the rest are
 * refused rather than escaped, since there is no safe way to render them as a link
 * someone might click, and `http:` is refused as well, since a page this site links to
 * should not be one anybody on the way can rewrite.
 *
 * Refused too, because each one makes a link read as one site and go to another: a user
 * name or password in front of the host (`https://cellula.id@evil.com` goes to evil.com),
 * and a host label that mixes alphabets, written out or as Punycode.
 */
export function safeUrl(v: string): string | null {
  const s = clampText(v, 300)
  if (!s) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (!u.hostname.includes('.')) return null
  for (const label of u.hostname.split('.')) {
    if (!label.startsWith('xn--')) continue
    const read = punycodeToUnicode(label.slice(4))
    if (read === null || mixesScripts(read)) return null
  }
  return u.toString()
}

/**
 * A website link as the page shows it: the host exactly as the browser will ask for it,
 * which for an international host is its ASCII form, then the path. The text a person
 * wrote could read as another site (a host spelt all in Cyrillic can read as apple.com);
 * this cannot.
 */
function websiteText(url: string): string {
  const u = new URL(url)
  let rest = u.pathname + u.search + u.hash
  try {
    rest = decodeURI(rest)
  } catch {
    // shown as the URL carries it
  }
  return clampText(u.host + rest, 300).replace(/\/$/, '')
}

/**
 * The platforms a `profile.<x>` key is known to mean, and how to turn the handle it
 * holds into a link. The URL is built here out of a cleaned handle rather than taken
 * from the record, so a hostile value cannot choose where the link points.
 */
const PLATFORMS: Record<string, { label: string; url: (h: string) => string | null }> = {
  website: { label: 'website', url: safeUrl },
  twitter: { label: 'X', url: (h) => (h ? `https://x.com/${h}` : null) },
  x: { label: 'X', url: (h) => (h ? `https://x.com/${h}` : null) },
  github: { label: 'GitHub', url: (h) => (h ? `https://github.com/${h}` : null) },
  telegram: { label: 'Telegram', url: (h) => (h ? `https://t.me/${h}` : null) },
  instagram: { label: 'Instagram', url: (h) => (h ? `https://instagram.com/${h}` : null) },
  youtube: { label: 'YouTube', url: (h) => (h ? `https://youtube.com/@${h}` : null) },
  linkedin: { label: 'LinkedIn', url: (h) => (h ? `https://linkedin.com/in/${h}` : null) },
  reddit: { label: 'Reddit', url: (h) => (h ? `https://reddit.com/user/${h}` : null) },
  bluesky: { label: 'Bluesky', url: (h) => (h ? `https://bsky.app/profile/${h}` : null) },
  mastodon: { label: 'Mastodon', url: (h) => mastodonAccount(h)?.url ?? null },
  farcaster: { label: 'Farcaster', url: (h) => (h ? `https://warpcast.com/${h}` : null) },
  discord: { label: 'Discord', url: () => null }, // a handle, not an address: shown, not linked
  email: { label: 'email', url: () => null }, //     shown as text, never a mailto: link
  phone: { label: 'phone', url: () => null }, //     likewise, never a tel: link
  nostr: { label: 'Nostr', url: () => null },
}

/**
 * Keys whose value is a contact rather than a handle on a platform.
 *
 * They skip `clampHandle`, which exists to make a URL safe to build and would eat an
 * email at the `@` and a phone number at its `+` and spaces. Nothing here is ever turned
 * into a link, so there is no URL to defend; the value is cleaned as text and shown.
 */
const CONTACT_KEYS = new Set(['email', 'phone'])

/** The keys that are a profile field in their own right, rather than a link. */
const FIELD_KEYS = new Set<string>([
  PROFILE_HIDDEN_KEY,
  PROFILE_NAME_KEY,
  PROFILE_BIO_KEY,
  PROFILE_AVATAR_KEY,
  PROFILE_COVER_KEY,
  PROFILE_ACCENT_KEY,
  PROFILE_LOCATION_KEY,
])

export interface ProfileLink {
  /** The record key it came from, so a list can be keyed on it. */
  key: string
  /** What to call it: the record's own `label` if it set one, else the platform's name. */
  title: string
  /** What was published: a handle, or a host. */
  handle: string
  /** Where it goes, or null for a platform with no linkable profile (Discord, email). */
  url: string | null
}

export interface Profile {
  /** A chosen display name. It never replaces the `.cell` name, it sits beside it. */
  name: string | null
  bio: string | null
  location: string | null
  /** Sniffed image bytes, or null. The page builds the `data:` URI from `mime`. */
  avatar: { bytes: Uint8Array; mime: string } | null
  /** The wide picture across the top, same rules as the avatar and just as optional. */
  cover: { bytes: Uint8Array; mime: string } | null
  /** `#rrggbb`, already known to be one. Making it readable is the page's job. */
  accent: string | null
  links: ProfileLink[]
  /** Everything else the name publishes, shown as escaped text under its own heading. */
  other: { key: string; title: string; text: string }[]
  /**
   * Record keys the owner asked a page to keep behind a tap. A hint, not a secret: see
   * PROFILE_HIDDEN_KEY. A page may honour it or ignore it, and every value stays public.
   */
  hidden: Set<string>
}

/** The hidden list as it is written: keys separated by commas, spaces forgiven, capped. */
export function parseHidden(v: string): Set<string> {
  return new Set(
    v
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && k.length <= 64)
      .slice(0, 64),
  )
}

/** True for a record key whose value is meant to be read as text. */
export function isTextKey(key: string): boolean {
  if (key === PROFILE_AVATAR_KEY || key === PROFILE_COVER_KEY) return false // raw image bytes, not text
  return (
    key.startsWith('address.') ||
    key === 'fiber.addr' ||
    key.startsWith('lightning.') ||
    key.startsWith('profile.') ||
    key.startsWith('dweb.') ||
    key.startsWith('proof.')
  )
}

/** `#rrggbb` and nothing else. Three-digit and named colours are refused, not expanded. */
export function isAccent(v: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(v.trim())
}

/** Decode a record value as text, without letting an undecodable one reach the page. */
function text(v: Hex | string): string {
  try {
    const t = valueToText(v as Hex)
    // U+FFFD means the bytes were not text at all, so there is nothing to show.
    return t.includes('�') ? '' : t
  } catch {
    return ''
  }
}

/**
 * The human name of a `profile.<x>` key, or null when it is not a platform we know.
 *
 * The table it reads was already here, used to title a link on the public page. It was
 * not reachable from `recordKeyLabel`, so the owner's own list of records showed `ckb`
 * and `eth` beside `profile.website` and `profile.github`: the same list, half of it
 * translated and half of it raw, with the translation sitting unused three functions
 * away. Seen on a phone on 2026-09-21.
 */
export function platformLabel(key: string): string | null {
  if (!key.startsWith('profile.')) return null
  return PLATFORMS[key.slice('profile.'.length)]?.label ?? null
}

/**
 * Read a name's record set into the shape the public page renders. Anything malformed,
 * unsupported or unsafe is dropped here, once, rather than guarded again at each place
 * it would be rendered.
 *
 * The keys the payment sections already own (`address.*`, `lightning.*`, `fiber.*`) are
 * left out: they are read separately and would otherwise appear twice on the page. So is
 * `proof.*`, for a stronger reason: it is rendered only after a check, and printing the
 * raw claim beside the checked sentence would let anybody put a domain they do not own
 * on their own name.
 */
export function parseProfile(records: RecordEntry[]): Profile {
  const p: Profile = { name: null, bio: null, location: null, avatar: null, cover: null, accent: null, links: [], other: [], hidden: new Set<string>() }

  // The first of a key written twice, as every other reader takes it (codec.ts).
  for (const r of oneRecordPerKey(records)) {
    const key = r.key
    // Keys that have a rendering of their own and must not also appear as raw text.
    //
    // `proof.` is here for a second reason, and it is the important one: a claim that has
    // not been confirmed must not be shown at all. The page prints "example.com answers
    // for this name" only when the resolver found the domain's half; if the raw record
    // also fell through to "other details", then writing `proof.domain = binance.com`
    // would put the word "binance.com" on any name, confirmed by nobody, which is the
    // impersonation this whole feature exists to make impossible. Seen on a phone on
    // 2026-09-21: the sentence at the top and `proof.domain lusocryptolabs.com` at the
    // bottom, the second one saying it with no check behind it.
    if (
      key.startsWith('address.') ||
      key.startsWith('lightning.') ||
      key.startsWith('fiber.') ||
      key.startsWith('proof.')
    )
      continue

    if (key === PROFILE_AVATAR_KEY || key === PROFILE_COVER_KEY) {
      let bytes: Uint8Array
      try {
        bytes = ccc.bytesFrom(r.value as Hex)
      } catch {
        continue
      }
      // Read against the codec's ceiling, not the write budget: see MAX_IMAGE_READ_BYTES.
      if (bytes.length > MAX_IMAGE_READ_BYTES) continue
      const mime = sniffImage(bytes)
      if (mime) {
        if (key === PROFILE_AVATAR_KEY) p.avatar = { bytes, mime }
        else p.cover = { bytes, mime }
      }
      continue
    }

    if (FIELD_KEYS.has(key)) {
      const v = text(r.value)
      if (key === PROFILE_HIDDEN_KEY) {
        p.hidden = parseHidden(v)
        continue
      }
      // `shown` drops a value that reads as the proof sentence: these three sit right above it.
      if (key === PROFILE_NAME_KEY) p.name = shown(v, 64) || null
      else if (key === PROFILE_BIO_KEY) p.bio = shown(v, 200) || null
      else if (key === PROFILE_LOCATION_KEY) p.location = shown(v, 64) || null
      else if (key === PROFILE_ACCENT_KEY) p.accent = isAccent(v) ? v.trim().toLowerCase() : null
      continue
    }

    const platform = key.startsWith('profile.') ? key.slice('profile.'.length).toLowerCase() : null
    const known = platform ? PLATFORMS[platform] : undefined
    if (known) {
      const raw = text(r.value)
      const title = shown(r.label, 40) || known.label
      if (platform === 'website') {
        // Shown only as a link, and as the address the link goes to. A refused address
        // shown as text could still read as somebody else's site.
        const url = safeUrl(raw)
        if (url) p.links.push({ key, title, handle: websiteText(url), url })
        continue
      }
      if (platform === 'mastodon') {
        const m = mastodonAccount(raw)
        if (m) p.links.push({ key, title, handle: m.handle, url: m.url })
        continue
      }
      const handle = CONTACT_KEYS.has(platform!) ? shown(raw, 120) : clampHandle(raw)
      if (!handle) continue
      p.links.push({ key, title, handle, url: known.url(handle) })
      continue
    }

    // Anything else, including dweb.* and any key the owner invented. It is shown, so
    // that publishing a custom record is worth doing, but only ever as escaped text. The
    // key is shown when there is no label, so it is cleaned like the rest.
    const v = shown(text(r.value), 200)
    const title = shown(r.label, 40) || shown(key, 64)
    if (v && title) p.other.push({ key, title, text: v })
  }

  return p
}

/**
 * The bytes a record set puts in the witness, which is the whole of what publishing it
 * costs. Mirrors the wire format in `encodeWitness`: per record, a u8-prefixed key and
 * label, a u16-prefixed value, and a u32 ttl.
 */
export function profileBytes(records: RecordEntry[]): number {
  const utf8 = new TextEncoder()
  const hexLen = (h: string) => (typeof h === 'string' && h.startsWith('0x') ? (h.length - 2) / 2 : 0)
  let n = 2 // the u16 record count
  // key and label go on the wire as UTF-8 text, value as the raw bytes it already is.
  for (const r of records) n += 1 + utf8.encode(r.key).length + 1 + utf8.encode(r.label).length + 2 + hexLen(r.value) + 4
  return n
}
