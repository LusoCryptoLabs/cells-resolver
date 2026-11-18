/**
 * A name held as a deed (decision 0036).
 *
 * The type script proves ownership by asking for an input under the name's owner lock.
 * `input-type-proxy-lock` is a public lock that opens for any transaction spending the
 * cell whose type hash is in its args. Put a Spore's type hash there, make the name's
 * owner that lock, keep one small cell under it, and whoever holds the Spore controls
 * the name. Nothing in the contracts changes.
 *
 * This file is the part that does not sign: how the proxy lock is derived, what the
 * small cell under it carries so the link can be followed both ways, how the deed's
 * DNA is laid out so a wallet draws the name's own mark, and the checks a co-signer
 * runs before lending its signature to the cluster. The transactions live in
 * `client.ts`, next to the other owner actions.
 */
import { ccc } from '@ckb-ccc/core'
import { JsonRpcTransformers } from '@ckb-ccc/core/advanced'
import { findSpore, getSporeScriptInfo } from '@ckb-ccc/spore'
import { unpackToRawSporeData } from '@ckb-ccc/spore/advanced'
import { buildAccountData, ID_LEN, ownerId, type Hex } from './codec.ts'
import { permissiveLock } from './owner.ts'

/**
 * What a deed's proxy cell says about itself: magic, then the Spore id (32 bytes), then
 * the account id (20 bytes, as the cell model stores it). 60 bytes, so the cell is 133 CKB.
 */
export const DEED_MAGIC = '0x43454c4c44454544' // "CELLDEED"
const SPORE_ID_LEN = 32

export interface DeedLink {
  /** The deed itself, a Spore. `null` for an older proxy cell that carries no data. */
  sporeId: Hex | null
  /** The type hash the proxy lock is keyed on; the deed's type script hashes to it. */
  sporeTypeHash: Hex
  /** The name's owner id under this deed, `ownerId(proxyLock.hash())`. */
  ownerId: Hex
  proxy: { outPoint: { txHash: Hex; index: number }; capacity: bigint; lock: ccc.Script; data: Hex }
}

export interface Deed extends DeedLink {
  /** Who holds the Spore right now, from its lock. `null` when the Spore cannot be found. */
  holder: { lock: ccc.Script; address: string } | null
  /**
   * What the deed's own bytes say: the name it was minted for, the date printed on it,
   * the colourway. `null` when the Spore is gone, or its content is not one of ours.
   */
  card: { label: string; expiry: string; palette: string } | null
  /** The cluster the Spore was minted into, so a card of an older design can be told apart. */
  cluster: Hex | null
  /**
   * Why the deed should not be trusted at face value, from the chain rather than from
   * the picture. Empty means the card is telling the truth today.
   *
   * - `melted`: the Spore no longer exists, so nobody can act on the name and it stays
   *   frozen until it lapses and somebody recycles it.
   * - `expired`: the name has lapsed; anyone may recycle it after the grace period, and
   *   the deed would then stand for nothing.
   * - `renamed`: the deed was minted for another name. It cannot happen through our own
   *   co-signer, which is exactly what it is there to prevent, so it means somebody
   *   built the deed by hand.
   */
  stale: ('melted' | 'expired' | 'renamed')[]
}

// ---- the lock ---------------------------------------------------------------------

/** The proxy lock over a Spore: opens for any transaction that spends that Spore. */
export async function deedLock(client: ccc.Client, sporeTypeHash: Hex): Promise<ccc.Script> {
  return ccc.Script.fromKnownScript(client, ccc.KnownScript.InputTypeProxyLock, sporeTypeHash)
}

/** The Spore's type script, from its id, and so the hash the proxy lock is keyed on. */
export function sporeTypeOf(client: ccc.Client, sporeId: Hex): ccc.Script {
  const info = getSporeScriptInfo(client)
  return ccc.Script.from({ codeHash: info.codeHash, hashType: info.hashType, args: sporeId })
}

export async function deedOwnerIdOf(client: ccc.Client, sporeId: Hex): Promise<Hex> {
  return ownerId((await deedLock(client, sporeTypeOf(client, sporeId).hash())).hash() as Hex)
}

// ---- the proxy cell's data --------------------------------------------------------

export function encodeDeedProxyData(sporeId: Hex, accountId: Hex): Hex {
  const s = ccc.bytesFrom(sporeId)
  const a = ccc.bytesFrom(accountId)
  if (s.length !== SPORE_ID_LEN || a.length !== ID_LEN) throw new Error(`cells: a deed proxy cell names a ${SPORE_ID_LEN}-byte spore id and a ${ID_LEN}-byte account id`)
  return ccc.hexFrom(ccc.bytesConcat(ccc.bytesFrom(DEED_MAGIC), s, a))
}

export function decodeDeedProxyData(data: Hex): { sporeId: Hex; accountId: Hex } | null {
  const b = ccc.bytesFrom(data)
  const magic = ccc.bytesFrom(DEED_MAGIC)
  if (b.length !== magic.length + SPORE_ID_LEN + ID_LEN) return null
  for (let i = 0; i < magic.length; i++) if (b[i] !== magic[i]) return null
  return {
    sporeId: ccc.hexFrom(b.slice(magic.length, magic.length + SPORE_ID_LEN)),
    accountId: ccc.hexFrom(b.slice(magic.length + SPORE_ID_LEN)),
  }
}

