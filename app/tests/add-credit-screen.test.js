import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/screens/addCredit/addCredit.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountAddCreditScreen', 'function mountAddCreditScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(load) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = new Map()
      nodes.set(selector, {
        hidden: false, textContent: '', children: [], attributes: {},
        addEventListener: (name, handler) => listeners.set(name, handler),
        removeEventListener: name => listeners.delete(name),
        emit: () => listeners.get('click')?.(),
        setAttribute(name, value) { this.attributes[name] = value },
        replaceChildren(...children) { this.children = children },
        remove() {},
      })
    }
    return nodes.get(selector)
  }
  node('.credit-pack-template').content = {
    cloneNode: () => {
      const fields = new Map()
      return { querySelector: selector => {
        if (!fields.has(selector)) fields.set(selector, { textContent: '' })
        return fields.get(selector)
      } }
    },
  }
  const calls = []
  const context = { html: '', auth: { getCurrentUser: async () => ({ id: 'wallet' }) },
    getCreditPacks: id => { calls.push(id); return load() } }
  runInNewContext(source + '\nthis.mount = mountAddCreditScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) })
  return { node, calls, unmount }
}

test('screen renders offering data, shows errors and retries without duplicate loads', async () => {
  let resolve
  let attempts = 0
  const ui = mount(() => {
    if (++attempts === 1) return Promise.reject(new Error('private SDK detail'))
    return new Promise(yes => { resolve = yes })
  })
  await settle()
  assert.equal(ui.node('.credit-packs-error').hidden, false)
  assert.doesNotMatch(ui.node('.credit-packs-error').textContent, /private/)
  ui.node('.credit-packs-retry').emit()
  ui.node('.credit-packs-retry').emit()
  await settle()
  assert.equal(ui.calls.length, 2)
  resolve([{ credits: 600, price: '4,99 €' }])
  await settle()
  const card = ui.node('.credit-packs').children[0]
  assert.equal(card.querySelector('.credit-pack-title').textContent, '600 credits')
  assert.equal(card.querySelector('.credit-pack-price').textContent, '4,99 €')
  assert.equal(ui.node('.credit-packs-note').hidden, false)
  ui.unmount()
})

test('leaving the screen ignores an outstanding offering response', async () => {
  let resolve
  const ui = mount(() => new Promise(yes => { resolve = yes }))
  await settle()
  ui.unmount()
  resolve([{ credits: 100, price: '€0.99' }])
  await settle()
  assert.equal(ui.node('.credit-packs').children.length, 0)
})
