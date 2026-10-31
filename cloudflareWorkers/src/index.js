import { respond } from './http.js'
import { handleCatalogDownload } from './routes/catalogs.js'

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/catalogs\/([^/]+)$/)
    if (match) return handleCatalogDownload(request, env, match[1])
    return respond('Not found', { status: 404 })
  },
}
