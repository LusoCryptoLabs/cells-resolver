/**
 * An account on another site answering for a name (decision 0040).
 *
 * Two halves, as for a website: the name publishes a record, `proof.x`, `proof.github` or
 * `proof.bluesky`, holding the address of a post, a gist or a file; and that post, gist
 * or file carries a statement (0039) signed by the name's owner, whose words name the
 * account. The name's half says "this account is mine", and only its owner or manager can
 * write it; the account's half says the same from the other side, and only whoever holds
 * the account can publish it. One alone proves nothing.
 *
 * The statement is what keeps a proof from surviving a sale. A name keeps its records
 * when it changes hands, so a line that only named the name would go on answering for
 * whoever bought it. A statement is signed by the owner of the day, and after a sale it
 * reads as a former owner's, so the proof stops showing.
 *
 * What is here is the part that needs no network: which platforms, the words, reading a
 * record's address, and finding statements in what a platform returned. The fetching is
 * the resolver's (`services/gateway/src/accountproof.ts`), under its fetch guard.
 */
import type { SignedStatement } from './statement.ts'
import { statementsIn } from './statement.ts'

export type AccountPlatform = 'x' | 'github' | 'bluesky'

export const ACCOUNT_PLATFORMS: readonly AccountPlatform[] = ['x', 'github', 'bluesky']

/** The record each platform's claim is written under. */
export const ACCOUNT_PROOF_KEYS: Readonly<Record<AccountPlatform, string>> = {
  x: 'proof.x',
  github: 'proof.github',
  bluesky: 'proof.bluesky',
}

export const ACCOUNT_PLATFORM_LABEL: Readonly<Record<AccountPlatform, string>> = {
  x: 'X',
  github: 'GitHub',
  bluesky: 'Bluesky',
}

/** Where an account's half lives, read from the record the name wrote. */
export type AccountHalf =
  | { platform: 'x'; handle: string; postId: string; url: string }
  | { platform: 'github'; handle: string; kind: 'gist'; gistId: string; url: string; raw: string }
  | { platform: 'github'; handle: string; kind: 'file'; repo: string; ref: string; path: string; url: string; raw: string }
  | { platform: 'bluesky'; handle: string; rkey: string; url: string }

/**
 * The account as its own address, `x.com/telmo`: what the statement's words must name,
 * and what a page shows. Lower case, because all three platforms ignore case in it.
 */
export function accountLocator(platform: AccountPlatform, handle: string): string {
  const h = handle.toLowerCase()
  if (platform === 'x') return `x.com/${h}`
  if (platform === 'github') return `github.com/${h}`
  return `bsky.app/profile/${h}`
}

/** The words a name signs to claim an account. */
export function accountProofText(platform: AccountPlatform, handle: string): string {
  return `${accountLocator(platform, handle)} is my account on ${ACCOUNT_PLATFORM_LABEL[platform]}.`
}

/**
 * Whether these words name this account. The locator has to stand on its own: `x.com/telmo`
 * is not named by `evilx.com/telmo` nor by `x.com/telmo2`. `twitter.com/telmo` counts for X.
 */
export function statementNamesAccount(text: string, platform: AccountPlatform, handle: string): boolean {
  const h = handle.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const host = platform === 'x' ? '(?:x|twitter)\\.com/' : platform === 'github' ? 'github\\.com/' : 'bsky\\.app/profile/'
  // After the handle: X and GitHub handles end at anything that cannot be in one; a
  // Bluesky handle is a domain, so a dot ends it only when nothing follows it.
  const after = platform === 'bluesky' ? '(?![a-z0-9-]|\\.[a-z0-9])' : platform === 'x' ? '(?![a-z0-9_])' : '(?![a-z0-9-])'
  return new RegExp(`(?:^|[^a-z0-9.-])${host}${h}${after}`, 'i').test(text)
}

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/
const GH_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/
const BSKY_HANDLE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * A record's value as the address of an account's half, or null with nothing to explain:
 * `accountHalfProblem` says why. Strict on purpose. Each shape becomes a request from the
 * resolver to one fixed host, so nothing the owner types can point it anywhere else.
 */
