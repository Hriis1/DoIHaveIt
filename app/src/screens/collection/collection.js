import './collection.css'
import html from './collection.html?raw'
import { createPopup } from '../../modules/popup.js'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { getCollectionItems, addCollectionItem, removeCollectionItem } from '../../repositories/itemRepo.js'
import { getProductByBarcode, getProductBrands, getProductNames, getProductSizes, isProductInCollection, resolveProduct, resolveAiProduct } from '../../repositories/productRepo.js'
import { createScanner } from '../../modules/scan/scan.js'
import { selectItemPhoto, deleteTemporaryPhoto, saveItemPhoto, deleteSavedItemPhoto } from '../../modules/itemPhotos.js'
import { lookupProductWithAi } from '../../modules/aiProductLookup.js'

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
  const scanResultError = screen.querySelector('.scan-result-error')
  const buyCredits = screen.querySelector('.scan-result-buy-credits')
  const scanResultProduct = screen.querySelector('.scan-result-product')
  const scanProductBrand = screen.querySelector('.scan-product-brand')
  const scanProductName = screen.querySelector('.scan-product-name')
  const scanProductSize = screen.querySelector('.scan-product-size')
  const scanProductSizeRow = screen.querySelector('.scan-product-size-row')
  const scanResultAdd = screen.querySelector('.scan-result-add')
  const scanResultDismiss = screen.querySelector('.scan-result-dismiss')
  const scanResultAiSearch = screen.querySelector('.scan-result-ai-search')
  const scanResultActions = screen.querySelector('.scan-result-actions')
  const scanResultManual = screen.querySelector('.scan-result-manual')
  const brandInput = screen.querySelector('#scan-brand-input')
  const nameInput = screen.querySelector('#scan-name-input')
  const sizeInput = screen.querySelector('#scan-size-input')
  const brandOptions = screen.querySelector('#scan-brand-options')
  const nameOptions = screen.querySelector('#scan-name-options')
  const sizeOptions = screen.querySelector('#scan-size-options')
  const manualSelects = [
    { input: brandInput, list: brandOptions, toggle: screen.querySelector('#scan-brand-toggle'), field: screen.querySelector('.scan-brand-select'),
      getOptions: brand => getProductBrands(brand, 50) },
    { input: nameInput, list: nameOptions, toggle: screen.querySelector('#scan-name-toggle'), field: screen.querySelector('.scan-name-select'),
      getOptions: (brand, name) => brand ? getProductNames(brand, name, 50) : [] },
    { input: sizeInput, list: sizeOptions, toggle: screen.querySelector('#scan-size-toggle'), field: screen.querySelector('.scan-size-select'),
      getOptions: (brand, name, size) => brand && name ? getProductSizes(brand, name, size, 50) : [] },
  ]
  let openSelect
  let optionRequest = 0
  const brandError = screen.querySelector('.scan-brand-error')
  const nameError = screen.querySelector('.scan-name-error')
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
  const itemDialog = screen.querySelector('.item-detail-dialog')
  const itemPicture = screen.querySelector('.item-detail-image')
  const itemPlaceholder = itemPicture.querySelector('.image-placeholder')
  const itemClose = screen.querySelector('.item-detail-close')
  const itemRemove = screen.querySelector('.item-detail-remove')
  const itemError = screen.querySelector('.item-detail-error')
  let selectedItem
  let removing = false
  const itemPopup = createPopup(itemDialog, {
    closeButtons: [itemClose], canClose: () => !removing,
    onClose: () => { selectedItem = undefined; itemPicture.replaceChildren(itemPlaceholder) },
  })
  listen(itemRemove, 'click', () => void removeItem())
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
  const scanResultPopup = createPopup(scanResultDialog, {
    closeButtons: [scanResultClose, scanResultDismiss],
    canClose: () => !draft?.saving,
    onClose: discardDraft,
    onCancel: () => {
      if (!openSelect) return
      const toggle = openSelect.toggle
      closeManualOptions()
      toggle.focus()
      return false
    },
  })
  listen(photoCamera, 'click', () => void choosePhoto('camera'))
  listen(photoGallery, 'click', () => void choosePhoto('gallery'))
  listen(scanResultAdd, 'click', () => void addScannedProduct())
  listen(scanResultAiSearch, 'click', () => void searchWithAi())
  listen(scanResultManual, 'click', enterProductManually)
  for (const select of manualSelects) {
    listen(select.toggle, 'click', () => void toggleManualOptions(select))
    listen(select.input, 'input', closeManualOptions)
    listen(select.input, 'focus', closeManualOptions)
    listen(select.field, 'focusout', event => {
      if (openSelect === select && event.relatedTarget && !select.field.contains(event.relatedTarget)) closeManualOptions()
    })
    listen(select.toggle, 'keydown', event => {
      if (event.key === 'ArrowDown' && openSelect === select) {
        event.preventDefault()
        select.list.querySelector('[role="option"]')?.focus()
      }
    })
    listen(select.list, 'keydown', event => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
      event.preventDefault()
      const options = [...select.list.querySelectorAll('[role="option"]')]
      const index = options.indexOf(event.target)
      options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus()
    })
  }
  listen(scanResultDialog, 'pointerdown', event => {
    if (openSelect && !openSelect.field.contains(event.target)) closeManualOptions()
  })
  listen(scanResultDialog, 'keydown', event => {
    if (event.key !== 'Escape' || !openSelect) return
    event.preventDefault()
    const toggle = openSelect.toggle
    closeManualOptions()
    toggle.focus()
  })
  listen(buyCredits, 'click', event => {
    event.preventDefault()
    navigate('add-credit')
  })

  function discardDraft() {
    closeManualOptions()
    if (!draft) return
    draft.closed = true
    draft.lookupController.abort()
    // A pending save owns its files until its database operation finishes
    if (!draft.saving) void deleteTemporaryPhoto(draft.photo)
    draft = undefined
    scanRequest++
  }

  function closeScanResult() {
    scanResultPopup.close()
  }

  function updatePhotoControls(session) {
    if (!active || draft !== session) return
    photoCamera.disabled = photoGallery.disabled = session.selecting || session.saving
    scanResultAdd.disabled = scanResultClose.disabled = session.saving
    scanResultAdd.textContent = session.saving ? 'Adding…' : 'Add to collection'
    scanResultAiSearch.disabled = scanResultManual.disabled = session.searching
    for (const input of [brandInput, nameInput, sizeInput]) input.disabled = session.saving
    for (const select of manualSelects) select.toggle.disabled = session.saving
    if (session.saving) closeManualOptions()
  }

  function isCurrentDraft(session) {
    return active && draft === session && !session.closed
  }

  function showManualFields(manual) {
    closeManualOptions()
    for (const select of manualSelects) select.field.hidden = !manual
    for (const input of [brandInput, nameInput, sizeInput]) input.hidden = !manual
    for (const value of [scanProductBrand, scanProductName, scanProductSize]) value.hidden = manual
    brandError.hidden = nameError.hidden = true
    brandInput.setAttribute('aria-invalid', 'false')
    nameInput.setAttribute('aria-invalid', 'false')
  }

  function closeManualOptions() {
    optionRequest++
    for (const select of manualSelects) {
      select.list.hidden = true
      select.list.replaceChildren()
      select.toggle.setAttribute('aria-expanded', 'false')
    }
    openSelect = undefined
  }

  function showOptionsStatus(list, message) {
    const status = document.createElement('p')
    status.setAttribute('role', 'status')
    status.textContent = message
    list.replaceChildren(status)
  }

  async function toggleManualOptions(select) {
    const session = draft
    if (!session?.manual || session.saving) return
    const wasOpen = openSelect === select
    closeManualOptions()
    if (wasOpen) return
    openSelect = select
    const request = optionRequest
    const brand = brandInput.value.trim().toLowerCase()
    const name = nameInput.value.trim().toLowerCase()
    const size = sizeInput.value.trim().toLowerCase()
    select.list.hidden = false
    select.toggle.setAttribute('aria-expanded', 'true')
    showOptionsStatus(select.list, 'Loading…')
    const isCurrent = () => isCurrentDraft(session) && session.manual && openSelect === select && optionRequest === request
    try {
      await databaseReady
      if (!isCurrent()) return
      const values = await select.getOptions(brand, name, size)
      if (!isCurrent()) return
      if (!values.length) {
        showOptionsStatus(select.list, 'No saved options')
        return
      }
      const options = document.createDocumentFragment()
      for (const value of values) {
        const option = document.createElement('button')
        option.type = 'button'
        option.value = value
        option.textContent = value
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(select.input.value.trim().toLowerCase() === value))
        option.addEventListener('click', () => {
          select.input.value = value
          closeManualOptions()
          select.toggle.focus()
        }, { signal: events.signal })
        options.appendChild(option)
      }
      select.list.replaceChildren(options)
    } catch (error) {
      if (!isCurrent()) return
      console.error('Could not load product options:', error)
      showOptionsStatus(select.list, 'Could not load options. You can still type a value.')
    }
  }

  function enterProductManually() {
    const session = draft
    if (!session || !isCurrentDraft(session) || session.product || session.searching || session.saving) return
    session.manual = true
    brandInput.value = nameInput.value = sizeInput.value = ''
    showManualFields(true)
    scanResultTitle.textContent = 'Add product manually'
    scanResultActions.hidden = scanResultManual.hidden = scanResultAiSearch.hidden = true
    scanResultError.hidden = buyCredits.hidden = true
    scanResultProduct.hidden = scanResultAdd.hidden = scanProductSizeRow.hidden = false
  }

  async function renderProductResult(session, product) {
    const inCollection = product ? await isProductInCollection(product.id, collection.id) : false
    if (!isCurrentDraft(session)) return
    session.inCollection = inCollection
    showManualFields(false)
    scanResultTitle.textContent = inCollection
      ? `${product.name} already in collection`
      : product ? 'Product found in catalog' : 'Unrecognized product'
    scanResultDismiss.hidden = !inCollection
    scanResultAiSearch.hidden = Boolean(product)
    scanResultManual.hidden = scanResultActions.hidden = Boolean(product)
    scanResultProduct.hidden = scanResultAdd.hidden = !product || inCollection
    if (product && !inCollection) {
      session.product = product
      scanProductBrand.textContent = product.brand
      scanProductName.textContent = product.name
      scanProductSize.textContent = product.size ?? ''
      scanProductSizeRow.hidden = product.size === null
    }
    return inCollection
  }

  async function searchWithAi() {
    const session = draft
    if (!session || session.closed || session.product || session.manual || session.searching || session.saving) return
    session.searching = true
    updatePhotoControls(session)
    scanResultError.hidden = true
    buyCredits.hidden = true
    scanResultTitle.textContent = 'Searching for product…'
    try {
      const product = await lookupProductWithAi(session.barcode, { signal: session.lookupController.signal })
      await databaseReady
      if (!isCurrentDraft(session)) return
      const resolved = await resolveAiProduct(session.barcode, product, { signal: session.lookupController.signal })
      if (!isCurrentDraft(session)) return
      await renderProductResult(session, resolved)
    } catch (error) {
      if (!isCurrentDraft(session)) return
      scanResultTitle.textContent = 'Unrecognized product'
      scanResultError.textContent = error.message || 'Could not search for the product. Please try again.'
      scanResultError.hidden = false
      buyCredits.hidden = error.code !== 'INSUFFICIENT_CREDITS'
    } finally {
      session.searching = false
      updatePhotoControls(session)
    }
  }

  function showPhotoError(message) {
    photoError.textContent = message
    photoError.hidden = !message
  }

  async function choosePhoto(source) {
    const session = draft
    if (!session || (!session.product && !session.manual) || session.selecting || session.saving) return
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
    if (!session || (!session.product && !session.manual) || session.saving || session.inCollection) return
    let manualProduct
    if (session.manual) {
      manualProduct = { brand: brandInput.value.trim().toLowerCase(), name: nameInput.value.trim().toLowerCase(),
        size: sizeInput.value.trim().toLowerCase() || null }
      brandError.textContent = 'Brand required'
      nameError.textContent = 'Name required'
      brandError.hidden = Boolean(manualProduct.brand)
      nameError.hidden = Boolean(manualProduct.name)
      brandInput.setAttribute('aria-invalid', String(!manualProduct.brand))
      nameInput.setAttribute('aria-invalid', String(!manualProduct.name))
    }
    if (!session.photo || session.selecting) {
      showPhotoError('Photo required')
      return
    }
    if (manualProduct && (!manualProduct.brand || !manualProduct.name)) return
    session.saving = true
    updatePhotoControls(session)
    showPhotoError('')
    try {
      if (manualProduct) {
        await databaseReady
        if (!isCurrentDraft(session)) return
        const product = await resolveProduct(session.barcode, manualProduct, { signal: session.lookupController.signal })
        if (!isCurrentDraft(session)) return
        session.product = product
        session.manual = false
        const inCollection = await renderProductResult(session, product)
        if (!isCurrentDraft(session)) return
        if (inCollection) {
          await deleteTemporaryPhoto(session.photo)
          session.photo = undefined
          return
        }
      }
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
    const session = {
      barcode, product: null, photo: null, selecting: false, saving: false, searching: false, closed: false,
      lookupController: new AbortController(),
    }
    draft = session
    const currentScan = ++scanRequest
    photoPreview.replaceChildren()
    photoPreview.setAttribute('aria-label', 'No photo selected')
    showPhotoError('')
    scanResultError.hidden = true
    buyCredits.hidden = true
    updatePhotoControls(session)
    scanResultProduct.hidden = true
    scanResultAdd.hidden = true
    scanResultDismiss.hidden = true
    scanResultAiSearch.hidden = true
    scanResultManual.hidden = scanResultActions.hidden = true
    showManualFields(false)
    scanResultTitle.textContent = 'Looking up product…'
    scanResultBarcode.textContent = `Barcode: ${barcode}`
    scanResultPopup.open()
    try {
      await databaseReady
      if (!active || currentScan !== scanRequest) return
      const product = await getProductByBarcode(barcode)
      if (!active || currentScan !== scanRequest) return
      await renderProductResult(session, product)
    } catch (lookupError) {
      if (!active || currentScan !== scanRequest) return
      console.error('Could not look up scanned product:', lookupError)
      scanResultTitle.textContent = 'Could not look up product. Please try again.'
    }
  }

  async function showImage(item, picture, placeholder, currentRequest, isCurrent = () => true) {
    try {
      let source = item.product_image
      // User photos are paths relative to the app's persistent data directory
      if (item.item_image !== null) {
        const { uri } = await Filesystem.getUri({ directory: Directory.Data, path: item.item_image })
        source = Capacitor.convertFileSrc(uri)
      }
      if (!active || currentRequest !== request || !isCurrent() || !source) return

      const image = document.createElement('img')
      image.alt = ''
      image.decoding = 'async'
      listen(image, 'load', () => { if (isCurrent()) placeholder.hidden = true })
      listen(image, 'error', () => {
        image.remove()
        if (isCurrent()) placeholder.hidden = false
      })
      picture.append(image)
      image.src = source
    } catch (imageError) {
      // Keep the placeholder when a stored photo cannot be resolved
      console.error('Could not load item image:', imageError)
    }
  }

  function showItem(item) {
    selectedItem = item
    itemPicture.replaceChildren(itemPlaceholder)
    itemPlaceholder.hidden = false
    itemError.hidden = true
    screen.querySelector('.item-detail-brand').textContent = item.brand
    screen.querySelector('.item-detail-name').textContent = item.name
    screen.querySelector('.item-detail-size').textContent = item.size ?? ''
    screen.querySelector('.item-detail-size-row').hidden = item.size === null
    itemPopup.open()
    void showImage(item, itemPicture, itemPlaceholder, request, () => selectedItem === item && itemDialog.open)
  }

  async function removeItem() {
    if (!selectedItem || removing || !active) return
    const item = selectedItem
    removing = true
    itemRemove.disabled = itemClose.disabled = true
    itemRemove.textContent = 'Removing…'
    itemError.hidden = true
    try {
      const photo = await removeCollectionItem(collection.id, item.id)
      // Delete the permanent copy only after the collection entry is removed.
      let photoError = false
      try { await deleteSavedItemPhoto(photo) } catch (failure) {
        console.error('Could not delete removed item photo:', failure)
        photoError = true
      }
      if (!active) return
      removing = false
      itemPopup.close()
      if (collectionTotal !== undefined) collectionTotal = Math.max(0, collectionTotal - 1)
      await loadItems()
      if (active && photoError) {
        error.textContent = 'Item removed, but its saved photo could not be deleted.'
        error.hidden = false
      }
    } catch (failure) {
      if (!active) return
      console.error('Could not remove collection item:', failure)
      itemError.textContent = 'Could not remove this item. Please try again.'
      itemError.hidden = false
    } finally {
      removing = false
      if (active) {
        itemRemove.disabled = itemClose.disabled = false
        itemRemove.textContent = 'Remove from collection'
      }
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
        const open = card.querySelector('.item-open')
        open.setAttribute('aria-label', `View ${label}`)
        listen(open, 'click', () => showItem(item))
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
    scanResultPopup.destroy()
    itemPopup.destroy()
    screen.remove()
  }
}
