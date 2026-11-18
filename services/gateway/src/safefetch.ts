import { request } from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'

/**
 * The one way this service fetches an address somebody else chose.
 *
 * A name's records are written by strangers, and three things here read a URL out of
 * them: the Lightning forwarder (a wallet's host), the website proof (a domain), and the
 * account proofs (a post, a gist, a file; decision 0040). Each of those is a way to make
 * this machine send a request, and the machine sits beside other services that answer
 * anybody on the inside. So every such request goes through here, and here:
 *
 * - only https, on its default port, with no credentials in the address;
 * - only a host name, never an address typed as one (`127.0.0.1`, `[::1]`, and the forms
 *   a URL parser turns into one, like `0177.0.0.1`);
 * - only hosts whose every address is public: the check runs inside the connection's own
 *   lookup, so the address that is checked is the address that is dialled, and a name
 *   that answers differently the second time cannot slip past;
 * - never a redirect: the answer comes back with its `location` for the caller to judge,
 *   and a caller that follows one sends it back through here;
 * - never more than `maxBytes` of body, and never longer than `timeoutMs` in all.
 *
 * A call that names `hosts` may reach only those; that is how the account proofs are
 * pinned to GitHub, X and Bluesky. The Lightning forwarder and the website proof cannot
 * be pinned, since any wallet or any domain is fair, and rely on the rest.
 */

const UA = 'cellula.id-resolver (+https://cellula.id)'

/** Addresses that are not the public internet, or that stand in for one that is not. */
const NOT_PUBLIC = new BlockList()
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NOT_PUBLIC.addSubnet(net, bits, 'ipv4')
for (const [net, bits] of [
  ['::', 96], // unspecified, loopback, and the old IPv4-compatible form
  ['64:ff9b::', 96], // NAT64: stands in for any IPv4 address, private ones included
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10],
  ['ff00::', 8], // multicast
] as const)
  NOT_PUBLIC.addSubnet(net, bits, 'ipv6')

/** The IPv4 address inside an IPv4-mapped IPv6 one (`::ffff:10.0.0.1`), or null. */
function mappedV4(address: string): string | null {
  const m = address.toLowerCase().match(/^(?:0{1,4}:){0,5}:?ffff:(.+)$/) ?? address.toLowerCase().match(/^::ffff:(.+)$/)
  if (!m) return null
  const rest = m[1]
  if (isIP(rest) === 4) return rest
  const hex = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const hi = parseInt(hex[1], 16)
  const lo = parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** True only for an address on the public internet. Anything unparseable is not. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return !NOT_PUBLIC.check(address, 'ipv4')
  if (kind === 6) {
    const v4 = mappedV4(address)
    if (v4) return !NOT_PUBLIC.check(v4, 'ipv4')
    return !NOT_PUBLIC.check(address, 'ipv6')
  }
  return false
}

export class RefusedAddress extends Error {}

/**
 * The address, if this service may fetch it; throws `RefusedAddress` with the reason
 * otherwise. A host name has a dot, labels of letters, digits and hyphens, and a last
 * label with a letter in it, which is what keeps `0177.0.0.1` and `0x7f.1` out: a URL
 * parser reads both as 127.0.0.1.
 */
export function checkAddress(raw: string, hosts?: ReadonlySet<string>): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new RefusedAddress('it is not an address')
  }
  if (u.protocol !== 'https:') throw new RefusedAddress('only https is fetched')
  if (u.username || u.password) throw new RefusedAddress('an address with a login in it is not fetched')
  if (u.port !== '') throw new RefusedAddress('only the default port is fetched')
  const host = u.hostname.toLowerCase()
  if (host.startsWith('[') || isIP(host)) throw new RefusedAddress('a host name is needed, not an IP address')
  if (!/^(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})*\.[a-z0-9-]*[a-z][a-z0-9-]*$/.test(host) || host.length > 253)
    throw new RefusedAddress(`${host} is not a public host name`)
  if (hosts && !hosts.has(host)) throw new RefusedAddress(`${host} is not a host this check reads`)
  return u
}

