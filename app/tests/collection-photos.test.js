import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createPopup } from '../src/modules/popup.js'

// Exercise popup lifecycle without loading Vite's CSS and raw HTML imports
const source = readFileSync(new URL('../src/screens/collection/collection.js', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function mountCollectionScreen', 'function mountCollectionScreen')
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function popup({ product = { id: 7, name: 'Product', brand: 'Brand', size: null }, inCollection = false, items = [] } = {}) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = new Map()
      const attributes = new Map()
      nodes.set(selector, {
        hidden: false, disabled: false, open: false, textContent: '', value: '', children: [],
        addEventListener(event, handler) {
          if (!listeners.has(event)) listeners.set(event, new Set())
          listeners.get(event).add(handler)
        },
        removeEventListener: (event, handler) => listeners.get(event)?.delete(handler),
        getBoundingClientRect: () => ({ left: 0, right: 400, top: 0, bottom: 600 }),
        emit(event = 'click', data = {}) { for (const handler of listeners.get(event) ?? []) handler({ target: this, preventDefault() {}, ...data }) },
        setAttribute: (name, value) => attributes.set(name, value),
        getAttribute: name => attributes.get(name),
        focus() { this.focused = true },
        contains(target) { return target === this || this.children.includes(target) },
        replaceChildren(...children) {
          this.children = children.length === 1 && children[0].isFragment ? children[0].children : children
        },
        append(child) { this.children.push(child) },
        querySelector(child) { return child === '[role="option"]'
          ? this.children.find(option => option.getAttribute('role') === 'option') : node(`${selector} ${child}`) },
        querySelectorAll() { return this.children.filter(option => option.getAttribute('role') === 'option') },
        showModal() { this.open = true },
        close() { this.open = false; this.emit('close') },
        remove() {},
      })
    }
    return nodes.get(selector)
  }
  const deleted = []
  const inserted = []
  const resolved = []
  const memberships = []
  const removed = []
  const deletedSaved = []
  let remove = async (collectionId, itemId) => {
    removed.push([collectionId, itemId])
    const item = items.find(item => item.id === itemId)
    items = items.filter(item => item.id !== itemId)
    return item?.item_image ?? null
  }
  node('.item-template').content = { cloneNode: () => ({ querySelector: selector => node(`card ${selector}`) }) }
  let scan
  let lookup = async () => { throw new Error('AI lookup failed') }
  let resolveProduct = async (barcode, product, { signal }) => {
    signal.throwIfAborted()
    resolved.push({ barcode, ...product })
    return { id: 9, ...product }
  }
  let select = async () => null
  let brands = async () => []
  let names = async () => []
  let sizes = async () => []
  let save = async (photo, insert) => { await insert('item-photos/saved.jpg'); deleted.push(photo) }
  let created = 0
  const context = {
    html: '', createPopup, AbortController, console: { error() {} },
    document: { createElement: tag => node(`created-${tag}-${created++}`), createDocumentFragment: () => ({ isFragment: true, children: [],
      appendChild(child) { this.children.push(child) } }) },
    getProductByBarcode: async () => product,
    getProductBrands: (...args) => brands(...args),
    getProductNames: (...args) => names(...args),
    getProductSizes: (...args) => sizes(...args),
    isProductInCollection: async (...args) => { memberships.push(args); return inCollection },
    lookupProductWithAi: (...args) => lookup(...args),
    resolveAiProduct: (...args) => resolveProduct(...args),
    resolveProduct: (...args) => resolveProduct(...args),
    createScanner: options => { scan = options.onScan; return { destroy() {} } },
    getCollectionItems: async () => ({ items, total: items.length + inserted.length, page: 1, totalPages: 1 }),
    removeCollectionItem: (...args) => remove(...args),
    deleteSavedItemPhoto: async path => { if (path) deletedSaved.push(path) },
    Filesystem: { getUri: async ({ path }) => ({ uri: `file:///data/${path}` }) },
    Directory: { Data: 'DATA' }, Capacitor: { convertFileSrc: uri => `web:${uri}` },
    addCollectionItem: async (...args) => { inserted.push(args) },
    selectItemPhoto: source => select(source),
    deleteTemporaryPhoto: async photo => { if (photo) deleted.push(photo) },
    saveItemPhoto: (photo, insert) => save(photo, insert),
  }
  runInNewContext(source + '\nthis.mount = mountCollectionScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) }, {
    collection: { id: 3, name: 'Collection' }, isNative: items.length > 0, databaseReady: Promise.resolve(), navigate() {},
  })
  return {
    node, deleted, inserted, resolved, memberships, unmount, removed, deletedSaved,
    remove: callback => { remove = callback },
    scan: async (barcode = '123') => { scan(barcode); await settle() },
    ai: callback => { lookup = callback },
    resolve: callback => { resolveProduct = callback },
    select: callback => { select = callback },
    options: callbacks => {
      if (callbacks.brands) brands = callbacks.brands
      if (callbacks.names) names = callbacks.names
      if (callbacks.sizes) sizes = callbacks.sizes
    },
    save: callback => { save = callback },
    result: (value, owned = false) => { product = value; inCollection = owned },
  }
}

