import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

// Exercise async screen behavior without Vite's CSS and raw HTML imports
const source = readFileSync(new URL('../src/screens/aiProvider/aiProvider.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountAiProviderScreen', 'function mountAiProviderScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function mount({ useAppKey = false, provider = 'gemini', getKey = async () => null, saveKey = async () => {}, deleteKey = async () => {} } = {}) {
  const nodes = new Map()
  function node(selector) {
    if (!nodes.has(selector)) {
      const listeners = new Map()
      nodes.set(selector, {
        value: '', type: 'password', hidden: false, disabled: false, checked: false, textContent: '', attributes: {},
        addEventListener(event, handler, { signal }) {
          listeners.set(event, handler)
          signal.addEventListener('abort', () => listeners.delete(event), { once: true })
        },
        emit(event = 'click') { listeners.get(event)?.({ preventDefault() {} }) },
        setAttribute(name, value) { this.attributes[name] = value },
        querySelector: child => node(`${selector} ${child}`),
        focus() {}, remove() {},
      })
    }
    return nodes.get(selector)
  }
  const modes = [node('app-mode'), node('own-mode')]
  modes[0].value = 'app'
  modes[1].value = 'own'
  const settings = []
  let preferenceError = false
  const saved = []
  const deleted = []
  const read = []
  const context = {
    html: '', AbortController,
    getAiProviderSettings: () => ({ useAppKey, provider }),
    saveAiProviderSettings: value => {
      if (preferenceError) throw new Error('Blocked')
      settings.push({ ...value })
    },
    getApiKey: value => { read.push(value); return getKey(value) },
    saveApiKey: (...args) => { saved.push(args); return saveKey(...args) },
    deleteApiKey: value => { deleted.push(value); return deleteKey(value) },
  }
  runInNewContext(source + '\nthis.mount = mountAiProviderScreen', context)
  const screen = { querySelector: node, querySelectorAll: () => modes, remove() {} }
  const unmount = context.mount({ querySelector: () => screen }, { isNative: true })
  return {
    node, saved, deleted, settings, read, unmount,
    failPreferences: () => { preferenceError = true },
    changeProvider(value) { node('#ai-provider').value = value; node('#ai-provider').emit('change') },
    changeMode(own) { modes[0].checked = !own; modes[1].checked = own; modes[own ? 1 : 0].emit('change') },
    submit(value) { node('#ai-api-key').value = value; node('.ai-provider-form').emit('submit') },
  }
}

test('app-key mode hides key controls; own-key mode saves the selection and loads the chosen provider', async () => {
  const ui = mount({ useAppKey: true })
  assert.equal(ui.node('.ai-provider-own').hidden, true)
  assert.deepEqual(ui.read, [])
  ui.changeMode(true)
  await settle()
  assert.equal(ui.node('.ai-provider-own').hidden, false)
  ui.changeProvider('openai')
  await settle()
  assert.deepEqual(ui.read, ['gemini', 'openai'])
  assert.equal(ui.settings.at(-1).provider, 'openai')
  assert.equal(ui.settings.at(-1).useAppKey, false)
  assert.equal(ui.node('.ai-key-remove').disabled, true)
  ui.unmount()
})

test('paste, reveal, save, replace and remove target only the selected provider', async () => {
  const ui = mount({ provider: 'deepseek', getKey: async () => 'existing-secret' })
  await settle()
  assert.equal(ui.node('#ai-api-key').value, '')
  assert.equal(ui.node('.ai-key-remove').disabled, false)
  ui.node('.ai-key-visibility').emit()
  assert.equal(ui.node('#ai-api-key').type, 'text')
  assert.equal(ui.node('.ai-key-visibility').attributes['aria-label'], 'Hide API key')
  ui.submit(' pasted-key ')
  await settle()
  assert.deepEqual(ui.saved, [['deepseek', 'pasted-key']])
  assert.equal(ui.node('#ai-api-key').value, '')
  assert.equal(ui.node('#ai-api-key').type, 'password')
  assert.equal(ui.node('.ai-provider-message').textContent, 'API key saved.')
  ui.node('.ai-key-remove').emit()
  await settle()
  assert.deepEqual(ui.deleted, ['deepseek'])
  assert.equal(ui.node('.ai-key-remove').disabled, true)
  assert.equal(ui.node('.ai-provider-message').textContent, 'API key removed.')
  ui.unmount()
})

test('empty keys are rejected and duplicate writes and provider changes are blocked while saving', async () => {
  const pending = deferred()
  const ui = mount({ saveKey: () => pending.promise })
  await settle()
  ui.submit(' ')
  assert.equal(ui.node('.ai-provider-error').textContent, 'An API key is required.')
  assert.equal(ui.saved.length, 0)
  ui.submit('first')
  ui.submit('second')
  ui.changeProvider('openai')
  assert.equal(ui.node('.ai-provider-fields').disabled, true)
  assert.deepEqual(ui.saved, [['gemini', 'first']])
  assert.equal(ui.settings.length, 0)
  pending.resolve()
  await settle()
  assert.equal(ui.node('.ai-provider-fields').disabled, false)
  ui.unmount()
})

test('read, save and delete errors are safe to display and failed writes can be retried', async () => {
  const broken = mount({ getKey: async () => { throw new Error('private-native-detail') } })
  await settle()
  assert.equal(broken.node('.ai-provider-error').hidden, false)
  assert.equal(broken.node('.ai-provider-error').textContent.includes('private-native-detail'), false)
  assert.equal(broken.node('.ai-provider-fields').disabled, false)
  broken.unmount()
  let fail = true
  const ui = mount({ getKey: async () => 'saved', saveKey: async () => {
    if (fail) throw new Error('private-native-detail')
  }, deleteKey: async () => { throw new Error('private-native-detail') } })
  await settle()
  ui.submit('retry-key')
  await settle()
  assert.equal(ui.node('#ai-api-key').value, 'retry-key')
  assert.match(ui.node('.ai-provider-error').textContent, /Could not save/)
  fail = false
  ui.submit('retry-key')
  await settle()
  assert.equal(ui.node('.ai-provider-error').hidden, true)
  ui.node('.ai-key-remove').emit()
  await settle()
  assert.match(ui.node('.ai-provider-error').textContent, /Could not remove/)
  assert.equal(ui.node('.ai-key-remove').disabled, false)
  ui.unmount()
})

test('provider preference failures restore the previous choice and switching clears unsaved secrets', async () => {
  const ui = mount()
  await settle()
  ui.node('#ai-api-key').value = 'unsaved-secret'
  ui.changeProvider('openai')
  await settle()
  assert.equal(ui.node('#ai-api-key').value, '')
  ui.failPreferences()
  ui.changeProvider('deepseek')
  assert.equal(ui.node('#ai-provider').value, 'openai')
  assert.match(ui.node('.ai-provider-error').textContent, /Could not save your provider selection/)
  ui.unmount()
})

test('leaving clears secrets, removes listeners and ignores late storage results', async () => {
  for (const action of ['read', 'save', 'delete']) {
    const pending = deferred()
    const ui = mount({
      getKey: action === 'read' ? () => pending.promise : async () => 'saved',
      saveKey: action === 'save' ? () => pending.promise : async () => {},
      deleteKey: action === 'delete' ? () => pending.promise : async () => {},
    })
    if (action !== 'read') await settle()
    if (action === 'save') ui.submit('secret')
    if (action === 'delete') ui.node('.ai-key-remove').emit()
    const message = ui.node('.ai-provider-message').textContent
    const status = ui.node('.ai-key-status').textContent
    ui.unmount()
    pending.resolve('late-secret')
    await settle()
    assert.equal(ui.node('#ai-api-key').value, '')
    assert.equal(ui.node('.ai-provider-message').textContent, message)
    assert.equal(ui.node('.ai-key-status').textContent, status)
    ui.submit('after-unmount')
    assert.equal(ui.saved.length, action === 'save' ? 1 : 0)
  }
})