// ---- the DNA and the picture ------------------------------------------------------
//
// A DOB/1 cluster whose description draws the deed: the DOB/0 stage reads the label,
// the expiry, the colours and the 66 cells of the name's own mark out of the DNA, the
// DOB/1 stage places them in an SVG. No image is referenced anywhere, so nothing is
// fetched and nothing can show as "not supported". The mark is the 11 by 11 grid the
// site draws from the account id (`ui/src/Mark.tsx`, the gateway's `/avatar`), one bit
// per cell, mirrored down the middle.

export const DEED_LABEL_MAX = 40
const ROWS = 11
const HALF = 6
const CELLS = ROWS * HALF
const OFF = { label: 0, expiry: 40, fit: 50, ink: 51, tile: 57, palette: 63, cells: 64 }
export const DEED_DNA_LEN = OFF.cells + CELLS
const FITS: [string, number, number][] = [
  ['xl', 56, 12], // class, font size, up to this many characters of "label.cell"
  ['l', 44, 15],
  ['m', 32, 21],
  ['s', 22, 31],
  ['xs', 15, 46],
]

/**
 * The colourways a deed can be drawn in: ink, tile, and the name the wallet lists as a
 * trait. One byte of the account id picks the pair, so a wallet holding several deeds
 * shows a set rather than twelve of the same green tile, and the house lime is the
 * commonest because three of the twelve slots are it.
 *
 * It is taken from the id and nothing else. A name's published accent would have done
 * too, but the DNA never changes and the accent does, so the card would start lying the
 * first time somebody edited their profile.
 */
export const DEED_PALETTES: [string, string, string][] = [
  ['cbf34d', '2b3512', 'lime'],
  ['cbf34d', '2b3512', 'lime'],
  ['cbf34d', '2b3512', 'lime'],
  ['f3b64d', '3a2a10', 'amber'],
  ['4df3d2', '10332e', 'mint'],
  ['4dc4f3', '102a38', 'ice'],
  ['f37a4d', '3a1d10', 'coral'],
  ['e14df3', '33103a', 'orchid'],
  ['f3e94d', '35330f', 'gold'],
  ['9d4df3', '22103a', 'violet'],
  ['f34d6e', '3a1019', 'rose'],
  ['7bf34d', '17350f', 'grass'],
]

/** Which colourway a name's deed is drawn in, from the last byte of its account id. */
export function deedPaletteIndex(id: Hex): number {
  return parseInt(id.slice(-2), 16) % DEED_PALETTES.length
}

/** One byte per cell, 0 or 1, in the order the site reads its bits: row * 6 + col. */
export function markCells(id: Hex): Uint8Array {
  const hex = id.replace(/^0x/, '')
  const bit = (n: number) => (parseInt(hex[n >> 2] ?? '0', 16) >> (n & 3)) & 1
  return Uint8Array.from({ length: CELLS }, (_, n) => bit(n))
}

function fitFor(label: string): number {
  const n = label.length + '.cell'.length
  const i = FITS.findIndex(([, , max]) => n <= max)
  return i < 0 ? FITS.length - 1 : i
}

/** `YYYY-MM-DD` of a unix time, in UTC, as the card prints it. */
export function deedExpiryText(expiredAt: number): string {
  return new Date(expiredAt * 1000).toISOString().slice(0, 10)
}

/**
 * The deed's DNA for a name. Deterministic from the name, which is what lets a
 * co-signer recompute it and refuse anything else.
 */
export function deedDna(a: { label: string; id: Hex; expiredAt: number }): Uint8Array {
  if (!/^[a-z0-9.-]{1,40}$/.test(a.label)) throw new Error(`cells: ${JSON.stringify(a.label)} is not a label`)
  const enc = (s: string) => new TextEncoder().encode(s)
  const p = deedPaletteIndex(a.id)
  const dna = new Uint8Array(DEED_DNA_LEN)
  dna.set(enc(a.label), OFF.label)
  dna.set(enc(deedExpiryText(a.expiredAt)), OFF.expiry)
  dna[OFF.fit] = fitFor(a.label)
  dna.set(enc(DEED_PALETTES[p][0]), OFF.ink)
  dna.set(enc(DEED_PALETTES[p][1]), OFF.tile)
  dna[OFF.palette] = p
  dna.set(markCells(a.id), OFF.cells)
  return dna
}

/** The Spore's content for a deed: the DOB marker byte, then the DNA. */
export function deedContent(a: { label: string; id: Hex; expiredAt: number }): Uint8Array {
  return Uint8Array.from([0, ...deedDna(a)])
}

/**
 * What a deed's own bytes say, read back: which name it stands for and the date printed
 * on it. The DNA never changes, so a renewal moves the name's real expiry past this one;
 * that is why the card says "at least until" and why the resolver compares the two.
 */