test('item details show the saved image and fields, and dismissal does not remove anything', async () => {
  const ui = popup({ items: [{ id: 8, brand: 'brand', name: 'name', size: '330 ml', item_image: 'item-photos/photo.jpg' }] })
  await settle()
  ui.node('card .item-open').emit()
  await settle()
  assert.equal(ui.node('.item-detail-dialog').open, true)
  assert.equal(ui.node('.item-detail-brand').textContent, 'brand')
  assert.equal(ui.node('.item-detail-name').textContent, 'name')
  assert.equal(ui.node('.item-detail-size').textContent, '330 ml')
  const image = ui.node('.item-detail-image').children.at(-1)
  assert.equal(image.src, 'web:file:///data/item-photos/photo.jpg')
  ui.node('.item-detail-close').emit()
  assert.equal(ui.node('.item-detail-dialog').open, false)
  assert.deepEqual(ui.removed, [])
  assert.deepEqual(ui.deletedSaved, [])
  ui.unmount()
})

test('removal is guarded, deletes only the selected item photo and refreshes the empty gallery', async () => {
  const ui = popup({ items: [{ id: 8, brand: 'brand', name: 'name', size: null, item_image: 'item-photos/photo.jpg' }] })
  await settle()
  ui.node('card .item-open').emit()
  assert.equal(ui.node('.item-detail-size-row').hidden, true)
  ui.node('.item-detail-remove').emit()
  ui.node('.item-detail-remove').emit()
  ui.node('.item-detail-close').emit()
  assert.equal(ui.node('.item-detail-dialog').open, true)
  await settle()
  assert.deepEqual(ui.removed, [[3, 8]])
  assert.deepEqual(ui.deletedSaved, ['item-photos/photo.jpg'])
  assert.equal(ui.node('.item-detail-dialog').open, false)
  assert.equal(ui.node('.gallery-count').textContent, '0 items')
  assert.equal(ui.node('.gallery-empty').hidden, false)
  ui.unmount()
})

test('failed removal keeps the popup and photo available for retry', async () => {
  const ui = popup({ items: [{ id: 8, brand: 'brand', name: 'name', size: null, item_image: 'item-photos/photo.jpg' }] })
  ui.remove(async () => { throw new Error('Database unavailable') })
  await settle()
  ui.node('card .item-open').emit()
  ui.node('.item-detail-remove').emit()
  await settle()
  assert.equal(ui.node('.item-detail-dialog').open, true)
  assert.equal(ui.node('.item-detail-error').hidden, false)
  assert.equal(ui.node('.item-detail-remove').disabled, false)
  assert.deepEqual(ui.deletedSaved, [])
  ui.unmount()
})

