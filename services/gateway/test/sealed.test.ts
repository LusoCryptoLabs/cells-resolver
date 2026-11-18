// The short-link store: a name keeps the first request put under it, and its count of
// bytes stays true when a retry writes the same file again.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SealedStore } from '../src/sealed.ts'

const ID = 'AbCdEfGhIjKl'

test('a different request cannot replace the one held under a name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'))
  try {
    const s = new SealedStore(dir)
    assert.equal(s.put(ID, 'first-blob').ok, true)
    const swap = s.put(ID, 'garbage')
    assert.equal(swap.ok, false)
    assert.equal(swap.ok === false && swap.code, 409)
    assert.equal(s.get(ID)?.blob, 'first-blob')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('putting the same request again is a retry, and the count does not climb', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sealed-'))
  try {
    const s = new SealedStore(dir)
    assert.equal(s.put(ID, 'same-blob').ok, true)
    const once = s.stats().bytes
    for (let i = 0; i < 5; i++) assert.equal(s.put(ID, 'same-blob').ok, true)
    assert.equal(s.stats().bytes, once)
    assert.equal(s.stats().held, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