export function deedCard(content: ccc.BytesLike): { label: string; expiry: string; palette: string } | null {
  const b = ccc.bytesFrom(content)
  if (b.length !== DEED_DNA_LEN + 1 || b[0] !== 0) return null
  const text = (from: number, to: number) => new TextDecoder().decode(b.slice(from, to)).replace(/\0+$/, '')
  const label = text(1 + OFF.label, 1 + OFF.expiry)
  const expiry = text(1 + OFF.expiry, 1 + OFF.fit)
  if (!/^[a-z0-9.-]{1,40}$/.test(label) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null
  return { label, expiry, palette: DEED_PALETTES[b[1 + OFF.palette]]?.[2] ?? 'lime' }
}

// The deployed decoders, referenced by code hash: the same hash on both networks.
const DOB0 = { type: 'code_hash', hash: '0x13cac78ad8482202f18f9df4ea707611c35f994375fa03ae79121312dda9925c' }
const DOB1 = { type: 'code_hash', hash: '0xda3525549b72970b4c95f5b5749357f20d1293d335710b674f09c32f7d54b6dc' }
const GROUND = '#14120e'
// The whole mark, centred above the band: 344 square at (78, 11), so the eleven rows sit 27
// from the top edge and 27 from the band, and the columns 94 from each side. It used to be
// 550 wide and 70 above the card, bleeding past three edges with the band over its last
// two rows, which kept rows 0, 9 and 10 of every mark off the picture (bitcoin.cell lost
// cells at the top and the bottom; 2026-09-27). test/deed.test.ts holds every cell to the card.
const MARK = { x: 78, y: 11, size: 344, pad: 0.04 }
const BAND = 366
const MONO = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
const f2 = (n: number) => n.toFixed(2).replace(/\.?0+$/, '')

/** The date trait as a wallet lists it. */
export const EXPIRY_TRAIT = 'registered at least until'

export function deedClusterName(testnet: boolean): string {
  const net = testnet ? 'pudge' : 'mainnet'
  return net === 'mainnet' ? '.cell deeds' : `.cell deeds (${net})`
}

/** The cluster description, as JSON text. Byte for byte what the cluster cell carries. */
export function deedClusterDescription(): string {
  const pad = MARK.size * MARK.pad
  const cell = (MARK.size - pad * 2) / ROWS
  const gap = cell * 0.08
  const side = cell - gap * 2
  const dob0: unknown[] = [
    ['name', 'String', OFF.label, DEED_LABEL_MAX, 'utf8', []],
    // Named for what stays true: a renewal moves the name's expiry past this date, and a
    // trait called "expires" listed the old date as the expiry from the first renewal on.
    [EXPIRY_TRAIT, 'String', OFF.expiry, 10, 'utf8', []],
    ['palette', 'String', OFF.palette, 1, 'options', DEED_PALETTES.map(([, , n]) => n)],
    // underscored traits are read by the DOB/1 stage and dropped from what the wallet lists
    ['_fit', 'String', OFF.fit, 1, 'options', FITS.map(([c]) => c)],
    ['_ink', 'String', OFF.ink, 6, 'utf8', []],
    ['_tile', 'String', OFF.tile, 6, 'utf8', []],
    ...Array.from({ length: CELLS }, (_, n) => [`_m${n}`, 'String', OFF.cells + n, 1, 'options', ['0', '1']]),
  ]
  const cellRows: unknown[] = []
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < HALF; col++) {
      const n = row * HALF + col
      const cols = col === HALF - 1 ? [col] : [col, ROWS - 1 - col]
      const uses = cols
        .map((c) => `<use href='#c' x='${f2(MARK.x + pad + c * cell + gap)}' y='${f2(MARK.y + pad + row * cell + gap)}'/>`)
        .join('')
      cellRows.push(['IMAGE.0', 'elements', `_m${n}`, 'options', [['1', uses], [['*'], '']]])
    }
  }
  const dob1: unknown[] = [
    ['IMAGE.0', 'attributes', '', 'raw', "xmlns='http://www.w3.org/2000/svg' viewBox='0 0 500 500' width='500' height='500'"],
    ['IMAGE.0', 'elements', '', 'raw', `<rect width='500' height='500' fill='${GROUND}'/><defs><rect id='c' width='${f2(side)}' height='${f2(side)}' rx='${f2(side * 0.2)}'/></defs>`],
    ['IMAGE.0', 'elements', '_tile', 'raw', `<rect width='500' height='500' fill='#{value}'/>`],
    ['IMAGE.0', 'elements', '_ink', 'raw', `<style>.k{fill:#{value}}</style><g class='k'>`],
    ...cellRows,
    ['IMAGE.0', 'elements', '', 'raw', `</g><rect y='${BAND}' width='500' height='${500 - BAND}' fill='${GROUND}'/>`],
    ['IMAGE.0', 'elements', '_fit', 'options', [...FITS.map(([c, px]) => [c, `<style>.t{font-size:${px}px}</style>`]), [['*'], '']]],
    ['IMAGE.0', 'elements', '_ink', 'raw', `<style>.t{fill:#{value}}</style>`],
    ['IMAGE.0', 'elements', 'name', 'raw', `<text class='t' x='40' y='434' font-family="${MONO}" font-weight='700'>{value}.cell</text>`],
    // "at least": the DNA never changes and a renewal moves the date on.
    //
    // Two texts rather than one with a separator, because the card must stay ASCII.
    // A renderer that turns the SVG into a data URI with `btoa` writes Latin-1 bytes,
    // and a single non-ASCII character (a middle dot, in the first try) then lands as a
    // lone byte that is not valid UTF-8, so the browser gives up on the whole picture
    // and the wallet shows nothing. Found on the CKB explorer on 2026-09-24, with the
    // control that the same card renders when its bytes are all ASCII.
    ['IMAGE.0', 'elements', EXPIRY_TRAIT, 'raw', `<text x='40' y='468' fill='#8f8b7e' font-family="${MONO}" font-size='14'>at least until {value}</text>`],
    ['IMAGE.0', 'elements', '', 'raw', `<text x='460' y='468' text-anchor='end' fill='#565245' font-family="${MONO}" font-size='14'>cellula.id</text>`],
  ]
  return JSON.stringify({
    description:
      'A .cell name, held as a deed on cellula.id. While the name is owned by the proxy lock over this object, holding it is holding the name. The pattern is the one the name draws for itself from its account id. Renewing moves the date on; the card keeps the one it was minted with. The card cannot read the chain, so check the name on cellula.id before buying it.',
    dob: { ver: 1, decoders: [{ decoder: DOB0, pattern: dob0 }, { decoder: DOB1, pattern: dob1 }] },
  })
}


