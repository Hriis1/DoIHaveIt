export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const match = url.pathname.match(/^\/catalogs\/([^/]+)$/)
    if (!match) {
      return new Response('Not found', { status: 404 })
    }
    let name
    try {
      name = decodeURIComponent(match[1])
    } catch {
      return new Response('Invalid catalog name', { status: 400 })
    }
    if (!/^[A-Za-z0-9]+$/.test(name)) {
      return new Response('Invalid catalog name', { status: 400 })
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      })
    }

    // Resolve catalog names to gzip archives directly inside data/
    const filename = `${name}.jsonl.gz`
    const key = `data/${filename}`
    const object = request.method === 'HEAD'
      ? await env.CATALOGS.head(key)
      : await env.CATALOGS.get(key)
    if (!object) return new Response('Catalog not found', { status: 404 })

    // Stream the gzip archive unchanged, without buffering or decompressing it
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(object.size),
        'Cache-Control': 'no-transform',
        'ETag': object.httpEtag,
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
}
