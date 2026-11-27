import { respond } from './http.js'
import { handleCatalogDownload } from './routes/catalogs.js'
import { handleProductLookup } from './routes/productLookup.js'
import { handleAuth } from './routes/auth.js'
import { handleRevenueCat, handlePurchaseStatus } from './routes/purchases.js'

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Purchase notifications and authenticated confirmation
    if (url.pathname === '/webhooks/revenuecat') return handleRevenueCat(request, env)
    if (url.pathname === '/purchases/status') return handlePurchaseStatus(request, env)

    //Auth routes
    const auth = url.pathname.match(/^\/auth\/(register|login|me|logout|delete)$/)
    if (auth) return handleAuth(request, env, auth[1])

    //Product look up route
    if (url.pathname === '/products/lookup') return handleProductLookup(request, env, ctx)

    //Catalog download route
    const match = url.pathname.match(/^\/catalogs\/([^/]+)$/)
    if (match) return handleCatalogDownload(request, env, match[1])

    return respond('Not found', { status: 404 })
  },
}
