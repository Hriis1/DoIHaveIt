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

function popup() {
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
  let scan
  let select = async () => null
  let save = async (photo, insert) => { await insert('item-photos/saved.jpg'); deleted.push(photo) }
  const context = {
    html: '', AbortController, console: { error() {} },
    document: { createElement: () => ({}) },
    getProductByBarcode: async () => ({ id: 7, name: 'Product', brand: 'Brand', size: null }),
    isProductInCollection: async () => false,
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
    node, deleted, inserted, unmount,
    scan: async () => { scan('123'); await settle() },
    select: callback => { select = callback },
    save: callback => { save = callback },
  }
}

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
