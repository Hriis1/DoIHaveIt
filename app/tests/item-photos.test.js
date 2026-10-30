import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const files = new Map([['CACHE/item-photo-drafts/abandoned.jpg', 'old']])
const directories = new Set(['CACHE/item-photo-drafts'])
let cameraResult
let cameraError
let galleryOptions
let failCopy = false
const key = (path, directory) => directory ? `${directory}/${path}` : path.replace('file:///cache/', 'CACHE/')
const filesystem = {
  mkdir: async ({ path, directory }) => {
    const name = key(path, directory)
    if (directories.has(name)) throw new Error('Directory exists')
    directories.add(name)
  },
  stat: async ({ path, directory }) => {
    const name = key(path, directory)
    if (directories.has(name)) return { type: 'directory' }
    if (files.has(name)) return { type: 'file' }
    throw new Error('Not found')
  },
  readdir: async ({ path, directory }) => ({ files: [...files.keys()]
    .filter(name => name.startsWith(`${key(path, directory)}/`))
    .map(name => ({ name: name.split('/').at(-1), type: 'file' })) }),
  copy: async ({ from, directory, to, toDirectory }) => {
    if (failCopy) throw new Error('Storage full')
    const source = key(from, directory)
    assert.ok(files.has(source), `Missing source: ${source}`)
    files.set(key(to, toDirectory), files.get(source))
  },
  getUri: async ({ path }) => ({ uri: `file:///cache/${path}` }),
  deleteFile: async ({ path, directory }) => { files.delete(key(path, directory)) },
}
mock.module('@capacitor/filesystem', { namedExports: { Filesystem: filesystem, Directory: { Cache: 'CACHE', Data: 'DATA' } } })
mock.module('@capacitor/core', { namedExports: { Capacitor: { isNativePlatform: () => true, convertFileSrc: uri => `web:${uri}` } } })
mock.module('@capacitor/camera', { namedExports: {
  CameraErrorCode: { TakePhotoCancelled: 'cancel-camera', ChooseMediaCancelled: 'cancel-gallery', CameraPermissionDenied: 'denied-camera', GalleryPermissionDenied: 'denied-gallery' },
  MediaTypeSelection: { Photo: 0 },
  Camera: {
    takePhoto: async options => {
      assert.equal(options.saveToGallery, false)
      if (cameraError) throw cameraError
      return cameraResult
    },
    chooseFromGallery: async options => {
      galleryOptions = options
      if (cameraError) throw cameraError
      return { results: [cameraResult] }
    },
  },
} })
const { preparePhotoCache, selectItemPhoto, deleteTemporaryPhoto, saveItemPhoto, discardCameraResult } = await import('../src/modules/itemPhotos.js')

function nativePhoto(name = 'camera.jpg') {
  files.set(`CACHE/${name}`, 'photo bytes')
  cameraResult = { uri: `/cache/${name}`, metadata: { format: 'jpg' } }
  cameraError = undefined
}

test('startup removes abandoned drafts, and camera capture stages a preview and removes the plugin copy', async () => {
  await preparePhotoCache()
  assert.equal(files.has('CACHE/item-photo-drafts/abandoned.jpg'), false)
  nativePhoto()
  const photo = await selectItemPhoto('camera')
  assert.ok(photo.webPath.startsWith('web:file:///cache/item-photo-drafts/'))
  assert.equal(files.has('CACHE/camera.jpg'), false)
  assert.equal(files.get(`CACHE/${photo.path}`), 'photo bytes')
  await deleteTemporaryPhoto(photo)
  assert.equal(files.has(`CACHE/${photo.path}`), false)
})

test('gallery selection requests one photo and never deletes the gallery original', async () => {
  cameraResult = { uri: 'file:///gallery/original.png', metadata: { format: 'png' } }
  files.set(cameraResult.uri, 'original')
  const photo = await selectItemPhoto('gallery')
  assert.equal(galleryOptions.mediaType, 0)
  assert.equal(galleryOptions.allowMultipleSelection, false)
  assert.equal(files.get(cameraResult.uri), 'original')
  assert.ok(photo.path.endsWith('.png'))
  await deleteTemporaryPhoto(photo)
})

test('cancellation is quiet and permission denial provides an actionable error', async () => {
  for (const code of ['cancel-camera', 'cancel-gallery']) {
    cameraError = { code }
    assert.equal(await selectItemPhoto(code === 'cancel-camera' ? 'camera' : 'gallery'), null)
  }
  cameraError = { code: 'denied-camera' }
  await assert.rejects(selectItemPhoto('camera'), /Allow access in the app settings/)
  cameraError = undefined
})

test('adding copies the photo before storing its path and then deletes the temporary file', async () => {
  nativePhoto()
  const photo = await selectItemPhoto('camera')
  const path = await saveItemPhoto(photo, async path => {
    assert.equal(files.get(`DATA/${path}`), 'photo bytes')
    assert.equal(files.has(`CACHE/${photo.path}`), true)
  })
  assert.equal(files.has(`CACHE/${photo.path}`), false)
  assert.equal(files.get(`DATA/${path}`), 'photo bytes')
})

test('a database failure removes the permanent copy but keeps the draft for retry', async () => {
  nativePhoto()
  const photo = await selectItemPhoto('camera')
  const path = `item-photos/${photo.path.split('/').at(-1)}`
  await assert.rejects(saveItemPhoto(photo, async () => { throw new Error('Database failed') }), /Database failed/)
  assert.equal(files.has(`DATA/${path}`), false)
  assert.equal(files.has(`CACHE/${photo.path}`), true)
  await saveItemPhoto(photo, async () => {})
  assert.equal(files.has(`DATA/${path}`), true)
  assert.equal(files.has(`CACHE/${photo.path}`), false)
})

test('copy failure cannot insert an item, and a missing photo is rejected', async () => {
  nativePhoto()
  const photo = await selectItemPhoto('camera')
  failCopy = true
  try {
    await assert.rejects(saveItemPhoto(photo, () => assert.fail('Should not insert')), /Storage full/)
    assert.equal(files.has(`CACHE/${photo.path}`), true)
  } finally {
    failCopy = false
    await deleteTemporaryPhoto(photo)
  }
  await assert.rejects(saveItemPhoto(null, () => assert.fail('Should not insert')), /Photo required/)
})

test('restored camera results are discarded without touching unrelated gallery files', async () => {
  nativePhoto('restored.jpg')
  await discardCameraResult({ results: [cameraResult, { uri: 'file:///gallery/original.png' }] })
  assert.equal(files.has('CACHE/restored.jpg'), false)
  assert.equal(files.get('file:///gallery/original.png'), 'original')
})
