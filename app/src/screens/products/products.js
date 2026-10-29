import './products.css'
import html from './products.html?raw'
import { getProducts } from '../../repositories/productRepo.js'

const pageSize = 12

export function mountProductsScreen(container, { isNative, databaseReady }) {
  container.innerHTML = html
  const screen = container.querySelector('.products-screen')
  const events = new AbortController()
  const listen = (element, event, handler) => element.addEventListener(event, handler, { signal: events.signal })
  const search = screen.querySelector('#product-search')
  const help = screen.querySelector('#product-search-help')
  const list = screen.querySelector('.products-list')
  const template = screen.querySelector('.product-template')
  const message = screen.querySelector('.products-message')
  const error = screen.querySelector('.products-error')
  const empty = screen.querySelector('.products-empty')
  const footer = screen.querySelector('.products-footer')
  const previous = screen.querySelector('.products-previous')
  const next = screen.querySelector('.products-next')
  let active = true
  let request = 0
  let page = 1
  let mode = 'text'
  let searchTimer

  async function loadProducts() {
    const currentRequest = ++request
    const query = search.value.trim()
    const searchMode = mode
    list.setAttribute('aria-busy', 'true')
    previous.disabled = true
    next.disabled = true
    message.textContent = 'Loading products…'
    message.hidden = false
    error.hidden = true
    empty.hidden = true

    try {
      await databaseReady
      if (!active || currentRequest !== request) return
      const result = await getProducts({ search: query, mode: searchMode, page, pageSize })
      if (!active || currentRequest !== request) return
      page = result.page
      const rows = result.products.map(product => {
        const row = template.content.cloneNode(true)
        row.querySelector('.product-brand').textContent = product.brand
        row.querySelector('.product-name').textContent = product.name
        row.querySelector('.product-size').textContent = product.size ?? 'Size not specified'
        const barcodes = row.querySelector('.product-barcodes')
        if (!product.barcodes.length) barcodes.textContent = 'No barcodes'
        for (const barcode of product.barcodes) {
          const code = document.createElement('span')
          code.textContent = barcode
          barcodes.append(code)
        }
        return row
      })
      list.replaceChildren(...rows)
      empty.hidden = result.total > 0
      empty.querySelector('h2').textContent = query ? 'No matching products' : 'No products yet'
      empty.querySelector('p').textContent = query
        ? (searchMode === 'barcode' ? 'Enter a complete linked barcode.' : 'Try another brand, name or size.')
        : 'Products from catalogs will appear here.'
      screen.querySelector('.products-page').textContent = `${page} / ${result.totalPages}`
      screen.querySelector('.products-range').textContent = result.total
        ? `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, result.total)} of ${result.total} products`
        : '0 products'
      footer.hidden = false
      previous.disabled = page === 1
      next.disabled = page === result.totalPages
    } catch (loadError) {
      if (!active || currentRequest !== request) return
      console.error('Could not load products:', loadError)
      list.replaceChildren()
      footer.hidden = true
      error.textContent = 'Could not load products. Change the search or reopen Products to try again.'
      error.hidden = false
    } finally {
      if (active && currentRequest === request) {
        list.setAttribute('aria-busy', 'false')
        message.hidden = true
      }
    }
  }

  // Invalidate older requests immediately and wait briefly for typing to pause
  listen(search, 'input', () => {
    page = 1
    request++
    clearTimeout(searchTimer)
    previous.disabled = true
    next.disabled = true
    if (isNative) searchTimer = setTimeout(loadProducts, 250)
  })
  for (const radio of screen.querySelectorAll('[name="product-search-mode"]')) {
    listen(radio, 'change', () => {
      mode = radio.value
      page = 1
      clearTimeout(searchTimer)
      search.placeholder = mode === 'barcode' ? 'Enter the exact barcode' : 'Search brand, name or size'
      search.inputMode = mode === 'barcode' ? 'numeric' : 'search'
      help.textContent = mode === 'barcode' ? 'Matches a complete barcode exactly, including leading zeros.' : 'Match words or word beginnings in the brand, name or size, in any order.'
      if (isNative) void loadProducts()
    })
  }
  listen(previous, 'click', () => { page--; void loadProducts() })
  listen(next, 'click', () => { page++; void loadProducts() })

  if (isNative) void loadProducts()
  else {
    message.textContent = 'Open the app on your phone or emulator to browse saved products.'
    list.setAttribute('aria-busy', 'false')
  }

  return () => {
    active = false
    request++
    clearTimeout(searchTimer)
    events.abort()
    screen.remove()
  }
}
