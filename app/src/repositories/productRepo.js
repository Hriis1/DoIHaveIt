import { withDatabaseAccess } from '../database.js'

// Accept the connection scheduler so product searches can be tested with real SQLite
export function createProductRepository(access = withDatabaseAccess) {
  return {
    getProducts: ({ search = '', mode = 'text', page = 1, pageSize = 12 } = {}) => access(async database => {
      const query = search.trim()
      const terms = query ? query.split(/\s+/) : []
      // Quote user text so FTS operators stay literal, and match each word prefix
      const expression = terms.map(term => `"${term.replace(/"/g, '""')}"*`).join(' AND ')
      const parameters = query ? [mode === 'barcode' ? query : expression] : []
      const conditions = mode === 'barcode'
        ? (query ? ['p.id = (SELECT product_id FROM codes WHERE code = ?)'] : [])
        : (query ? ['p.id IN (SELECT rowid FROM products_search WHERE products_search MATCH ?)'] : [])
      const filter = `FROM products AS p${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`

      // Count matching products independently of how many barcodes they have
      const { values: counts } = await database.query(`SELECT COUNT(*) AS total ${filter};`, parameters)
      const total = counts[0].total
      const totalPages = Math.max(1, Math.ceil(total / pageSize))
      const currentPage = Math.max(1, Math.min(page, totalPages))
      const { values } = await database.query(`
        SELECT p.id, p.brand, p.name, p.size ${filter}
        ORDER BY p.brand COLLATE NOCASE, p.name COLLATE NOCASE, p.size COLLATE NOCASE, p.id
        LIMIT ? OFFSET ?;
      `, [...parameters, pageSize, (currentPage - 1) * pageSize])
      const products = (values ?? []).map(product => ({ ...product, barcodes: [] }))

      // Fetch every linked barcode for this page, including ones that did not match the search
      if (products.length) {
        const { values: codes } = await database.query(`
          SELECT product_id, code FROM codes
          WHERE product_id IN (${products.map(() => '?').join(',')}) ORDER BY code;
        `, products.map(product => product.id))
        const byId = new Map(products.map(product => [product.id, product]))
        for (const code of codes ?? []) byId.get(code.product_id).barcodes.push(code.code)
      }
      return { products, total, page: currentPage, totalPages }
    }),
  }
}

export const { getProducts } = createProductRepository()

export async function getProductByBarcode(barcode) {
  const barcodes = [barcode]
  // Only convert valid UPC-A and zero-prefixed EAN-13 identifiers
  if (typeof barcode === 'string' && /^(?:\d{12}|0\d{12})$/.test(barcode)) {
    const upc = barcode.slice(-12)
    const checksum = [...upc].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 === 0 ? 3 : 1), 0)
    if (checksum % 10 === 0) barcodes.push(barcode.length === 12 ? `0${barcode}` : upc)
  }

  return withDatabaseAccess(async database => {
    for (const code of barcodes) {
      const { values } = await database.query(`
        SELECT p.brand, p.name, p.size, c.code
        FROM codes AS c
        JOIN products AS p ON p.id = c.product_id
        WHERE c.code = ?;
      `, [code])
      if (values?.[0]) return values[0]
    }

    return null
  })
}
