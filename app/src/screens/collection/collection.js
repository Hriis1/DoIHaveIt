import './collection.css'
import html from './collection.html?raw'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { getCollectionItems, addCollectionItem } from '../../repositories/itemRepo.js'
import { getProductByBarcode, isProductInCollection } from '../../repositories/productRepo.js'
import { createScanner } from '../../modules/scan/scan.js'
import { selectItemPhoto, deleteTemporaryPhoto, saveItemPhoto } from '../../modules/itemPhotos.js'

const pageSize = 12

export function mountCollectionScreen(container, { collection, isNative, databaseReady, navigate }) {
  container.innerHTML = html
  const screen = container.querySelector('.collection-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const title = screen.querySelector('#collection-title')
  const count = screen.querySelector('.gallery-count')
  const search = screen.querySelector('#item-search')
  const grid = screen.querySelector('.item-gallery')
  const template = screen.querySelector('.item-template')
  const message = screen.querySelector('.gallery-message')
  const error = screen.querySelector('.gallery-error')
  const empty = screen.querySelector('.gallery-empty')
  const previous = screen.querySelector('.gallery-previous')
  const next = screen.querySelector('.gallery-next')
  const pageLabel = screen.querySelector('.gallery-page')
  const range = screen.querySelector('.gallery-range')
  const scanResultDialog = screen.querySelector('.scan-result-dialog')
  const scanResultTitle = screen.querySelector('#scan-result-title')
  const scanResultBarcode = screen.querySelector('#scan-result-barcode')
  const scanResultProduct = screen.querySelector('.scan-result-product')
  const scanProductBrand = screen.querySelector('.scan-product-brand')
  const scanProductName = screen.querySelector('.scan-product-name')
  const scanProductSize = screen.querySelector('.scan-product-size')
  const scanProductSizeRow = screen.querySelector('.scan-product-size-row')
  const scanResultAdd = screen.querySelector('.scan-result-add')
  const scanResultDismiss = screen.querySelector('.scan-result-dismiss')
  const scanResultAiSearch = screen.querySelector('.scan-result-ai-search')
  const scanResultClose = screen.querySelector('.scan-result-close')
  const photoPreview = screen.querySelector('.scan-photo-preview')
  const photoCamera = screen.querySelector('.scan-photo-camera')
  const photoGallery = screen.querySelector('.scan-photo-gallery')
  const photoError = screen.querySelector('.scan-photo-error')
  let draft
  let active = true
  let request = 0
  let scanRequest = 0
  let page = 1
  let collectionTotal
  const scanner = createScanner({
    onScan: value => {
      if (!active) return
      void showScanResult(value)
    },
    onError: message => {
      if (!active) return
      error.textContent = message
      error.hidden = false
    },
  })

  title.textContent = collection.name
  listen(screen.querySelector('.collection-back'), 'click', () => navigate('collections'))
  listen(scanResultClose, 'click', closeScanResult)
  listen(scanResultDismiss, 'click', closeScanResult)
  listen(scanResultDialog, 'cancel', event => {
    event.preventDefault()
    closeScanResult()
  })
  listen(scanResultDialog, 'close', () => {
    if (!scanResultDialog.open) discardDraft()
  })
  listen(photoCamera, 'click', () => void choosePhoto('camera'))
  listen(photoGallery, 'click', () => void choosePhoto('gallery'))
  listen(scanResultAdd, 'click', () => void addScannedProduct())

  function discardDraft() {
    if (!draft) return
    draft.closed = true
    // A pending save owns its files until its database operation finishes
    if (!draft.saving) void deleteTemporaryPhoto(draft.photo)
    draft = undefined
    scanRequest++
  }

  function closeScanResult() {
    if (draft?.saving) return
    discardDraft()
    scanResultDialog.close()
  }

  function updatePhotoControls(session) {
    if (!active || draft !== session) return
    photoCamera.disabled = photoGallery.disabled = session.selecting || session.saving
    scanResultAdd.disabled = scanResultClose.disabled = session.saving
    scanResultAdd.textContent = session.saving ? 'Adding…' : 'Add to collection'
  }

  function showPhotoError(message) {
    photoError.textContent = message
    photoError.hidden = !message
  }

  async function choosePhoto(source) {
    const session = draft
    if (!session?.product || session.selecting || session.saving) return
    session.selecting = true
    updatePhotoControls(session)
    showPhotoError('')
    try {
      const photo = await selectItemPhoto(source)
      if (!photo) return
      if (!active || session.closed || draft !== session) {
        await deleteTemporaryPhoto(photo)
        return
      }
      const previousPhoto = session.photo
      session.photo = photo
      const image = document.createElement('img')
      image.alt = ''
      image.src = photo.webPath
      photoPreview.replaceChildren(image)
      photoPreview.setAttribute('aria-label', 'Selected product photo')
      showPhotoError('')
      await deleteTemporaryPhoto(previousPhoto)
    } catch (error) {
      if (active && draft === session && !session.closed) showPhotoError(error.message)
    } finally {
      session.selecting = false
      updatePhotoControls(session)
    }
  }

  async function addScannedProduct() {
    const session = draft
    if (!session?.product || session.saving) return
    if (!session.photo || session.selecting) {
      showPhotoError('Photo required')
      return
    }
    session.saving = true
    updatePhotoControls(session)
    showPhotoError('')
    try {
      await saveItemPhoto(session.photo, path => addCollectionItem(collection.id, session.product.id, path))
      session.photo = undefined
      if (!active || draft !== session) return
      session.saving = false
      closeScanResult()
      search.value = ''
      page = 1
      collectionTotal = undefined
      await loadItems()
    } catch (error) {
      console.error('Could not add scanned product:', error)
      if (active && draft === session) showPhotoError(error.message || 'Could not add the product. Please try again.')
    } finally {
      session.saving = false
      if (session.closed) await deleteTemporaryPhoto(session.photo)
      updatePhotoControls(session)
    }
  }

  async function showScanResult(barcode) {
    if (draft?.saving) return
    discardDraft()
    const session = { product: null, photo: null, selecting: false, saving: false, closed: false }
    draft = session
    const currentScan = ++scanRequest
    photoPreview.replaceChildren()
    photoPreview.setAttribute('aria-label', 'No photo selected')
    showPhotoError('')
    updatePhotoControls(session)
    scanResultProduct.hidden = true
    scanResultAdd.hidden = true
    scanResultDismiss.hidden = true
    scanResultAiSearch.hidden = true
    scanResultTitle.textContent = 'Looking up product…'
    scanResultBarcode.textContent = `Barcode: ${barcode}`
    scanResultDialog.showModal()
    try {
      await databaseReady
      if (!active || currentScan !== scanRequest) return
      const product = await getProductByBarcode(barcode)
      if (!active || currentScan !== scanRequest) return
      const inCollection = product ? await isProductInCollection(product.id, collection.id) : false
      if (!active || currentScan !== scanRequest) return
      scanResultTitle.textContent = inCollection
        ? `${product.name} already in collection`
        : product ? 'Product found in catalog' : 'Unrecognized product'
      scanResultDismiss.hidden = !inCollection
      scanResultAiSearch.hidden = Boolean(product)
      if (product && !inCollection) {
        session.product = product
        scanProductBrand.textContent = product.brand
        scanProductName.textContent = product.name
        scanProductSize.textContent = product.size ?? ''
        scanProductSizeRow.hidden = product.size === null
        scanResultProduct.hidden = false
        scanResultAdd.hidden = false
      }
    } catch (lookupError) {
      if (!active || currentScan !== scanRequest) return
      console.error('Could not look up scanned product:', lookupError)
      scanResultTitle.textContent = 'Could not look up product. Please try again.'
    }
  }

  async function showImage(item, picture, placeholder, currentRequest) {
    try {
      let source = item.product_image
      // User photos are paths relative to the app's persistent data directory
      if (item.item_image !== null) {
        const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: item.item_image })
        source = Capacitor.convertFileSrc(uri)
      }
      if (!active || currentRequest !== request || !source) return

      const image = document.createElement('img')
      image.alt = ''
      image.decoding = 'async'
      listen(image, 'load', () => { placeholder.hidden = true })
      listen(image, 'error', () => {
        image.remove()
        placeholder.hidden = false
      })
      picture.append(image)
      image.src = source
    } catch (imageError) {
      // Keep the placeholder when a stored photo cannot be resolved
      console.error('Could not load item image:', imageError)
    }
  }

  async function loadItems() {
    const currentRequest = ++request
    const query = search.value.trim()
    grid.setAttribute('aria-busy', 'true')
    previous.disabled = true
    next.disabled = true
    error.hidden = true

    try {
      await databaseReady
      if (!active) return
      const result = await getCollectionItems(collection.id, { search: query, page, pageSize })
      if (!active || currentRequest !== request) return

      page = result.page
      if (!query) collectionTotal = result.total
      const total = collectionTotal ?? result.total
      count.textContent = `${total} ${total === 1 ? 'item' : 'items'}`
      const cards = result.items.map(item => {
        const card = template.content.cloneNode(true)
        const label = `${item.brand}: ${item.name}${item.size === null ? '' : `(${item.size})`}`
        const figure = card.querySelector('figure')
        figure.setAttribute('aria-label', label)
        const caption = card.querySelector('.item-label')
        caption.textContent = label
        caption.title = label
        showImage(item, card.querySelector('.item-image'), card.querySelector('.image-placeholder'), currentRequest)
        return card
      })
      grid.replaceChildren(...cards)
      message.hidden = true
      empty.hidden = result.total > 0
      empty.querySelector('h2').textContent = query ? 'No matching items' : 'Your collection is empty'
      empty.querySelector('p').textContent = query ? 'Try another brand or product name.' : 'Items you add will appear here.'
      pageLabel.textContent = `${page} / ${result.totalPages}`
      range.textContent = result.total
        ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, result.total)} of ${result.total} items`
        : '0 items'
      previous.disabled = page === 1
      next.disabled = page === result.totalPages
    } catch (loadError) {
      if (!active || currentRequest !== request) return
      console.error('Could not load collection items:', loadError)
      grid.replaceChildren()
      empty.hidden = true
      message.hidden = true
      pageLabel.textContent = ''
      range.textContent = ''
      error.textContent = 'Could not load these items. Go back to Collections and try again.'
      error.hidden = false
    } finally {
      if (active && currentRequest === request) grid.setAttribute('aria-busy', 'false')
    }
  }

  listen(search, 'input', () => { page = 1; loadItems() })
  listen(screen.querySelector('.gallery-scan'), 'click', () => {
    error.hidden = true
    scanner.open()
  })
  listen(previous, 'click', () => { page--; loadItems() })
  listen(next, 'click', () => { page++; loadItems() })

  if (isNative) {
    loadItems()
  } else {
    message.textContent = 'Open the app on your phone or emulator to use your saved items.'
    grid.setAttribute('aria-busy', 'false')
  }

  return () => {
    active = false
    discardDraft()
    events.abort()
    void scanner.destroy()
    scanResultDialog.close()
    screen.remove()
  }
}