/**
 * Whether a deed still holds a name, judged from every live name. `live`: some name is
 * owned by the proxy lock over this Spore, whatever its card says. Otherwise the deed
 * holds nothing, and the card's own name tells why: `elsewhere` when that name exists
 * but is owned by something else now (registered again after a recycle, or moved by a
 * raw transaction), `gone` when it lapsed and was recycled, or the card is unreadable.
 * Only a deed that is not live may be melted on its own; melting a live one freezes its
 * name until it lapses.
 */
export function deedStanding(
  accounts: Iterable<{ label: string; ownerLockHash: string }>,
  proxyOwnerId: string,
  cardLabel: string | null,
): 'live' | 'gone' | 'elsewhere' {
  let named = false
  for (const a of accounts) {
    if (a.ownerLockHash === proxyOwnerId) return 'live'
    if (cardLabel !== null && a.label === cardLabel) named = true
  }
  return named ? 'elsewhere' : 'gone'
}

// ---- following the link -----------------------------------------------------------

async function proxyLockPrefix(client: ccc.Client): Promise<ccc.ScriptLike> {
  const info = await client.getKnownScript(ccc.KnownScript.InputTypeProxyLock)
  return { codeHash: info.codeHash, hashType: info.hashType, args: '0x' }
}

/**
 * The proxy cell behind a name whose owner is a deed's lock, or `null` when the name is
 * owned by a key. By its exact lock, which is the one thing about it a stranger cannot
 * fake: the lock's hash is the name's owner id. The lock is learned first from the
 * transaction that made the name cell as it is (`a.outPoint`), because making a deed and
 * every act through one write the proxy cell beside the name; then from any record that
 * names this account, each only a key to one exact query; and last, for a proxy cell made
 * before records existed, by walking every cell under the proxy lock.
 *
 * Until 2026-09-27 the walks were all there was, and each gave up after so many cells, so
 * two hundred decoys (cells under proxy locks of their own, with this account's id in their
 * data) ahead of the real one made a live deed read as no deed.
 */
export async function deedLinkOf(
  client: ccc.Client,
  a: { id: Hex; ownerLockHash: Hex; outPoint?: { txHash: string; index: number } },
): Promise<DeedLink | null> {
  const prefix = await proxyLockPrefix(client)
  // What a cell proves and what it merely says. The lock proves the name is held under
  // it, because the owner id is its hash. The data is written by whoever made the cell,
  // and anyone may make a cell under any lock, so the Spore it names counts only when
  // that Spore's type script hashes to the lock's own args. A cell that lies about the
  // Spore is treated as a cell that says nothing (found by writing the attack down on
  // 2026-09-24: it would have made the liar the holder, and the holder signs as the name).
  const linkFrom = (c: ccc.Cell): DeedLink | null => {
    const lock = c.cellOutput.lock
    if (ownerId(lock.hash() as Hex) !== a.ownerLockHash) return null
    const d = decodeDeedProxyData(c.outputData)
    const truthful = !!d && d.accountId === a.id && sporeTypeOf(client, d.sporeId).hash() === lock.args
    return {
      sporeId: truthful ? d!.sporeId : null,
      sporeTypeHash: lock.args as Hex,
      ownerId: a.ownerLockHash,
      proxy: { outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) }, capacity: c.cellOutput.capacity, lock, data: c.outputData as Hex },
    }
  }
  // A record names a Spore, the Spore's type hash is the proxy lock's args, and that lock's
  // hash has to be the name's owner id. Anyone may write any record on a cell of their
  // own, but not one that leads to this lock, so a decoy costs a reader one hash, and a
  // record that does lead here is looked up exactly: this lock, this record.
  const asked = new Set<string>()
  const byRecord = async (sporeId: Hex): Promise<DeedLink | null> => {
    if (asked.has(sporeId)) return null
    asked.add(sporeId)
    const lock = await deedLock(client, sporeTypeOf(client, sporeId).hash() as Hex)
    if (ownerId(lock.hash() as Hex) !== a.ownerLockHash) return null
    const record = encodeDeedProxyData(sporeId, a.id)
    for await (const c of client.findCells(
      { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { outputData: record, outputDataSearchMode: 'exact' }, withData: true },
      'asc',
      10,
    ))
      if (!c.cellOutput.type && c.cellOutput.lock.eq(lock) && c.outputData === record) return linkFrom(c)
    return null
  }
  const recordOf = (data: string) => {
    const d = decodeDeedProxyData(data as Hex)
    return d && d.accountId === a.id ? d.sporeId : null
  }
  if (a.outPoint) {
    const made = (await client.getTransaction(a.outPoint.txHash).catch(() => undefined))?.transaction
    for (let k = 0; made && k < made.outputs.length; k++) {
      if (ownerId(made.outputs[k].lock.hash() as Hex) !== a.ownerLockHash) continue
      const sporeId = recordOf(made.outputsData[k] ?? '0x')
      const found = sporeId ? await byRecord(sporeId) : null
      if (found) return found
    }
  }
  // A cell that names its Spore truthfully wins; one that proves the lock but says
  // nothing usable is kept as the answer of last resort. Both walks are bounded, so a
  // flood of decoy cells costs the attacker capacity and costs a reader a few pages.
  let silent: DeedLink | null = null
  let seen = 0
  for await (const c of client.findCells(
    { script: prefix, scriptType: 'lock', scriptSearchMode: 'prefix', filter: { outputData: a.id, outputDataSearchMode: 'partial' }, withData: true },
    'asc',
    100,
  )) {
    const sporeId = recordOf(c.outputData)
    const found = sporeId ? await byRecord(sporeId) : null
    if (found) return found
    silent ??= linkFrom(c)
    if (++seen >= 2000) break
  }
  seen = 0
  for await (const c of client.findCells({ script: prefix, scriptType: 'lock', scriptSearchMode: 'prefix', withData: true }, 'asc', 100)) {
    const link = linkFrom(c)
    if (link?.sporeId) return link
    silent ??= link
    if (++seen >= 2000) break
  }
  return silent
}

