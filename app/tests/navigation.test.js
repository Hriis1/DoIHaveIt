import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNavigation, dismissActiveOverlay, registerBackHandler } from '../src/modules/navigation.js'

test('Back pops routes without adding them again and keeps their parameters', () => {
  const screens = []
  const navigation = createNavigation((name, parameters) => screens.push({ name, parameters }))
  const parameters = { collection: { id: 5 } }
  navigation.navigate('collections')
  navigation.navigate('collection', parameters)
  navigation.navigate('add-credit')
  assert.equal(navigation.goBack(), true)
  assert.deepEqual(screens.at(-1), { name: 'collection', parameters })
  assert.equal(navigation.goBack(), true)
  assert.equal(screens.at(-1).name, 'collections')
  assert.equal(navigation.goBack(), false)
})

test('reopening the current screen does not add a duplicate and reset/clear discard old routes', () => {
  const screens = []
  const navigation = createNavigation(name => screens.push(name))
  navigation.navigate('collections')
  navigation.navigate('account')
  navigation.navigate('account')
  navigation.goBack()
  assert.equal(screens.at(-1), 'collections')
  assert.equal(navigation.goBack(), false)
  navigation.navigate('account')
  navigation.navigate('collections', {}, { reset: true })
  assert.equal(navigation.goBack(), false)
  navigation.clear()
  navigation.navigate('login')
  assert.equal(navigation.goBack(), false)
})

test('overlay handlers run newest first and a blocked overlay still consumes Back', () => {
  const called = []
  const first = registerBackHandler(() => called.push('popup'))
  const second = registerBackHandler(() => called.push('saving'))
  assert.equal(dismissActiveOverlay(), true)
  assert.equal(dismissActiveOverlay(), true)
  assert.deepEqual(called, ['saving', 'saving'])
  second()
  assert.equal(dismissActiveOverlay(), true)
  assert.equal(called.at(-1), 'popup')
  first()
  first()
  assert.equal(dismissActiveOverlay(), false)
})
