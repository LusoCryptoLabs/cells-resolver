// Impersonation and disputes (docs/DISPUTES.md), the part of it that runs.
//
// The policy governs only the front door we own: this resolver, the app, the name pages
// and the Lightning Addresses it answers. Its two outcomes are a NOTICE on a name and a
// WITHDRAWAL of the name from those surfaces. Both are one file, `disputes.json`, on the
// resolver's persistent volume, edited by the operator (`cells-dispute` on the VPS) and
// served in full at `GET /disputes`. That makes the transparency log the mechanism
// itself: nothing can be withdrawn without appearing in the public list, because the
// list is what the code reads.
//
// Reports arrive at `POST /report` and are appended to `reports.jsonl` beside it, one
// JSON object a line, read by hand (`cells-reports`). No mail is involved: the domain has
// none, and a file we control is better than a mailbox we would have to trust.
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const DIR = process.env.DATA_DIR ?? '/app/data'

export type DisputeStatus = 'notice' | 'withdrawn'
export type DisputeClaim = 'impersonation' | 'safety' | 'illegal' | 'other'
export interface Dispute {
  /** The label, without `.cell`. */
  name: string
  status: DisputeStatus
  claim: DisputeClaim
  /** YYYY-MM-DD, when the entry was made. */
  since: string
  /** One sentence for the person about to pay, or nothing. */
  note?: string
}

export interface Report {
  name: string
  claim: DisputeClaim
  statement: string
  evidence: string
  contact: string
}

const STATUSES: DisputeStatus[] = ['notice', 'withdrawn']
// `trademark` was here until 2026-09-16 (DISPUTES.md, out of scope). A report that names
// it is refused with the list of claims that remain, which is the honest answer: we do not
// adjudicate marks, and where a mark is being used to take money it is impersonation.
const CLAIMS: DisputeClaim[] = ['impersonation', 'safety', 'illegal', 'other']
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)?$/

function isDispute(e: unknown): e is Dispute {
  if (!e || typeof e !== 'object') return false
  const d = e as Record<string, unknown>
  return (
    typeof d.name === 'string' &&
    LABEL.test(d.name) &&
    d.name.length <= 40 &&
    STATUSES.includes(d.status as DisputeStatus) &&
    CLAIMS.includes(d.claim as DisputeClaim) &&
    typeof d.since === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.since) &&
    (d.note === undefined || (typeof d.note === 'string' && d.note.length <= 300))
  )
}

/** A report from the form, checked field by field; a sentence says which one failed. */
export function parseReport(j: unknown): Report | { error: string } {
  if (!j || typeof j !== 'object') return { error: 'a report is a JSON object' }
  const r = j as Record<string, unknown>
  const name = String(r.name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.cell$/, '')
  if (!LABEL.test(name) || name.length > 40) return { error: 'name: not a .cell name' }
  const claim = String(r.claim ?? '') as DisputeClaim
  if (!CLAIMS.includes(claim)) return { error: `claim: one of ${CLAIMS.join(', ')}` }
  const statement = String(r.statement ?? '').trim()
  if (statement.length < 20) return { error: 'statement: say what is being claimed, in at least a sentence' }
  if (statement.length > 4000) return { error: 'statement: at most 4000 characters' }
  const evidence = String(r.evidence ?? '').trim()
  if (evidence.length > 2000) return { error: 'evidence: at most 2000 characters' }
  const contact = String(r.contact ?? '').trim()
  if (contact.length < 3) return { error: 'contact: a way to answer you, or the report cannot be acknowledged' }
  if (contact.length > 200) return { error: 'contact: at most 200 characters' }
  return { name, claim, statement, evidence, contact }
}

export class Disputes {
  private entries = new Map<string, Dispute>()
  private mtimeMs = -2
  private checkedAt = 0
  readonly file: string
  readonly reports: string
  readonly answered: string