/** The link plus who holds the Spore now. */
export async function deedOf(
  client: ccc.Client,
  a: { id: Hex; ownerLockHash: Hex; label?: string; expiredAt?: number },
  now = Date.now(),
): Promise<Deed | null> {
  const link = await deedLinkOf(client, a)
  if (!link) return null
  let holder: Deed['holder'] = null
  let card: Deed['card'] = null
  let cluster: Deed['cluster'] = null
  const stale: Deed['stale'] = []
  if (link.sporeId) {
    const found = await findSpore(client, link.sporeId).catch(() => undefined)
    if (found) {
      const lock = found.cell.cellOutput.lock
      holder = { lock, address: ccc.Address.fromScript(lock, client).toString() }
      card = deedCard(found.sporeData.content)
      cluster = found.sporeData.clusterId ? (ccc.hexFrom(found.sporeData.clusterId) as Hex) : null
    } else {
      stale.push('melted')
    }
  }
  if (a.expiredAt !== undefined && a.expiredAt * 1000 < now) stale.push('expired')
  if (card && a.label !== undefined && card.label !== a.label) stale.push('renamed')
  return { ...link, holder, card, cluster, stale }
}

/**
 * The deeds a wallet holds, as the owner ids they stand for: every Spore under the
 * lock, each hashed into the proxy lock it would key. Any Spore counts, not only ours,
 * because the contract does not care whose Spore it is.
 */
export async function deedsHeldBy(client: ccc.Client, lock: ccc.ScriptLike): Promise<Map<Hex, { sporeId: Hex; sporeTypeHash: Hex }>> {
  const info = getSporeScriptInfo(client)
  const out = new Map<Hex, { sporeId: Hex; sporeTypeHash: Hex }>()
  for await (const c of client.findCells(
    // the filter script matches by prefix, so an empty args means "any Spore"
    { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', filter: { script: { codeHash: info.codeHash, hashType: info.hashType, args: '0x' } }, withData: false },
    'asc',
    50,
  )) {
    const type = c.cellOutput.type
    if (!type) continue
    const sporeTypeHash = type.hash() as Hex
    out.set(ownerId((await deedLock(client, sporeTypeHash)).hash() as Hex), { sporeId: type.args as Hex, sporeTypeHash })
  }
  return out
}

/**
 * The live proxy cell under a deed's lock, by exact lock. Anyone may put more cells under
 * that lock, so when the account is known the cell that names the deed truthfully is
 * preferred: melting the deed then reclaims the real cell rather than a stranger's decoy.
 */
export async function findDeedProxyCell(client: ccc.Client, sporeTypeHash: Hex, link?: { sporeId: Hex | null; accountId: Hex }): Promise<ccc.Cell | null> {
  const lock = await deedLock(client, sporeTypeHash)
  const want = link?.sporeId ? encodeDeedProxyData(link.sporeId, link.accountId) : null
  let any: ccc.Cell | null = null
  let seen = 0
  for await (const c of client.findCellsByLock(lock, undefined, true)) {
    if (c.cellOutput.type) continue
    if (want && c.outputData === want) return c
    any ??= c
    if (++seen >= 50) break
  }
  return any
}

// ---- the belly ----------------------------------------------------------------------

/**
 * What a being has eaten and its holder has not yet taken: the cells under the deed's
 * lock that carry no data and no type. Anyone may put a cell under a lock, which is what a
 * meal does (decision 0037: a payment into this lock with the meal witness); only a
 * transaction that spends the Spore can take them out, so they belong to whoever holds
 * the deed and go with it if it changes hands unemptied. The proxy cell carries data and
 * is not part of it.
 */
export interface Belly {
  /** Meals left as cells of their own under the deed's lock, 73 CKB or more each. */
  cells: { outPoint: { txHash: Hex; index: number }; capacity: bigint }[]
  /**
   * The cells under the deed's plate lock (decision 0042): normally one, which meals of
   * 1 CKB top up. Emptying the belly keeps one of them at `plateMin`.
   */
  plates: { outPoint: { txHash: Hex; index: number }; capacity: bigint }[]
  /** What one plate keeps when emptied, its own size; zero when there is no plate. */
  plateMin: bigint
  /** Shannons emptying would take: the cells above, and the plates past one plate's minimum. */
  total: bigint
  /** More cells exist than were read; `emptyBelly` takes what it read, and can be run again. */
  more: boolean
}

export async function bellyOf(client: ccc.Client, sporeTypeHash: Hex, limit = 200): Promise<Belly> {
  const lock = await deedLock(client, sporeTypeHash)
  const cells: Belly['cells'] = []
  let total = 0n
  let more = false
  for await (const c of client.findCellsByLock(lock, undefined, true)) {
    if (c.cellOutput.type || c.outputData !== '0x') continue
    if (cells.length >= limit) {
      more = true
      break
    }
    cells.push({ outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) }, capacity: c.cellOutput.capacity })
    total += c.cellOutput.capacity
  }
  const pLock = await plateLock(client, sporeTypeHash)
  const plates: Belly['plates'] = []
  for await (const c of client.findCellsByLock(pLock, undefined, false)) {
    if (c.cellOutput.type) continue
    if (plates.length >= PLATE_PAGE) {
      more = true
      break
    }
    plates.push({ outPoint: { txHash: c.outPoint.txHash as Hex, index: Number(c.outPoint.index) }, capacity: c.cellOutput.capacity })
    total += c.cellOutput.capacity
  }
  const plateMin = plates.length ? plateMinimum(pLock) : 0n
  return { cells, plates, plateMin, total: total - plateMin, more }
}

