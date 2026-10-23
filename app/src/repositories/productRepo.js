import { withDatabaseAccess } from '../database.js'

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