test('dropdowns load only when their arrow opens them, and toggle fully closed without blurring', async () => {
  const ui = popup({ product: null })
  const values = Array.from({ length: 100 }, (_, index) => `brand ${index}`)
  let calls = 0
  ui.options({ brands: async () => { calls++; return values } })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').emit('focus')
  ui.node('#scan-brand-input').value = 'brand'
  ui.node('#scan-brand-input').emit('input')
  await settle()
  assert.equal(calls, 0)
  ui.node('#scan-brand-toggle').emit()
  await settle()
  assert.equal(calls, 1)
  assert.equal(ui.node('#scan-brand-options').hidden, false)
  assert.equal(ui.node('#scan-brand-options').children.length, values.length)
  assert.equal(ui.node('#scan-brand-options').children.at(-1).value, values.at(-1))
  assert.equal(ui.node('#scan-brand-toggle').getAttribute('aria-expanded'), 'true')
  ui.node('#scan-brand-toggle').emit()
  assert.equal(ui.node('#scan-brand-options').hidden, true)
  assert.equal(ui.node('#scan-brand-options').children.length, 0)
  assert.equal(ui.node('#scan-brand-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(calls, 1)
  ui.node('#scan-brand-toggle').emit()
  await settle()
  assert.equal(calls, 2)
  ui.node('#scan-brand-input').emit('focus')
  assert.equal(ui.node('#scan-brand-options').hidden, true)
  assert.equal(calls, 2)
})

test('opening each dropdown uses current trimmed dependencies and preserves other entered values', async () => {
  const ui = popup({ product: null })
  const requested = []
  ui.options({ brands: async () => ['brand', 'other'],
    names: async brand => { requested.push(['names', brand]); return brand === 'brand' ? ['product', 'second'] : [] },
    sizes: async (brand, name) => {
      requested.push(['sizes', brand, name])
      return brand === 'brand' && name === 'product' ? ['330 ml', '500 ml'] : []
    } })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = ' Brand   '
  ui.node('#scan-name-input').value = ' Product  '
  ui.node('#scan-size-input').value = 'Custom size '
  ui.node('#scan-name-toggle').emit()
  await settle()
  assert.deepEqual(ui.node('#scan-name-options').children.map(option => option.value), ['product', 'second'])
  ui.node('#scan-size-toggle').emit()
  await settle()
  assert.equal(ui.node('#scan-name-options').hidden, true)
  assert.equal(JSON.stringify(requested), JSON.stringify([['names', 'brand'], ['sizes', 'brand', 'product']]))
  assert.deepEqual(ui.node('#scan-size-options').children.map(option => option.value), ['330 ml', '500 ml'])
  ui.node('#scan-size-options').children[0].emit()
  assert.equal(ui.node('#scan-size-input').value, '330 ml')
  assert.equal(ui.node('#scan-brand-input').value, ' Brand   ')
  assert.equal(ui.node('#scan-name-input').value, ' Product  ')
  assert.equal(ui.node('#scan-size-options').hidden, true)
  ui.node('#scan-size-input').value = 'Custom size '
  ui.node('#scan-brand-input').value = 'unknown'
  ui.node('#scan-brand-input').emit('input')
  await settle()
  assert.equal(requested.length, 2)
  assert.equal(ui.node('#scan-name-input').value, ' Product  ')
  assert.equal(ui.node('#scan-size-input').value, 'Custom size ')
  ui.node('#scan-name-toggle').emit()
  await settle()
  assert.equal(ui.node('#scan-name-options').children[0].textContent, 'No saved options')
  ui.node('#scan-brand-input').value = 'brand'
  ui.node('#scan-brand-input').emit('input')
  await settle()
  ui.node('#scan-name-input').value = 'New name'
  ui.node('#scan-name-input').emit('input')
  await settle()
  ui.node('#scan-size-toggle').emit()
  await settle()
  assert.equal(ui.node('#scan-size-options').children[0].textContent, 'No saved options')
  assert.equal(ui.node('#scan-size-input').value, 'Custom size ')
})

test('each dropdown passes its own trimmed text and the 100-result limit to its repository query', async () => {
  const ui = popup({ product: null })
  const requested = []
  ui.options({
    brands: async (...args) => { requested.push(['brands', ...args]); return ['monster energy'] },
    names: async (...args) => { requested.push(['names', ...args]); return ['zero ultra'] },
    sizes: async (...args) => { requested.push(['sizes', ...args]); return ['500 ml'] },
  })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = ' Monster Ener  '
  ui.node('#scan-brand-input').emit('input')
  await settle()
  assert.deepEqual(requested, [])
  ui.node('#scan-brand-toggle').emit()
  await settle()
  ui.node('#scan-brand-input').value = ' Monster Energy  '
  ui.node('#scan-brand-input').emit('input')
  ui.node('#scan-name-input').value = ' UL '
  ui.node('#scan-name-toggle').emit()
  await settle()
  ui.node('#scan-name-input').value = ' Zero Ultra '
  ui.node('#scan-name-input').emit('input')
  ui.node('#scan-size-input').value = ' ML  '
  ui.node('#scan-size-toggle').emit()
  await settle()
  assert.deepEqual(requested, [
    ['brands', 'monster ener', 100],
    ['names', 'monster energy', 'ul', 100],
    ['sizes', 'monster energy', 'zero ultra', 'ml', 100],
  ])
  assert.equal(ui.node('#scan-size-input').value, ' ML  ')
})

test('outdated dropdown results cannot replace newer options or update a closed popup', async () => {
  const ui = popup({ product: null })
  const oldNames = deferred()
  const oldSizes = deferred()
  ui.options({ names: brand => brand === 'old' ? oldNames.promise : ['new name'],
    sizes: brand => brand === 'old' ? oldSizes.promise : ['new size'] })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = 'old'
  ui.node('#scan-name-input').value = 'name'
  ui.node('#scan-name-toggle').emit()
  await settle()
  ui.node('#scan-name-toggle').emit()
  assert.equal(ui.node('#scan-name-options').hidden, true)
  ui.node('#scan-brand-input').value = 'new'
  ui.node('#scan-name-toggle').emit()
  await settle()
  ui.node('#scan-size-toggle').emit()
  await settle()
  oldNames.resolve(['outdated name'])
  oldSizes.resolve(['outdated size'])
  await settle()
  assert.equal(ui.node('#scan-name-options').hidden, true)
  assert.deepEqual(ui.node('#scan-size-options').children.map(option => option.value), ['new size'])
  const late = deferred()
  ui.options({ names: () => late.promise })
  ui.node('#scan-name-toggle').emit()
  await settle()
  ui.node('.scan-result-close').emit()
  late.resolve(['late name'])
  await settle()
  assert.equal(ui.node('#scan-name-options').children.length, 0)
})

test('outside taps and Escape or Android back close the dropdown before the popup', async () => {
  const ui = popup({ product: null })
  ui.options({ brands: async () => ['brand'] })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-toggle').emit()
  await settle()
  ui.node('.scan-result-dialog').emit('pointerdown')
  assert.equal(ui.node('#scan-brand-options').hidden, true)
  assert.equal(ui.node('.scan-result-dialog').open, true)
  ui.node('#scan-brand-toggle').emit()
  await settle()
  let prevented = false
  ui.node('.scan-result-dialog').emit('keydown', { key: 'Escape', preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(ui.node('#scan-brand-options').hidden, true)
  assert.equal(ui.node('.scan-result-dialog').open, true)
  ui.node('#scan-brand-toggle').emit()
  await settle()
  ui.node('.scan-result-dialog').emit('cancel')
  assert.equal(ui.node('#scan-brand-options').hidden, true)
  assert.equal(ui.node('.scan-result-dialog').open, true)
  ui.node('.scan-result-dialog').emit('cancel')
  assert.equal(ui.node('.scan-result-dialog').open, false)
})

test('suggestion failures leave custom values usable and do not prevent adding', async () => {
  const ui = popup({ product: null })
  ui.options({ brands: async () => { throw new Error('Read failed') } })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-toggle').emit()
  await settle()
  assert.equal(ui.node('#scan-brand-options').children[0].textContent, 'Could not load options. You can still type a value.')
  ui.node('#scan-brand-input').value = ' Brand '
  ui.node('#scan-name-input').value = ' Custom name '
  ui.node('#scan-size-input').value = '   '
  ui.select(async () => ({ path: 'manual.jpg', webPath: 'preview' }))
  ui.node('.scan-photo-camera').emit()
  await settle()
  ui.node('.scan-result-add').emit()
  await settle()
  assert.deepEqual(ui.resolved, [{ barcode: '123', brand: 'brand', name: 'custom name', size: null }])
  assert.equal(ui.inserted.length, 1)
})

test('scan results show only their matching bottom action and reset it on the next scan', async () => {
  const ui = popup({ inCollection: true })
  await ui.scan()
  assert.equal(ui.node('.scan-result-dismiss').hidden, false)
  assert.equal(ui.node('.scan-result-ai-search').hidden, true)
  assert.equal(ui.node('.scan-result-add').hidden, true)
  ui.node('.scan-result-dismiss').emit()
  assert.equal(ui.node('.scan-result-dialog').open, false)

  ui.result(null)
  await ui.scan()
  assert.equal(ui.node('.scan-result-dismiss').hidden, true)
  assert.equal(ui.node('.scan-result-ai-search').hidden, false)
  assert.equal(ui.node('.scan-result-add').hidden, true)
  ui.node('.scan-result-ai-search').emit()
  assert.equal(ui.node('.scan-result-dialog').open, true)
  assert.equal(ui.inserted.length, 0)

  ui.result({ id: 7, name: 'Product', brand: 'Brand', size: null })
  await ui.scan()
  assert.equal(ui.node('.scan-result-dismiss').hidden, true)
  assert.equal(ui.node('.scan-result-ai-search').hidden, true)
  assert.equal(ui.node('.scan-result-add').hidden, false)
  ui.unmount()
})

test('manual entry requires brand, name and photo before any product writes', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  assert.equal(ui.node('.scan-result-manual').hidden, false)
  ui.node('.scan-result-manual').emit()
  assert.equal(ui.node('#scan-result-title').textContent, 'Add product manually')
  assert.equal(ui.node('.scan-result-actions').hidden, true)
  assert.equal(ui.node('#scan-brand-input').hidden, false)
  assert.equal(ui.node('.scan-product-size-row').hidden, false)
  ui.node('#scan-brand-input').value = '   '
  ui.node('.scan-result-add').emit()
  assert.equal(ui.node('.scan-brand-error').hidden, false)
  assert.equal(ui.node('.scan-name-error').hidden, false)
  assert.equal(ui.node('.scan-photo-error').textContent, 'Photo required')
  assert.equal(ui.resolved.length, 0)
  ui.select(async () => ({ path: 'manual.jpg', webPath: 'preview' }))
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.node('.scan-result-add').emit()
  assert.equal(ui.resolved.length, 0)
  ui.node('#scan-brand-input').value = ' Brand '
  ui.node('#scan-name-input').value = ' Product '
  ui.node('.scan-result-add').emit()
  await settle()
  assert.deepEqual(ui.resolved, [{ barcode: '123', brand: 'brand', name: 'product', size: null }])
  assert.deepEqual(ui.inserted, [[3, 9, 'item-photos/saved.jpg']])
  assert.equal(ui.node('.scan-result-dialog').open, false)
})

test('manual entry links the barcode to an existing product and adds its photo to the collection', async () => {
  const ui = popup({ product: null })
  await ui.scan('new-barcode')
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = ' BRAND '
  ui.node('#scan-name-input').value = ' Name '
  ui.node('#scan-size-input').value = ' 330 ML '
  ui.resolve(async (barcode, product) => {
    assert.equal(barcode, 'new-barcode')
    assert.equal(JSON.stringify(product), JSON.stringify({ brand: 'brand', name: 'name', size: '330 ml' }))
    return { id: 22, ...product }
  })
  ui.select(async () => ({ path: 'manual.jpg', webPath: 'preview' }))
  ui.node('.scan-photo-camera').emit()
  await settle()
  ui.node('.scan-result-add').emit()
  ui.node('.scan-result-add').emit()
  await settle()
  assert.deepEqual(ui.inserted, [[3, 22, 'item-photos/saved.jpg']])
  assert.equal(ui.deleted.length, 1)
})

test('manual matches already in the collection still link the barcode and discard the unused photo', async () => {
  const ui = popup({ product: null, inCollection: true })
  await ui.scan('new-code')
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = 'brand'
  ui.node('#scan-name-input').value = 'product'
  const photo = { path: 'unused.jpg', webPath: 'preview' }
  ui.select(async () => photo)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.node('.scan-result-add').emit()
  await settle()
  assert.equal(ui.resolved[0].barcode, 'new-code')
  assert.equal(ui.node('#scan-result-title').textContent, 'product already in collection')
  assert.equal(ui.node('.scan-result-dismiss').hidden, false)
  assert.deepEqual(ui.inserted, [])
  assert.deepEqual(ui.deleted, [photo])
  ui.node('.scan-result-dismiss').emit()
  assert.equal(ui.deleted.length, 1)
})

test('cancelling manual entry deletes the photo without creating or linking a product', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  const photo = { path: 'cancelled.jpg', webPath: 'preview' }
  ui.select(async () => photo)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.node('.scan-result-close').emit()
  await settle()
  assert.deepEqual(ui.deleted, [photo])
  assert.deepEqual(ui.resolved, [])
  assert.deepEqual(ui.inserted, [])
})

test('manual entry is blocked during AI lookup and resets on the next scan', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  const lookup = deferred()
  ui.ai(() => lookup.promise)
  ui.node('.scan-result-ai-search').emit()
  assert.equal(ui.node('.scan-result-manual').disabled, true)
  ui.node('.scan-result-manual').emit()
  assert.equal(ui.node('#scan-brand-input').hidden, true)
  lookup.reject(new Error('No product'))
  await settle()
  ui.node('.scan-result-manual').emit()
  assert.equal(ui.node('#scan-brand-input').hidden, false)
  await ui.scan('next')
  assert.equal(ui.node('#scan-brand-input').hidden, true)
  assert.equal(ui.node('.scan-result-manual').hidden, false)
})

test('manual database failures retain inputs and photo for retry, and leaving during resolution prevents collection insertion', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  ui.node('.scan-result-manual').emit()
  ui.node('#scan-brand-input').value = 'brand'
  ui.node('#scan-name-input').value = 'name'
  const photo = { path: 'retry.jpg', webPath: 'preview' }
  ui.select(async () => photo)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.resolve(async () => { throw new Error('Database unavailable') })
  ui.node('.scan-result-add').emit()
  await settle()
  assert.equal(ui.node('.scan-photo-error').textContent, 'Database unavailable')
  assert.equal(ui.node('#scan-name-input').hidden, false)
  assert.equal(ui.node('#scan-name-input').value, 'name')
  assert.equal(ui.node('.scan-result-add').disabled, false)
  assert.deepEqual(ui.deleted, [])
  const pending = deferred()
  let signal
  ui.resolve((_barcode, _product, options) => { signal = options.signal; return pending.promise })
  ui.node('.scan-result-add').emit()
  await settle()
  ui.unmount()
  assert.equal(signal.aborted, true)
  pending.resolve({ id: 9, brand: 'brand', name: 'name', size: null })
  await settle()
  assert.deepEqual(ui.inserted, [])
  assert.deepEqual(ui.deleted, [photo])
})

