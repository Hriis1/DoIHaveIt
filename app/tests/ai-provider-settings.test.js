import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/modules/aiProviderSettings.js', import.meta.url), 'utf8')
  .replace(/export function /g, 'function ')
function preferences(localStorage) {
  const context = { localStorage }
  runInNewContext(source + '\nthis.api = { getAiProviderSettings, saveAiProviderSettings }', context)
  return context.api
}

test('provider preferences persist only the selection and default safely for missing or invalid data', () => {
  let stored = null
  const { getAiProviderSettings, saveAiProviderSettings } = preferences({ getItem: () => stored, setItem: (key, value) => {
    assert.equal(key, 'doihaveit.ai-provider')
    stored = value
  } })
  assert.deepEqual({ ...getAiProviderSettings() }, { useAppKey: true, provider: 'gemini' })
  for (const provider of ['gemini', 'deepseek', 'openai']) {
    saveAiProviderSettings({ useAppKey: false, provider, apiKey: 'must-not-be-stored' })
    assert.deepEqual(JSON.parse(stored), { useAppKey: false, provider })
    assert.deepEqual({ ...getAiProviderSettings() }, { useAppKey: false, provider })
  }
  for (const value of ['broken JSON', 'null', '{}', '{"provider":"other","useAppKey":false}', '{"provider":"gemini","useAppKey":"false"}']) {
    stored = value
    assert.deepEqual({ ...getAiProviderSettings() }, { useAppKey: true, provider: 'gemini' })
  }
  assert.throws(() => saveAiProviderSettings({ provider: 'other', useAppKey: false }), /Invalid AI provider settings/)
})

test('preference storage failures propagate so the screen can report them', () => {
  const { getAiProviderSettings, saveAiProviderSettings } = preferences({
    getItem() { throw new Error('Blocked') },
    setItem() { throw new Error('Full') },
  })
  assert.throws(getAiProviderSettings, /Blocked/)
  assert.throws(() => saveAiProviderSettings({ useAppKey: false, provider: 'openai' }), /Full/)
})