type Resolve = (host: string, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void

const systemResolve: Resolve = (host, cb) => dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => cb(err, addresses ?? []))

/**
 * A lookup for the connection itself, which refuses a host unless every address it
 * resolves to is public. Exported with its resolver as a parameter, for the tests.
 */
export function guardedLookup(resolve: Resolve = systemResolve) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: (...args: any[]) => void) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err)
      const wanted = addresses.filter((a) => !options.family || a.family === options.family)
      if (wanted.length === 0) return callback(Object.assign(new Error(`${hostname} has no address`), { code: 'ENOTFOUND' }))
      const bad = wanted.find((a) => !isPublicAddress(a.address))
      if (bad) return callback(Object.assign(new Error(`${hostname} resolves to ${bad.address}, which is not a public address`), { code: 'ENOTPUBLIC' }))
      if (options.all) return callback(null, wanted)
      callback(null, wanted[0].address, wanted[0].family)
    })
  }
}

export interface SafeFetchOptions {
  /** The only hosts this call may reach. Omitted, any public host. */
  hosts?: ReadonlySet<string>
  /** Most body bytes kept. More is cut off and `truncated` says so. Default 64 KiB. */
  maxBytes?: number
  /** Whole request, connect to last byte. Default 8 seconds. */
  timeoutMs?: number
  headers?: Record<string, string>
}

export interface SafeResponse {
  status: number
  headers: Record<string, string>
  body: string
  /** A redirect's target, never followed here. */
  location: string | null
  truncated: boolean
}

/** GET an address under every rule above. Rejects with the reason when it may not. */
export function safeFetch(raw: string, opts: SafeFetchOptions = {}, resolve?: Resolve): Promise<SafeResponse> {
  let u: URL
  try {
    u = checkAddress(raw, opts.hosts)
  } catch (e) {
    return Promise.reject(e)
  }
  const max = opts.maxBytes ?? 64 * 1024
  const ms = opts.timeoutMs ?? 8_000
  return new Promise((done, fail) => {
    let settled = false
    const finish = (f: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      f()
    }
    const req = request(
      u,
      {
        method: 'GET',
        headers: { 'user-agent': UA, accept: '*/*', ...opts.headers },
        lookup: guardedLookup(resolve) as never,
        // The pool would keep a socket to a host after a check; one request, one socket.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        const end = () =>
          finish(() =>
            done({
              status: res.statusCode ?? 0,
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v ?? '')])),
              body: Buffer.concat(chunks).toString('utf8'),
              location: typeof res.headers.location === 'string' ? res.headers.location : null,
              truncated,
            }),
          )
        res.on('data', (c: Buffer) => {
          if (truncated) return
          if (size + c.length > max) {
            chunks.push(c.subarray(0, max - size))
            size = max
            truncated = true
            res.destroy()
            end()
            return
          }
          size += c.length
          chunks.push(c)
        })
        res.on('end', end)
        res.on('error', (e) => finish(() => fail(e)))
      },
    )
    const timer = setTimeout(() => {
      req.destroy()
      finish(() => fail(new Error(`no answer within ${Math.round(ms / 1000)} seconds`)))
    }, ms)
    req.on('error', (e) => finish(() => fail(e)))
    req.end()
  })
}

/**
 * `safeFetch`, following at most `hops` redirects, each one checked again from the start
 * as if it had been the first address. For the Lightning forwarder, where wallets do
 * redirect and a payer's wallet would follow; nothing else here follows any.
 */
export async function safeFetchFollowing(raw: string, opts: SafeFetchOptions = {}, hops = 2, resolve?: Resolve): Promise<SafeResponse & { url: string }> {
  let url = raw
  for (let i = 0; ; i++) {
    const r = await safeFetch(url, opts, resolve)
    if (r.status < 300 || r.status >= 400 || !r.location) return { ...r, url }
    if (i >= hops) throw new RefusedAddress(`more than ${hops} redirects`)
    url = new URL(r.location, url).toString()
  }
}
