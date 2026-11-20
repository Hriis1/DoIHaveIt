import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../src/screens/addCredit/addCredit.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountAddCreditScreen', 'function mountAddCreditScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))

function mount(load, { purchase = async () => ({ status: 'cancelled' }), status = async () => ({ status: 'granted', credits: 100 }), manualTimer = false } = {}) {
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
        if (!fields.has(selector)) {
          const listeners = new Map()
          fields.set(selector, { textContent: '', disabled: false, setAttribute() {},
            addEventListener: (event, handler, { signal }) => {
              listeners.set(event, handler)
              signal.addEventListener('abort', () => listeners.delete(event), { once: true })
            }, emit: () => listeners.get('click')?.(),
          })
        }
        return fields.get(selector)
      } }
    },
  }
  const calls = []
  const purchases = []
  const balances = []
  const deadline = new AbortController()
  let pending
  let currentId = 'wallet'
  let timer
  const context = { html: '', AbortController, AbortSignal: { timeout: () => deadline.signal, any: AbortSignal.any },
    setTimeout: manualTimer ? callback => { timer = callback; return 1 } : setTimeout,
    clearTimeout: manualTimer ? () => { timer = undefined } : clearTimeout,
    auth: { getCurrentUser: async () => ({ id: currentId }), refreshCredits: async () => ({ id: currentId }),
      updateCredits: async (...args) => balances.push(args) },
    getCreditPacks: id => { calls.push(id); return load() }, isPurchasing: () => false,
    getPendingPurchase: () => pending, clearPendingPurchase: () => { pending = undefined },
    purchaseCreditPack: async (...args) => {
      purchases.push(args)
      const result = await purchase(...args)
      if (result.status === 'purchased') pending = result.transactionId
      return result
    }, getPurchaseStatus: status,
  }
  runInNewContext(source + '\nthis.mount = mountAddCreditScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) })
  return { node, calls, unmount, purchases, balances, tick: () => { const callback = timer; timer = undefined; callback?.() },
    expire: () => deadline.abort(), changeAccount: () => { currentId = 'another' },
    buy: () => node('.credit-packs').children[0].querySelector('.credit-pack-price').emit() }
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
  assert.equal(ui.node('.credit-packs-note').hidden, true)
  ui.unmount()
})

const packs = async () => [{ identifier: 'credits_100', credits: 100, price: '€0.99' }]

test('purchase confirmation updates the wallet once and duplicate clicks cannot buy again', async () => {
  let resolve
  const ui = mount(packs, { purchase: () => new Promise(yes => { resolve = yes }) })
  await settle()
  ui.buy()
  ui.buy()
  await settle()
  assert.equal(ui.purchases.length, 1)
  resolve({ status: 'purchased', transactionId: 'order' })
  await settle()
  assert.deepEqual(ui.balances, [['wallet', 100]])
  assert.equal(ui.node('.credit-packs-note').textContent, 'Credits added to your account.')
  ui.unmount()
})

test('cancellation, pending payment and failure never grant credits locally', async () => {
  for (const outcome of ['cancelled', 'pending', 'failure']) {
    const ui = mount(packs, { purchase: async () => {
      if (outcome === 'failure') throw new Error('Could not complete the purchase.')
      return { status: outcome }
    } })
    await settle()
    ui.buy()
    await settle()
    assert.deepEqual(ui.balances, [])
    if (outcome === 'pending') assert.match(ui.node('.credit-packs-note').textContent, /pending/)
    if (outcome === 'failure') assert.equal(ui.node('.credit-packs-error').hidden, false)
    ui.unmount()
  }
})

test('confirmation failures allow checking again without repurchasing', async () => {
  let attempts = 0
  const ui = mount(packs, {
    purchase: async () => ({ status: 'purchased', transactionId: 'order' }),
    status: async () => {
      if (++attempts === 1) throw new Error('offline')
      return { status: 'granted', credits: 100 }
    },
  })
  await settle()
  ui.buy()
  await settle()
  assert.equal(ui.node('.credit-packs-check').hidden, false)
  ui.buy()
  assert.equal(ui.purchases.length, 1)
  ui.node('.credit-packs-check').emit()
  await settle()
  assert.deepEqual(ui.balances, [['wallet', 100]])
  ui.unmount()
})

test('account changes prevent purchase and leaving aborts pending confirmation', async () => {
  const changed = mount(packs)
  await settle()
  changed.changeAccount()
  changed.buy()
  await settle()
  assert.equal(changed.purchases.length, 0)
  changed.unmount()
  let signal
  let resolve
  const ui = mount(packs, { purchase: async () => ({ status: 'purchased', transactionId: 'order' }),
    status: (_id, options) => { signal = options.signal; return new Promise(yes => { resolve = yes }) } })
  await settle()
  ui.buy()
  await settle()
  ui.unmount()
  assert.equal(signal.aborted, true)
  resolve({ status: 'granted', credits: 100 })
  await settle()
  assert.deepEqual(ui.balances, [])
})

test('confirmation deadline allows a later check and ignores late success', async () => {
  let resolve
  const ui = mount(packs, { purchase: async () => ({ status: 'purchased', transactionId: 'order' }),
    status: () => new Promise(yes => { resolve = yes }) })
  await settle()
  ui.buy()
  await settle()
  ui.expire()
  resolve({ status: 'granted', credits: 100 })
  await settle()
  assert.deepEqual(ui.balances, [])
  assert.equal(ui.node('.credit-packs-check').hidden, false)
  ui.unmount()
})

test('a refunded transaction updates the balance and reports the refund', async () => {
  const ui = mount(packs, { purchase: async () => ({ status: 'purchased', transactionId: 'order' }),
    status: async () => ({ status: 'refunded', credits: 0 }) })
  await settle()
  ui.buy()
  await settle()
  assert.deepEqual(ui.balances, [['wallet', 0]])
  assert.match(ui.node('.credit-packs-note').textContent, /refunded/)
  ui.unmount()
})

test('an increased balance with processing status is not confirmation and polling is sequential', async () => {
  let attempts = 0
  const ui = mount(packs, { manualTimer: true,
    purchase: async () => ({ status: 'purchased', transactionId: 'order' }),
    status: async () => ({ status: ++attempts === 1 ? 'processing' : 'granted', credits: 200 }),
  })
  await settle()
  ui.buy()
  await settle()
  assert.equal(attempts, 1)
  assert.deepEqual(ui.balances, [])
  ui.tick()
  await settle()
  assert.equal(attempts, 2)
  assert.deepEqual(ui.balances, [['wallet', 200]])
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
