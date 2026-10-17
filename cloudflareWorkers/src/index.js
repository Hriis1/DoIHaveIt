export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/catalogs/food-drinks-full') {
      return new Response('Not found', { status: 404 })
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      })
    }

    // Expose only this catalog from the private R2 bucket
    const key = 'data/drinsAndFoodData.jsonl.gz'
    const object = request.method === 'HEAD'
      ? await env.CATALOGS.head(key)
      : await env.CATALOGS.get(key)
    if (!object) return new Response('Catalog not found', { status: 404 })

    // Stream the gzip archive unchanged, without buffering or decompressing it
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': 'attachment; filename="drinsAndFoodData.jsonl.gz"',
        'Content-Length': String(object.size),
        'Cache-Control': 'no-transform',
        'ETag': object.httpEtag,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
}
