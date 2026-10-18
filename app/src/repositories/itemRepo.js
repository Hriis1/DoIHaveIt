import { withDatabaseAccess } from '../database.js'

export async function getCollectionItems(collectionId, { search, page, pageSize }) {
  return withDatabaseAccess(async database => {
    const filter = `
      FROM items AS i
      JOIN products AS p ON p.id = i.product_id
      WHERE i.collection_id = ?
        AND instr(lower(p.brand || ': ' || p.name ||
          CASE WHEN p.size IS NULL THEN '' ELSE '(' || p.size || ')' END), lower(?)) > 0
    `
    const parameters = [collectionId, search.trim()]

    // Count all matching items before selecting the requested page
    const { values: counts } = await database.query(`SELECT COUNT(*) AS total ${filter};`, parameters)
    const total = counts[0].total
    const totalPages = Math.max(1, Math.ceil(total / pageSize))
    const currentPage = Math.max(1, Math.min(page, totalPages))
    const { values } = await database.query(`
      SELECT i.id, i.image AS item_image, NULL AS product_image, p.brand, p.name, p.size
      ${filter}
      ORDER BY i.id ASC LIMIT ? OFFSET ?;
    `, [...parameters, pageSize, (currentPage - 1) * pageSize])

    return { items: values ?? [], total, page: currentPage, totalPages }
  })
}