test('Add shows Photo required until a selected photo is ready', async () => {
  const ui = popup()
  await ui.scan()
  ui.node('.scan-result-add').emit()
  assert.equal(ui.node('.scan-photo-error').textContent, 'Photo required')
  assert.equal(ui.node('.scan-photo-error').hidden, false)
  assert.equal(ui.inserted.length, 0)

  const selection = deferred()
  ui.select(() => selection.promise)
  ui.node('.scan-photo-camera').emit()
  ui.node('.scan-result-add').emit()
  assert.equal(ui.node('.scan-photo-error').textContent, 'Photo required')
  assert.equal(ui.inserted.length, 0)
  selection.resolve({ path: 'draft.jpg', webPath: 'preview' })
  await settle()
  assert.equal(ui.node('.scan-photo-error').hidden, true)
  assert.equal(ui.node('.scan-photo-preview').children[0].src, 'preview')
  ui.unmount()
})

test('insufficient credits show a placeholder Buy credits link and clear it on retry and a new scan', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  const error = new Error('Not enough credits')
  error.code = 'INSUFFICIENT_CREDITS'
  ui.ai(async () => { throw error })
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-error').textContent, 'Not enough credits')
  assert.equal(ui.node('.scan-result-buy-credits').hidden, false)
  assert.equal(ui.resolved.length, 0)
  ui.node('.scan-result-buy-credits').emit()
  assert.equal(ui.node('.scan-result-dialog').open, true)
  ui.ai(async () => { throw new Error('Network error') })
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-buy-credits').hidden, true)
  ui.ai(async () => { throw error })
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-buy-credits').hidden, false)
  await ui.scan('456')
  assert.equal(ui.node('.scan-result-buy-credits').hidden, true)
  ui.unmount()
})

