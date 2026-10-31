// Allow public API responses to be read by Android and iOS WebViews
export function respond(body, options = {}) {
  return new Response(body, {
    ...options,
    headers: { ...options.headers, 'Access-Control-Allow-Origin': '*' },
  })
}