  constructor(dir = DIR) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* a read-only place still serves an empty list */
    }
    this.file = join(dir, 'disputes.json')
    this.reports = join(dir, 'reports.jsonl')
    this.answered = join(dir, 'answered.jsonl')
    this.reload(true)
  }

  /**
   * Re-read the file when it changed, at most every few seconds. An unreadable file
   * keeps the last good list rather than silently serving every name again.
   */
  reload(force = false): void {
    const now = Date.now()
    if (!force && now - this.checkedAt < 5_000) return
    this.checkedAt = now
    let m = -1
    try {
      m = statSync(this.file).mtimeMs
    } catch {
      m = -1
    }
    if (m === this.mtimeMs) return
    const next = new Map<string, Dispute>()
    if (m >= 0) {
      try {
        const j = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown[] }
        for (const e of j.entries ?? []) {
          if (isDispute(e)) next.set(e.name, e)
          else console.error('[disputes] skipped a malformed entry', JSON.stringify(e).slice(0, 120))
        }
      } catch (err) {
        console.error('[disputes] disputes.json unreadable, keeping the last list:', String(err))
        return
      }
    }
    this.mtimeMs = m
    this.entries = next
  }

  get(label: string): Dispute | null {
    this.reload()
    return this.entries.get(label) ?? null
  }

  withdrawn(label: string): Dispute | null {
    const d = this.get(label)
    return d && d.status === 'withdrawn' ? d : null
  }

  /**
   * Withdrawn as illegal content: the one claim where declining to serve is not enough,
   * because our own copy of the bytes would remain. The resolver forgets that copy and
   * stops taking it back.
   */
  purged(label: string): boolean {
    const d = this.withdrawn(label)
    return !!d && d.claim === 'illegal'
  }

  /** Every entry, newest first: the public log. */
  list(): Dispute[] {
    this.reload()
    return [...this.entries.values()].sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : a.name.localeCompare(b.name)))
  }

  /** Append a report; the id is what the reporter is told to quote. */
  report(r: Report): string {
    const id = 'r-' + randomBytes(4).toString('hex')
    appendFileSync(this.reports, JSON.stringify({ id, at: new Date().toISOString(), ...r }) + '\n')
    return id
  }

  /**
   * How many reports have arrived, and how long the oldest unanswered one has waited.
   *
   * [DISPUTES.md](../../../docs/DISPUTES.md) promises an answer within five working days, and
   * says why: a report that goes unanswered is worse than one refused. Until 2026-09-16
   * nothing stood behind that. A report was appended to a file and written to the container
   * log, and the only way anybody learned of one was by opening a shell and running
   * `cells-reports`. The promise held only because nobody had ever reported anything.
   *
   * This is what the sentinel reads every five minutes, so the first report wakes a person
   * rather than waiting to be found. `acted` counts the entries in `disputes.json`: a report
   * that produced a notice or a withdrawal has been acted on, so what is worth alarming on is
   * the reports that produced neither, and how long the oldest has been waiting.
   *
   * It carries **nothing about who reported**, not even a count per address. Only how many and
   * how long, which is all a person needs in order to go and look.
   */
  stats(): { reports: number; answered: number; acted: number; oldestUnansweredHours: number | null } {
    this.reload()
    let reports = 0
    let oldest: number | null = null
    try {
      for (const line of readFileSync(this.reports, 'utf8').split('\n')) {
        if (!line.trim()) continue
        reports += 1
        const at = Date.parse((JSON.parse(line) as { at?: string }).at ?? '')
        if (!Number.isNaN(at) && (oldest === null || at < oldest)) oldest = at
      }
    } catch {
      /* no file yet is no reports, which is the common case and not an error */
    }
    // **The outcome that leaves no public trace.** The policy's first outcome is "no action,
    // with the reason", and by design that creates no entry in `disputes.json`: nothing was
    // withdrawn, so there is nothing to publish. The first version of this counted only the
    // entries, so a report answered with a refusal would have alarmed for ever. Found on
    // 2026-09-16 by a test report from 2026-09-10 that says, in its own text, to ignore it.
    //
    // So answering is recorded separately, with `cells-reports answered <id>`, and it is
    // deliberately the id and the time and nothing else: the reason belongs in the reply to
    // the person, not in a file here.
    let answered = 0
    let waitingSince: number | null = null
    try {
      const done = new Set<string>()
      for (const line of readFileSync(this.answered, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const id = (JSON.parse(line) as { id?: string }).id
        if (id) done.add(id)
      }
      answered = done.size
      // Recompute the oldest, skipping the ones already answered.
      waitingSince = null
      for (const line of readFileSync(this.reports, 'utf8').split('\n')) {
        if (!line.trim()) continue
        const r = JSON.parse(line) as { id?: string; at?: string }
        if (r.id && done.has(r.id)) continue
        const at = Date.parse(r.at ?? '')
        if (!Number.isNaN(at) && (waitingSince === null || at < waitingSince)) waitingSince = at
      }
    } catch {
      // No answered file means nothing has been answered, so every report is still waiting.
      waitingSince = oldest
    }
    const acted = this.entries.size
    const waiting = waitingSince !== null ? Math.round((Date.now() - waitingSince) / 3_600_000) : null
    return { reports, answered, acted, oldestUnansweredHours: waiting }
  }
}

/** What every withheld route answers, so a caller learns why rather than just "not found". */
export function withdrawnBody(label: string, d: Dispute, policyUrl: string) {
  return {
    name: `${label}.cell`,
    withdrawn: true,
    claim: d.claim,
    since: d.since,
    note: d.note ?? null,
    stillOnChain: true,
    policy: policyUrl,
  }
}