// ---- the plate (decision 0042) ------------------------------------------------------

/** The smallest meal on a plate: 10^8 shannons, 1 CKB. It is written into the plate's lock. */
export const PLATE_MIN_EXP = 8

/** At most this many plate cells are read or taken in one transaction. */
export const PLATE_PAGE = 8

/**
 * A deed's plate lock: Omnilock, a script Nervos deployed (not ours), owned by the deed's
 * own lock (auth `0xFC`, owner lock) and in anyone-can-pay mode. Anyone may top a plate up
 * by `10^PLATE_MIN_EXP` shannons or more with nothing signed for it; only a transaction
 * that spends a cell under the deed's lock, so only the Spore's holder, may take from it.
 * Args: `fc`, the first 20 bytes of the deed lock's hash, the anyone-can-pay flag `02`, and
 * the minimums for CKB and for tokens (`00`, a token plate is not a thing here).
 */
export async function plateLock(client: ccc.Client, sporeTypeHash: Hex): Promise<ccc.Script> {
  const owner = ccc.bytesFrom((await deedLock(client, sporeTypeHash)).hash()).slice(0, 20)
  const args = ccc.bytesConcat(Uint8Array.from([0xfc]), owner, Uint8Array.from([0x02, PLATE_MIN_EXP, 0x00]))
  return ccc.Script.fromKnownScript(client, ccc.KnownScript.OmniLock, ccc.hexFrom(args))
}

/**
 * The owner id (twenty bytes) a plate lock answers to, or null for a lock that is not a
 * plate. For a name held as a deed it equals the owner id its cell keeps, because both are
 * the deed lock's hash cut to twenty bytes. `omni` is Omnilock's script info on the network.
 */
export function plateOwnerFrom(omni: { codeHash: string; hashType: string }, lock: ccc.ScriptLike): Hex | null {
  const s = ccc.Script.from(lock)
  if (s.codeHash !== omni.codeHash || s.hashType !== omni.hashType) return null
  const a = ccc.bytesFrom(s.args)
  // Exactly the args `plateLock` writes: a lock with other flags or other minimums is not a
  // plate the SDK would ever empty, so a meal sent to it must not be counted as one.
  if (a.length !== 24 || a[0] !== 0xfc || a[21] !== 0x02 || a[22] !== PLATE_MIN_EXP || a[23] !== 0) return null
  return ccc.hexFrom(a.slice(1, 21)) as Hex
}

/**
 * The newest plate, following meals still in the pool: from `start`, each pending transaction
 * that spends the plate and sets it again moves it on, until nothing pending spends it.
 * `spends` maps an outpoint ("txHash:index") to the plate its pending spender sets. Ten
 * steps at most, so a loop in a hostile answer cannot hold the page.
 */
export function followPlate<T extends { outPoint: { txHash: string; index: number | bigint } }>(start: T, spends: Map<string, T>): T {
  let at = start
  for (let i = 0; i < 10; i++) {
    const next = spends.get(`${at.outPoint.txHash}:${Number(at.outPoint.index)}`)
    if (!next) break
    at = next
  }
  return at
}

/** What a plate keeps when emptied, and gives back when its deed ends: its own size. */
export function plateMinimum(lock: ccc.ScriptLike): bigint {
  return BigInt(ccc.CellOutput.from({ lock, capacity: 0n }).occupiedSize) * 100_000_000n
}

/**
 * The plate's witness when its holder takes from it: an empty signature field. With no
 * signature field Omnilock applies its anyone-can-pay rule and stops there, so a plate that
 * shrinks is refused; with the field present it goes on to the owner check, which ignores
 * what the field holds and asks only for an input under the deed's lock (omni_lock.c,
 * ckb_identity.h). Proven on Pudge, `scripts/92-belly-plate.mjs`.
 */
export const PLATE_TAKE_WITNESS: ccc.Hex = ccc.hexFrom(
  // OmniLockWitnessLock { signature: Some(empty), omni_identity: None, preimage: None }
  ccc.WitnessArgs.from({ lock: '0x1400000010000000140000001400000000000000' }).toBytes(),
)

/**
 * Every plain cell under a deed's lock, for a transaction that melts its Spore: the belly,
 * the proxy cell unless `skip` names it, and anything a stranger parked there. Melting is
 * the one chance anyone has to spend them, because afterwards the lock never opens again,
 * so a transaction that cannot carry all of them is refused before anything is signed.
 * Until 2026-09-27 the melts took the first twenty and left the rest there for good. A
 * cell with a type stays where it is: moving it is its own type's business.
 *
 * `CellsClient` takes them back a page per transaction before a melt, so this refusal is
 * left for a lock that fills up in between, and it says what is there. Emptying the belly
 * takes only meals, cells without data; until 2026-09-27 it was offered as the way out
 * whatever the cells were, and cells with a byte of data each froze the deed.
 */
