import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * How many people got as far as each step, and nothing else.
 *
 * Until 2026-09-14 this site measured nothing at all: no script, no pixel, no counter.
 * That is a real privacy position and it is kept here rather than traded away. What it
 * could not answer is the only question that decides whether the price, the wording or
 * the wallet step is what loses people: **how many reach the price and leave.** Server
 * logs cannot answer it either, because the app never reloads, so the whole funnel after
 * the first page is invisible to them.
 *
 * ## What this stores, exactly
 *
 * One integer per step per day. That is the entire data model. There is no identifier of
 * any kind: no cookie, no session, no visitor id, no address, no user agent, no referrer,
 * nothing derived from any of those. Two people cannot be told apart and one person
 * cannot be followed from one step to the next, which is precisely why no consent banner
 * is owed and why one is not shown.
 *
 * The cost of that is real and worth stating: these are totals, not journeys. "200 typed
 * a name and 20 connected a wallet" is a ratio over a day, not twenty people traced from
 * one to the other. That is enough to see a step that loses everybody, which is what this
 * is for, and it is not enough to profile anybody, which is the point.
 *
 * ## Why an allow-list
 *
 * The route is open to the internet, so the name of a step is chosen from a fixed list
 * written here. Anything else is discarded without an error. Without that, this becomes a
 * place where strangers write arbitrary strings onto our disk.
 */

/** The steps worth counting, and the only strings this service will store. */
export const STEPS = [
  'landing', // the home page was seen
  'register-open', // the claim screen was opened
  'name-typed', // a name was typed and checked
  'name-free', // the answer was that it is free
  'price-seen', // the price and the term were shown
  'wallet-open', // the wallet chooser was opened
  'claimed', // a name was registered
  'card-open', // the card form was opened
  'card-paid', // a card payment went through
  'market-open', // the marketplace was opened
] as const
export type Step = (typeof STEPS)[number]

const DAYS_KEPT = 92

interface Day {
  [step: string]: number
}

export class Counts {
  private path: string
  private days = new Map<string, Day>()
  private dirty = false
  /** Off when the file cannot be written, exactly like the archive on a dev box. */
  readonly on: boolean

  constructor(path = process.env.COUNTS_PATH ?? '/app/data/counts.json') {
    this.path = path
    let ok = false
    try {
      mkdirSync(dirname(path), { recursive: true })
      if (existsSync(path)) {
        const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Day>
        for (const [d, row] of Object.entries(j)) this.days.set(d, row)
      }
      writeFileSync(path, JSON.stringify(Object.fromEntries(this.days)))
      ok = true
    } catch {
      ok = false
    }
    this.on = ok
  }

  /** Today in UTC. One timezone for the whole file, or a day's totals depend on where the server sleeps. */
  private static today(now: number): string {
    return new Date(now).toISOString().slice(0, 10)
  }

  /**
   * Count one step. Returns whether it was counted, so a caller can tell a bad name
   * from a working one; the route answers the same either way.
   */
  add(step: string, now = Date.now()): boolean {
    if (!this.on) return false
    if (!(STEPS as readonly string[]).includes(step)) return false
    const key = Counts.today(now)
    const day = this.days.get(key) ?? {}
    day[step] = (day[step] ?? 0) + 1
    this.days.set(key, day)
    this.dirty = true
    return true
  }

  /** Drop days past the window, so this never grows without bound. */
  private prune(now: number): void {
    const cutoff = Counts.today(now - DAYS_KEPT * 86_400_000)
    for (const d of [...this.days.keys()]) if (d < cutoff) this.days.delete(d)
  }

  /** Write if anything changed. Called on a timer, not per request. */
  flush(now = Date.now()): void {
    if (!this.on || !this.dirty) return
    this.prune(now)
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.days)))
      this.dirty = false
    } catch {
      /* a disk that stopped accepting writes must not take the resolver with it */
    }
  }

  /** Every day held, newest first, plus the totals across them. */
  report(): { days: Record<string, Day>; total: Day; steps: readonly string[] } {
    const total: Day = {}
    for (const row of this.days.values()) {
      for (const [k, v] of Object.entries(row)) total[k] = (total[k] ?? 0) + v
    }
    const days = Object.fromEntries([...this.days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)))
    return { days, total, steps: STEPS }
  }
}
