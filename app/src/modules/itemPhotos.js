import { Capacitor } from '@capacitor/core'
import { Camera, CameraErrorCode, MediaTypeSelection } from '@capacitor/camera'
import { Filesystem, Directory } from '@capacitor/filesystem'

const temporaryFolder = 'item-photo-drafts'
const savedFolder = 'item-photos'
const temporaryOptions = path => ({ path, directory: Directory.Cache })
let cacheReady

async function ensureDirectory(path, directory) {
  try {
    await Filesystem.mkdir({ path, directory, recursive: true })
  } catch (error) {
    const entry = await Filesystem.stat({ path, directory })
    if (entry.type !== 'directory') throw error
  }
}

export function preparePhotoCache() {
  if (!cacheReady) {
    cacheReady = (async () => {
      await ensureDirectory(temporaryFolder, Directory.Cache)
      const { files } = await Filesystem.readdir(temporaryOptions(temporaryFolder))
      // Discard drafts left behind if the operating system terminated the app
      for (const file of files) {
        if (file.type === 'file') await Filesystem.deleteFile(temporaryOptions(`${temporaryFolder}/${file.name}`))
      }
    })().catch(error => {
      cacheReady = undefined
      throw error
    })
  }
  return cacheReady
}

export async function deleteTemporaryPhoto(photo) {
  if (!photo) return
  try {
    await Filesystem.deleteFile(temporaryOptions(photo.path))
  } catch (error) {
    // Startup cleanup retries abandoned drafts if deletion temporarily fails
    console.warn('Could not remove the temporary item photo:', error)
  }
}

export async function discardCameraResult(result) {
  const { uri: cacheUri } = await Filesystem.getUri(temporaryOptions(''))
  const cacheRoot = decodeURI(cacheUri).replace(/\/$/, '') + '/'
  for (const photo of result?.results ?? [result]) {
    if (!photo?.uri) continue
    const uri = photo.uri.startsWith('/') ? `file://${photo.uri}` : photo.uri
    // Never delete a user's gallery original or a file outside app cache
    if (!decodeURI(uri).startsWith(cacheRoot)) continue
    try {
      await Filesystem.deleteFile({ path: uri })
    } catch (error) {
      console.warn('Could not remove the camera cache photo:', error)
    }
  }
}

export async function selectItemPhoto(source) {
  if (!Capacitor.isNativePlatform()) throw new Error('Open the app on your phone to choose a photo.')
  await preparePhotoCache()
  let result
  try {
    result = source === 'camera'
      ? await Camera.takePhoto({ saveToGallery: false, includeMetadata: true })
      : await Camera.chooseFromGallery({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: false, includeMetadata: true })
  } catch (error) {
    if ([CameraErrorCode.TakePhotoCancelled, CameraErrorCode.ChooseMediaCancelled].includes(error.code)) return null
    if ([CameraErrorCode.CameraPermissionDenied, CameraErrorCode.GalleryPermissionDenied].includes(error.code)) {
      throw new Error('Photo access was denied. Allow access in the app settings and try again.')
    }
    throw new Error('Could not open the camera or gallery. Please try again.')
  }

  const photo = result.results?.[0] ?? result
  const extension = photo.metadata?.format?.toLowerCase() ?? 'jpg'
  const path = `${temporaryFolder}/${crypto.randomUUID()}.${/^[a-z0-9]{1,8}$/.test(extension) ? extension : 'jpg'}`
  try {
    if (!photo.uri) throw new Error('No photo was returned.')
    const from = photo.uri.startsWith('/') ? `file://${photo.uri}` : photo.uri
    await Filesystem.copy({ from, to: path, toDirectory: Directory.Cache })
    const { uri } = await Filesystem.getUri(temporaryOptions(path))
    return { path, webPath: Capacitor.convertFileSrc(uri) }
  } catch (error) {
    await deleteTemporaryPhoto({ path })
    throw new Error('Could not prepare the photo. Please try again.')
  } finally {
    await discardCameraResult(result).catch(error => console.warn('Could not clean camera cache:', error))
  }
}

export async function saveItemPhoto(photo, addItem) {
  if (!photo) throw new Error('Photo required')
  const path = `${savedFolder}/${photo.path.split('/').at(-1)}`
  try {
    await ensureDirectory(savedFolder, Directory.Data)
    await Filesystem.copy({ from: photo.path, directory: Directory.Cache, to: path, toDirectory: Directory.Data })
    // Persist the item only after its permanent photo is available
    await addItem(path)
  } catch (error) {
    try {
      await Filesystem.deleteFile({ path, directory: Directory.Data })
    } catch (cleanupError) {
      console.warn('Could not remove an unsaved item photo:', cleanupError)
    }
    throw error
  }
  await deleteTemporaryPhoto(photo)
  return path
}