export async function sweepable(
  client: ccc.Client,
  lock: ccc.Script,
  room: number,
  skip?: { txHash: string; index: number },
): Promise<ccc.Cell[]> {
  const out: ccc.Cell[] = []
  for await (const c of client.findCellsByLock(lock, undefined, true)) {
    if (c.cellOutput.type) continue
    if (skip && c.outPoint.txHash === skip.txHash && Number(c.outPoint.index) === Number(skip.index)) continue
    if (out.length === room) {
      const meals = [...out, c].every((x) => x.outputData === '0x')
      throw new Error(
        meals
          ? `cells: more than ${room} cells wait under this deed's lock, more than one transaction can take; empty the being's belly into your wallet first, then try again`
          : `cells: more than ${room} cells wait under this deed's lock, more than one transaction can take, and some carry data, so they are not the being's meals and emptying its belly will not take them; try again, and they are taken back to your wallet a page per transaction first`,
      )
    }
    out.push(c)
  }
  return out
}

// ---- what a co-signer checks ------------------------------------------------------

export interface DeedTxCheck {
  ok: boolean
  problems: string[]
  sporeId?: Hex
  clusterInput?: number
}

/**
 * Before the cluster's key signs a transaction someone else built: is it exactly a deed
 * being made for `a`, and nothing else? Every field the builder sets is recomputed here
 * and compared, so the signature cannot be borrowed for a different name, a different
 * picture, a second Spore, or anything of the cluster owner's beyond the cluster cell.
 */