test('replacement deletes the discarded draft, picker cancellation retains it, and popup cancellation deletes it', async () => {
  const ui = popup()
  await ui.scan()
  const first = { path: 'first.jpg', webPath: 'first' }
  const second = { path: 'second.jpg', webPath: 'second' }
  ui.select(async () => first)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.select(async () => null)
  ui.node('.scan-photo-camera').emit()
  await settle()
  assert.equal(ui.deleted.length, 0)
  assert.equal(ui.node('.scan-photo-preview').children[0].src, 'first')
  ui.select(async () => second)
  ui.node('.scan-photo-camera').emit()
  await settle()
  assert.deepEqual(ui.deleted, [first])
  ui.node('.scan-result-dialog').emit('cancel')
  await settle()
  assert.deepEqual(ui.deleted, [first, second])
  assert.equal(ui.node('.scan-result-dialog').open, false)
})

test('late picker results after closing or leaving the screen are deleted', async () => {
  for (const leaveScreen of [false, true]) {
    const ui = popup()
    await ui.scan()
    const selection = deferred()
    const photo = { path: 'late.jpg', webPath: 'late' }
    ui.select(() => selection.promise)
    ui.node('.scan-photo-camera').emit()
    if (leaveScreen) ui.unmount()
    else ui.node('.scan-result-close').emit()
    selection.resolve(photo)
    await settle()
    assert.deepEqual(ui.deleted, [photo])
    assert.equal(ui.node('.scan-photo-preview').children.length, 0)
  }
})

