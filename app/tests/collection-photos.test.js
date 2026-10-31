import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

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

function popup({ product = { id: 7, name: 'Product', brand: 'Brand', size: null }, inCollection = false } = {}) {
  const nodes = new Map()
  const node = selector => {
    if (!nodes.has(selector)) {
      const listeners = new Map()
      nodes.set(selector, {
        hidden: false, disabled: false, open: false, textContent: '', value: '', children: [],
        addEventListener: (event, handler) => listeners.set(event, handler),
        emit: (event = 'click') => listeners.get(event)?.({ preventDefault() {} }),
        setAttribute() {},
        replaceChildren(...children) { this.children = children },
        querySelector: child => node(`${selector} ${child}`),
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
  let scan
  let lookup = async () => { throw new Error('AI lookup failed') }
  let resolveProduct = async (barcode, product, { signal }) => {
    signal.throwIfAborted()
    resolved.push({ barcode, ...product })
    return { id: 9, ...product }
  }
  let select = async () => null
  let save = async (photo, insert) => { await insert('item-photos/saved.jpg'); deleted.push(photo) }
  const context = {
    html: '', AbortController, console: { error() {} },
    document: { createElement: () => ({}) },
    getProductByBarcode: async () => product,
    isProductInCollection: async (...args) => { memberships.push(args); return inCollection },
    lookupProductWithAi: (...args) => lookup(...args),
    resolveAiProduct: (...args) => resolveProduct(...args),
    createScanner: options => { scan = options.onScan; return { destroy() {} } },
    getCollectionItems: async () => ({ items: [], total: inserted.length, page: 1, totalPages: 1 }),
    addCollectionItem: async (...args) => { inserted.push(args) },
    selectItemPhoto: source => select(source),
    deleteTemporaryPhoto: async photo => { if (photo) deleted.push(photo) },
    saveItemPhoto: (photo, insert) => save(photo, insert),
  }
  runInNewContext(source + '\nthis.mount = mountCollectionScreen', context)
  const unmount = context.mount({ querySelector: () => ({ querySelector: node, remove() {} }) }, {
    collection: { id: 3, name: 'Collection' }, isNative: false, databaseReady: Promise.resolve(), navigate() {},
  })
  return {
    node, deleted, inserted, resolved, memberships, unmount,
    scan: async (barcode = '123') => { scan(barcode); await settle() },
    ai: callback => { lookup = callback },
    resolve: callback => { resolveProduct = callback },
    select: callback => { select = callback },
    save: callback => { save = callback },
    result: (value, owned = false) => { product = value; inCollection = owned },
  }
}

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
