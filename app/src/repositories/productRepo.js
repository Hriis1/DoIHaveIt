import { withDatabaseAccess } from '../database.js'

export async function getProductByBarcode(barcode) {
  return withDatabaseAccess(async database => {
    const { values } = await database.query(`
      SELECT p.brand, p.name, p.size, c.code
      FROM codes AS c
      JOIN products AS p ON p.id = c.product_id
      WHERE c.code = ?;
    `, [barcode])

    return values?.[0] ?? null
  })
}
