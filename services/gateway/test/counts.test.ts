import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Counts } from '../src/counts.ts'

const where = () => join(mkdtempSync(join(tmpdir(), 'counts-')), 'counts.json')
const DAY = '2026-09-14T10:00:00Z'
const at = (iso: string) => new Date(iso).getTime()

test('a known step is counted, by day', () => {
  const c = new Counts(where())
  assert.ok(c.on)
  c.add('landing', at(DAY))
  c.add('landing', at(DAY))
  c.add('claimed', at(DAY))
  const r = c.report()
  assert.equal(r.days['2026-09-14'].landing, 2)
  assert.equal(r.days['2026-09-14'].claimed, 1)
  assert.equal(r.total.landing, 2)
})

test('a step nobody wrote down is refused, because this route is open to the internet', () => {
  // Without this, anybody could write arbitrary strings onto our disk by curling a URL.
  const c = new Counts(where())
  assert.equal(c.add('landing'), true)
  assert.equal(c.add('../../etc/passwd'), false)
  assert.equal(c.add('whatever'), false)
  assert.equal(c.add(''), false)
  assert.equal(Object.keys(c.report().total).length, 1)
})

test('days are separate, and the total is their sum', () => {
  const c = new Counts(where())
  c.add('landing', at('2026-09-13T23:00:00Z'))
  c.add('landing', at('2026-09-14T01:00:00Z'))
  const r = c.report()
  assert.equal(r.days['2026-09-13'].landing, 1)
  assert.equal(r.days['2026-09-14'].landing, 1)
  assert.equal(r.total.landing, 2)
})

test('what is written down survives a restart', () => {
  const p = where()
  const a = new Counts(p)
  a.add('price-seen', at(DAY))
  a.flush(at(DAY))
  const b = new Counts(p)
  assert.equal(b.report().total['price-seen'], 1)
})

test('nothing about a person is stored, which is why no banner is owed', () => {
  // The whole claim of counts.ts in one assertion: the file on disk is step names and
  // integers, and there is nowhere for an identifier to hide.
  const p = where()
  const c = new Counts(p)
  c.add('landing', at(DAY))
  c.add('name-typed', at(DAY))
  c.flush(at(DAY))
  const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, Record<string, unknown>>
  for (const [day, row] of Object.entries(raw)) {
    assert.match(day, /^\d{4}-\d{2}-\d{2}$/)
    for (const [step, n] of Object.entries(row)) {
      assert.ok(c.report().steps.includes(step), `unexpected key ${step}`)
      assert.equal(typeof n, 'number')
    }
  }
})

test('a day older than the window is dropped on the next write', () => {
  const p = where()
  const c = new Counts(p)
  c.add('landing', at('2025-01-01T00:00:00Z'))
  c.add('landing', at(DAY))
  c.flush(at(DAY))
  assert.equal(c.report().days['2025-01-01'], undefined)
  assert.equal(c.report().days['2026-09-14'].landing, 1)
})

test('a path that cannot be written turns the counter off rather than throwing', () => {
  // A dev box with no volume, or a disk that filled. Counting is a convenience and must
  // never be able to take the resolver down with it.
  // A directory inside a regular file: impossible on every platform, unlike a path
  // under /proc, which Windows will happily create.
  const file = join(mkdtempSync(join(tmpdir(), 'counts-')), 'a-file')
  writeFileSync(file, 'not a directory')
  const c = new Counts(join(file, 'nested', 'counts.json'))
  assert.equal(c.on, false)
  assert.equal(c.add('landing'), false)
  assert.deepEqual(c.report().total, {})
})