export async function checkDeedTx(
  client: ccc.Client,
  a: { label: string; id: Hex; expiredAt: number; next: Hex; witnessHash: Hex; witness: Hex; outPoint: { txHash: Hex; index: number }; capacity: bigint },
  txLike: ccc.TransactionLike,
  opts: { clusterId: Hex; clusterLock: ccc.Script; accountType: ccc.Script; accountLock: ccc.Script; now?: number },
): Promise<DeedTxCheck> {
  const problems: string[] = []
  const tx = ccc.Transaction.from(txLike)
  // Every input is fetched from the node below; a transaction padded with hundreds of
  // them would make the co-signer do hundreds of reads for nothing. A deed needs the
  // name, the cluster, and a handful of the owner's cells.
  if (tx.inputs.length > 32 || tx.outputs.length > 16) return { ok: false, problems: [`too many cells for a deed: ${tx.inputs.length} inputs, ${tx.outputs.length} outputs`] }
  // A lapsed name can be recycled by anyone; a deed of it would be born stale, and a
  // market cannot tell. Renew first.
  if (a.expiredAt * 1000 < (opts.now ?? Date.now())) problems.push(`${a.label}.cell has lapsed; renew it before making its deed`)
  const spore = getSporeScriptInfo(client)
  const same = (x: ccc.Script | undefined, y: ccc.Script | undefined) => (!x && !y) || (!!x && !!y && x.eq(y))

  // the name: input 0 is this very cell, output 0 hands it to the proxy lock and nothing else
  const in0 = tx.inputs[0]
  if (!in0 || in0.previousOutput.txHash !== a.outPoint.txHash || Number(in0.previousOutput.index) !== a.outPoint.index) problems.push('input 0 is not the name')
  const out0 = tx.outputs[0]
  if (!out0 || !same(out0.type, opts.accountType) || !same(out0.lock, opts.accountLock) || out0.capacity !== a.capacity) problems.push('output 0 is not the name cell unchanged but for its owner')
  let w0: ccc.WitnessArgs | null = null
  try {
    w0 = ccc.WitnessArgs.fromBytes(tx.witnesses[0] ?? '0x')
  } catch {
    /* handled below */
  }
  if (!w0 || w0.inputType !== ccc.hexFrom(new TextEncoder().encode('transfer')) || w0.outputType !== a.witness) problems.push('witness 0 is not a transfer carrying the records')

  // exactly one Spore output, ours, in our cluster, with the DNA this name has
  const sporeOuts = tx.outputs
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.type && o.type.codeHash === spore.codeHash && o.type.hashType === spore.hashType)
  if (sporeOuts.length !== 1) problems.push(`expected one spore output, found ${sporeOuts.length}`)
  let sporeId: Hex | undefined
  if (sporeOuts.length === 1) {
    const { o, i } = sporeOuts[0]
    sporeId = o.type!.args as Hex
    // The Spore is the deed: whoever can spend it holds the name. Under a lock anybody can
    // spend, anybody would; and the contracts take no consent through such a Spore, so the
    // deed would freeze the name for its holder too (review of 2026-09-27).
    const open = await permissiveLock(client, o.lock)
    if (open) problems.push(`the spore would sit under ${open}, which anybody could spend`)
    if (sporeId !== ccc.hashTypeId(tx.inputs[0], i)) problems.push('the spore id does not derive from this transaction')
    try {
      const d = unpackToRawSporeData(tx.outputsData[i])
      if (d.contentType !== 'dob/1') problems.push('the spore is not a dob/1')
      if (ccc.hexFrom(d.clusterId ?? '0x') !== opts.clusterId) problems.push('the spore is not in the deeds cluster')
      if (ccc.hexFrom(d.content) !== ccc.hexFrom(deedContent(a))) problems.push('the DNA is not this name\'s')
    } catch {
      problems.push('the spore data does not parse')
    }
    // the name goes to the proxy lock over this spore, and the proxy cell exists with the link written on it
    const lock = await deedLock(client, o.type!.hash())
    const want = buildAccountData(a.witnessHash, a.next, a.expiredAt, lock.hash() as Hex, lock.hash() as Hex, a.label)
    if (tx.outputsData[0] !== want) problems.push('output 0 does not hand the name to the proxy lock over this spore')
    const proxies = tx.outputs.map((p, k) => ({ p, k })).filter(({ p }) => p.lock.eq(lock))
    if (proxies.length !== 1) problems.push(`expected one proxy cell, found ${proxies.length}`)
    else {
      const { p, k } = proxies[0]
      if (p.type) problems.push('the proxy cell must carry no type')
      if (tx.outputsData[k] !== encodeDeedProxyData(sporeId, a.id)) problems.push('the proxy cell does not name this spore and this account')
    }
  }

  // The cluster's authority, and nothing else of the cluster owner's is spent. Either the
  // cluster cell itself comes in and goes out unchanged ('clusterCell'), or one plain cell
  // of the cluster's key stands in for it and goes out unchanged while the cluster is only
  // read ('lockProxy'). The second lets deeds be made side by side, one plain cell each,
  // instead of queueing on the single cluster cell.
  const cells = await Promise.all(tx.inputs.map((inp) => client.getCell(inp.previousOutput)))
  // The key signs more than its own lock: CCC's signer also signs any input under the
  // anyone-can-pay lock over the same key, which is any lock whose args begin with the
  // key's. Such an input would be signed unexamined and its capacity could go anywhere
  // (review of 2026-09-27), so the one input under the cluster lock itself is the only one
  // that may carry the key's args. An input the node cannot show is refused too: nobody
  // can say whose it is.
  if (cells.some((c) => !c)) problems.push('an input the node cannot show')
  const keyArgs = opts.clusterLock.args.toLowerCase()
  const alsoKeys = cells.filter((c) => c && !c.cellOutput.lock.eq(opts.clusterLock) && c.cellOutput.lock.args.toLowerCase().startsWith(keyArgs))
  if (alsoKeys.length) problems.push(`${alsoKeys.length} input(s) under another lock over the cluster key`)
  const ours = cells.map((c, k) => ({ c, k })).filter(({ c }) => c && c.cellOutput.lock.eq(opts.clusterLock))
  let clusterInput: number | undefined
  if (ours.length !== 1) problems.push(`expected exactly one input under the cluster lock, found ${ours.length}`)
  else {
    const { c, k } = ours[0]
    clusterInput = k
    const t = c!.cellOutput.type
    if (t) {
      if (t.args !== opts.clusterId) problems.push('the input under the cluster lock is not the deeds cluster')
      const back = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.type && same(o.type, t))
      if (back.length !== 1) problems.push('the cluster cell is not recreated exactly once')
      else {
        const { o, i } = back[0]
        if (!o.lock.eq(opts.clusterLock)) problems.push('the cluster cell must come back under its own lock')
        if (tx.outputsData[i] !== c!.outputData) problems.push('the cluster cell must come back with its data unchanged')
        if (o.capacity < c!.cellOutput.capacity) problems.push('the cluster cell must not lose capacity')
      }
    } else {
      const back = tx.outputs.map((o, i) => ({ o, i })).filter(({ o }) => o.lock.eq(opts.clusterLock))
      if (back.length !== 1) problems.push(`the cluster key's cell is not returned exactly once, found ${back.length}`)
      else {
        const { o, i } = back[0]
        if (o.type) problems.push("the cluster key's cell must come back without a type")
        if (tx.outputsData[i] !== c!.outputData) problems.push("the cluster key's cell must come back with its data unchanged")
        if (o.capacity < c!.cellOutput.capacity) problems.push("the cluster key's cell must not lose capacity")
      }
    }
  }
  return { ok: problems.length === 0, problems, sporeId, clusterInput }
}

// ---- the app's side of the co-signature ---------------------------------------------

/**
 * Which of the cluster key's plain cells a deed should spend, asked of the resolver, so that
 * deeds made at the same moment each take a different one. A lease is a hint and not a lock:
 * when the resolver answers nothing, the SDK picks one at random from what the chain shows.
 */
export function deedProxyLeaser(apiBase: string): () => Promise<{ txHash: Hex; index: number } | null> {
  return async () => {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/deeds/lease`, { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) return null
    const j = (await res.json().catch(() => null)) as { outPoint?: { txHash: Hex; index: number } } | null
    return j?.outPoint ?? null
  }
}

/**
 * A `cosign` for `makeDeed` that asks the gateway. The transaction travels in the node's
 * own JSON shape and comes back the same way, with the cluster's signature in it.
 */
export function deedCosigner(apiBase: string, name: string): (tx: ccc.Transaction) => Promise<ccc.TransactionLike> {
  return async (tx) => {
    const res = await fetch(`${apiBase.replace(/\/$/, '')}/deed/cosign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: name.replace(/\.cell$/, ''), tx: JsonRpcTransformers.transactionFrom(tx) }),
    })
    const j = (await res.json().catch(() => null)) as { tx?: unknown; error?: string } | null
    if (!res.ok || !j?.tx) throw new Error(j?.error ?? `the co-signer answered ${res.status}`)
    return JsonRpcTransformers.transactionTo(j.tx as never)
  }
}