test('saving prevents double submits and closes the popup after adding to the current collection', async () => {
  const ui = popup()
  await ui.scan()
  const photo = { path: 'draft.jpg', webPath: 'preview' }
  ui.select(async () => photo)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  const saving = deferred()
  let calls = 0
  ui.save(async (selected, insert) => {
    calls++
    assert.equal(selected, photo)
    await saving.promise
    await insert('item-photos/saved.jpg')
    ui.deleted.push(photo)
  })
  ui.node('.scan-result-add').emit()
  ui.node('.scan-result-add').emit()
  ui.node('.scan-result-dialog').emit('cancel')
  assert.equal(calls, 1)
  assert.equal(ui.node('.scan-result-dialog').open, true)
  assert.equal(ui.node('.scan-result-close').disabled, true)
  saving.resolve()
  await settle()
  assert.deepEqual(ui.inserted, [[3, 7, 'item-photos/saved.jpg']])
  assert.deepEqual(ui.deleted, [photo])
  assert.equal(ui.node('.scan-result-dialog').open, false)
  assert.equal(ui.node('#item-search').value, '')
})

test('failed saves retain the photo and permit retry, while leaving during a failed save cleans it', async () => {
  const ui = popup()
  await ui.scan()
  const photo = { path: 'draft.jpg', webPath: 'preview' }
  ui.select(async () => photo)
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.save(async () => { throw new Error('Storage unavailable') })
  ui.node('.scan-result-add').emit()
  await settle()
  assert.equal(ui.node('.scan-photo-error').textContent, 'Storage unavailable')
  assert.equal(ui.node('.scan-result-dialog').open, true)
  assert.equal(ui.node('.scan-result-add').disabled, false)
  assert.equal(ui.deleted.length, 0)
  const saving = deferred()
  ui.save(() => saving.promise)
  ui.node('.scan-result-add').emit()
  ui.unmount()
  assert.equal(ui.deleted.length, 0)
  saving.reject(new Error('Save failed'))
  await settle()
  assert.deepEqual(ui.deleted, [photo])
})

