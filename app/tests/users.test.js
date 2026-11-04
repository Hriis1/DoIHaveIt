import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUserRepository } from '../src/repositories/userRepo.js'
import { fixture } from './catalog-fixture.js'

test('current-user replacement is atomic, preserves collections, and rolls back an invalid replacement', async t => {
  const { adapter, database } = fixture(t)
  const users = createUserRepository(operation => operation(adapter))
  database.exec("INSERT INTO collections (name) VALUES ('My collection');")
  assert.equal(await users.getCurrentUser(), null)
  await users.saveCurrentUser({ id: 42, email: 'first@example.com', credits: 5 })
  await users.saveCurrentUser({ id: 99, email: "o'connor@example.com", credits: 0 })
  assert.deepEqual({ ...await users.getCurrentUser() }, { id: 99, email: "o'connor@example.com", credits: 0 })
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1)
  await assert.rejects(users.saveCurrentUser({ id: 10, email: 'bad@example.com', credits: -1 }))
  assert.equal((await users.getCurrentUser()).id, 99)
  await users.deleteCurrentUser()
  assert.equal(await users.getCurrentUser(), null)
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM collections').get().n, 1)
})
