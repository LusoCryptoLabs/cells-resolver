// The store that holds statements for short links is the sealed store with a longer
// memory and its own noun: a statement is public, and its link should outlive an invoice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedStore } from '../src/sealed.ts'

const ID = 'AbCdEfGhIjKl'

test('a statement store keeps a blob for the years it was given, not ninety days', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statements-'))
  try {
    const s = new SealedStore(dir, { defaultDays: 3650, maxDays: 3650, what: 'a statement' })
    const out = s.put(ID, 'eyJzIjp7fX0')
    assert.equal(out.ok, true)
    const days = (((out as { expires: number }).expires - Math.floor(Date.now() / 1000)) / 86_400)
    assert.ok(days > 3649 && days <= 3650, `kept for ${days} days`)
    // The control: the same store with no options is the ninety-day one.
    const plain = new SealedStore(mkdtempSync(join(tmpdir(), 'sealed-')))
    const p = plain.put(ID, 'eyJzIjp7fX0') as { expires: number }
    assert.ok((p.expires - Math.floor(Date.now() / 1000)) / 86_400 <= 90)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a statement store speaks of statements when it refuses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'statements-'))
  try {
    const s = new SealedStore(dir, { what: 'a statement' })
    const bad = s.put(ID, 'not base64url!')
    assert.equal(bad.ok, false)
    assert.match(bad.ok === false ? bad.error : '', /^a statement is base64url/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