test('AI lookup prevents duplicate requests and reuses the photo-required add flow for the resolved product', async () => {
  const ui = popup({ product: null })
  ui.node('#item-search').value = 'existing search'
  await ui.scan('004062139018352')
  const pending = deferred()
  const product = { brand: 'brand', name: 'product', size: '500 ml' }
  let calls = 0
  ui.ai((barcode, { signal }) => {
    calls++
    assert.equal(barcode, '004062139018352')
    assert.equal(signal.aborted, false)
    return pending.promise
  })
  ui.node('.scan-result-ai-search').emit()
  ui.node('.scan-result-ai-search').emit()
  assert.equal(calls, 1)
  assert.equal(ui.node('.scan-result-ai-search').disabled, true)
  assert.equal(ui.node('#scan-result-title').textContent, 'Searching for product…')
  pending.resolve(product)
  await settle()
  assert.deepEqual(ui.resolved, [{ barcode: '004062139018352', ...product }])
  assert.deepEqual(ui.memberships, [[9, 3]])
  assert.equal(ui.node('.scan-result-ai-search').hidden, true)
  assert.equal(ui.node('.scan-result-add').hidden, false)
  assert.equal(ui.node('.scan-result-product').hidden, false)
  assert.equal(ui.node('.scan-product-brand').textContent, 'brand')
  assert.equal(ui.node('.scan-product-name').textContent, 'product')
  assert.equal(ui.node('.scan-product-size').textContent, '500 ml')
  assert.equal(ui.node('#item-search').value, 'existing search')
  ui.node('.scan-result-add').emit()
  assert.equal(ui.node('.scan-photo-error').textContent, 'Photo required')
  assert.equal(ui.inserted.length, 0)
  ui.select(async () => ({ path: 'draft.jpg', webPath: 'preview' }))
  ui.node('.scan-photo-gallery').emit()
  await settle()
  ui.node('.scan-result-add').emit()
  await settle()
  assert.deepEqual(ui.inserted, [[3, 9, 'item-photos/saved.jpg']])
  assert.equal(ui.node('.scan-result-dialog').open, false)
})