export function parseAccountHalf(platform: AccountPlatform, value: string): AccountHalf | null {
  let u: URL
  try {
    u = new URL(value.trim())
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean)
  if (platform === 'x') {
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'].includes(host)) return null
    if (parts.length < 3 || !X_HANDLE.test(parts[0]) || parts[1] !== 'status' || !/^\d{1,20}$/.test(parts[2])) return null
    return { platform, handle: parts[0].toLowerCase(), postId: parts[2], url: `https://x.com/${parts[0]}/status/${parts[2]}` }
  }
  if (platform === 'github') {
    if (host === 'gist.github.com') {
      if (parts.length < 2 || !GH_HANDLE.test(parts[0]) || !/^[0-9a-f]{20,40}$/i.test(parts[1])) return null
      const [user, id] = [parts[0], parts[1].toLowerCase()]
      return {
        platform,
        handle: user.toLowerCase(),
        kind: 'gist',
        gistId: id,
        url: `https://gist.github.com/${user}/${id}`,
        // GitHub answers 404 here when the user is not the gist's owner, so the address
        // itself says whose it is (0040).
        raw: `https://gist.githubusercontent.com/${user}/${id}/raw`,
      }
    }
    if (host === 'github.com') {
      if (parts.length < 5 || !GH_HANDLE.test(parts[0]) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) || parts[2] !== 'blob') return null
      const [owner, repo, , ref, ...rest] = parts
      if (!/^[A-Za-z0-9._-]{1,100}$/.test(ref) || rest.some((p) => !/^[A-Za-z0-9._-]{1,100}$/.test(p) || p === '..' || p === '.')) return null
      // A branch, never a commit. GitHub serves a commit from any fork in a repository's
      // network under the parent's own path, so a stranger's fork could put words under
      // the owner's name; a branch is looked up in the owner's repository alone, and the
      // raw address says so with `refs/heads`. Found by the review of 2026-09-27.
      if (/^[0-9a-f]{7,40}$/i.test(ref)) return null
      const path = rest.join('/')
      return {
        platform,
        handle: owner.toLowerCase(),
        kind: 'file',
        repo,
        ref,
        path,
        url: `https://github.com/${owner}/${repo}/blob/${ref}/${path}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${ref}/${path}`,
      }
    }
    return null
  }
  if (host !== 'bsky.app') return null
  if (parts.length < 4 || parts[0] !== 'profile' || parts[2] !== 'post' || !/^[a-z2-7]{13}$/.test(parts[3])) return null
  const handle = parts[1].toLowerCase()
  // A post's address can carry the account's permanent id instead of its handle; the
  // words name the handle, so the address has to as well.
  if (!BSKY_HANDLE.test(handle)) return null
  return { platform, handle, rkey: parts[3], url: `https://bsky.app/profile/${handle}/post/${parts[3]}` }
}

/** Why a value is not the address of an account's half, in words for the owner. */
export function accountHalfProblem(platform: AccountPlatform, value: string): string | null {
  if (!value.trim()) return 'Paste the address first.'
  if (parseAccountHalf(platform, value)) return null
  if (platform === 'x') return 'That is not the address of a post on X: it looks like https://x.com/yourhandle/status/1234567890.'
  if (platform === 'github')
    return 'That is not the address of a gist or a file on GitHub: it looks like https://gist.github.com/yourhandle/0123abcd… or https://github.com/you/repo/blob/main/cellula.txt.'
  return 'That is not the address of a post on Bluesky: it looks like https://bsky.app/profile/you.bsky.social/post/3abc…, with your handle, not your did.'
}

/** Statements found in what the platform returned, signed for this name, first found first. */
export function statementsFor(content: string, name: string, max = 3): SignedStatement[] {
  const label = name.toLowerCase().replace(/\.cell$/, '')
  return statementsIn(content, 8)
    .filter((s) => s.statement.name.toLowerCase() === label)
    .slice(0, max)
}