test('an AI result already in the collection reuses the owned-product popup and Close button', async () => {
  const ui = popup({ product: null, inCollection: true })
  await ui.scan()
  ui.ai(async () => ({ brand: 'brand', name: 'product', size: null }))
  ui.resolve(async () => ({ id: 42, brand: 'Brand', name: 'Existing Product', size: null }))
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.deepEqual(ui.memberships, [[42, 3]])
  assert.equal(ui.node('#scan-result-title').textContent, 'Existing Product already in collection')
  assert.equal(ui.node('.scan-result-dismiss').hidden, false)
  assert.equal(ui.node('.scan-result-add').hidden, true)
  assert.equal(ui.node('.scan-result-product').hidden, true)
  assert.equal(ui.node('.scan-result-ai-search').hidden, true)
  ui.node('.scan-result-dismiss').emit()
  assert.equal(ui.node('.scan-result-dialog').open, false)
})

test('AI lookup errors display inside the popup without saving data and allow retry', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  ui.ai(async () => { throw new Error('Product not found') })
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-error').textContent, 'Product not found')
  assert.equal(ui.node('.scan-result-error').hidden, false)
  assert.equal(ui.node('.scan-result-ai-search').disabled, false)
  assert.equal(ui.node('.scan-result-ai-search').hidden, false)
  assert.equal(ui.node('.scan-result-product').hidden, true)
  assert.equal(ui.resolved.length, 0)
  ui.ai(async () => ({ brand: 'brand', name: 'product', size: null }))
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-error').hidden, true)
  assert.equal(ui.node('.scan-result-add').hidden, false)
  assert.equal(ui.node('.scan-product-size-row').hidden, true)
  ui.node('.scan-result-close').emit()
  assert.equal(ui.resolved.length, 1, 'Resolved product and barcode remain after cancelling the photo step')
  assert.equal(ui.inserted.length, 0)
})

test('database failures during AI resolution are displayed and can be retried', async () => {
  const ui = popup({ product: null })
  await ui.scan()
  ui.ai(async () => ({ brand: 'brand', name: 'product', size: null }))
  ui.resolve(async () => { throw new Error('Database unavailable') })
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-error').textContent, 'Database unavailable')
  assert.equal(ui.node('.scan-result-ai-search').disabled, false)
  assert.equal(ui.node('.scan-result-product').hidden, true)
  ui.resolve(async () => ({ id: 10, brand: 'brand', name: 'product', size: null }))
  ui.node('.scan-result-ai-search').emit()
  await settle()
  assert.equal(ui.node('.scan-result-error').hidden, true)
  assert.equal(ui.node('.scan-result-add').hidden, false)
  ui.unmount()
})

test('closing, leaving or starting another scan aborts AI lookup and ignores late responses', async () => {
  for (const action of ['close', 'leave', 'scan']) {
    const ui = popup({ product: null })
    await ui.scan()
    const pending = deferred()
    let signal
    ui.ai((barcode, options) => { signal = options.signal; return pending.promise })
    ui.node('.scan-result-ai-search').emit()
    if (action === 'close') ui.node('.scan-result-close').emit()
    else if (action === 'leave') ui.unmount()
    else {
      ui.result({ id: 12, brand: 'New', name: 'Scan', size: null })
      await ui.scan('new-barcode')
    }
    assert.equal(signal.aborted, true)
    pending.resolve({ brand: 'late', name: 'result', size: null })
    await settle()
    assert.equal(ui.resolved.length, 0)
    assert.equal(ui.inserted.length, 0)
    if (action === 'scan') {
      assert.equal(ui.node('.scan-product-brand').textContent, 'New')
      assert.equal(ui.node('.scan-product-name').textContent, 'Scan')
    } else assert.equal(ui.node('.scan-result-dialog').open, false)
  }
})
