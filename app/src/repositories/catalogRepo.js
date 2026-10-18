import { withDatabaseAccess } from '../database.js'
import { checkCancellation } from '../modules/catalog/cancellation.js'

const batchSize = 400
const placeholders = values => values.map(() => '?').join(',')

// Accept a connection scheduler so the same repository can be tested with real SQLite
export function createCatalogRepository(access = withDatabaseAccess) {
  async function findCatalog(database, name) {
    const { values } = await database.query('SELECT id FROM catalogs WHERE name = ?;', [name])
    return values[0]?.id
  }

  async function transaction(database, operation, { signal, onProgress }) {
    checkCancellation(signal)
    await database.beginTransaction()
    try {
      await operation()
      checkCancellation(signal)
      onProgress('finishing')
      await database.commitTransaction()
    } catch (error) {
      onProgress(signal?.aborted ? 'cancelling' : 'rollingBack')
      try {
        await database.rollbackTransaction()
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Database recovery failed. Restart the app before trying again.')
      }
      throw error
    }
  }

  async function insertBatch(database, catalogId, records, nextId, signal) {

    //Remove duplicate barcodes within this batch
    const firstRecords = new Map()
    for (const record of records) {
      if (!firstRecords.has(record.barcode)) firstRecords.set(record.barcode, record)
    }
    const unique = [...firstRecords.values()]

    //Find barcodes already in the database
    const existing = new Set()
    for (let offset = 0; offset < unique.length; offset += batchSize) {
      checkCancellation(signal)
      const codes = unique.slice(offset, offset + batchSize).map(record => record.barcode)
      const { values } = await database.query(`SELECT code FROM codes WHERE code IN (${placeholders(codes)});`, codes)
      values.forEach(row => existing.add(row.code))
    }
    const rows = unique.filter(record => !existing.has(record.barcode)).map(record => ({ ...record, id: nextId++ }))

    // Bound SQL parameter counts and bridge payloads while retaining one outer transaction
    for (let offset = 0; offset < rows.length; offset += 100) {
      checkCancellation(signal)
      const part = rows.slice(offset, offset + 100)
      await database.executeSet([
        {
          statement: `INSERT INTO products (id, brand, name, size, catalog_id) VALUES ${part.map(() => '(?,?,?,?,?)').join(',')};`,
          values: part.flatMap(row => [row.id, row.brand, row.name, row.size, catalogId]),
        },
        {
          statement: `INSERT INTO codes (code, product_id, catalog_id) VALUES ${part.map(() => '(?,?,?)').join(',')};`,
          values: part.flatMap(row => [row.barcode, row.id, catalogId]),
        },
      ], false)
    }
    return nextId
  }

  async function changeBatches(database, select, mutate, catalogId, signal) {
    while (true) {
      checkCancellation(signal)
      const { values } = await database.query(`${select} LIMIT ${batchSize};`, [catalogId])
      if (!values.length) break
      const ids = values.map(row => row.key)
      await database.run(mutate(placeholders(ids)), ids, false)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }

  return {
    isCatalogInstalled: name => access(async database => (await findCatalog(database, name)) !== undefined),

    importCatalog: (name, batches, options) => access(async database => {
      checkCancellation(options.signal)
      if (await findCatalog(database, name) !== undefined) return false
      await transaction(database, async () => {
        options.onProgress('importing')
        await database.run('INSERT INTO catalogs (name) VALUES (?);', [name], false)
        const catalogId = await findCatalog(database, name)
        const { values } = await database.query(`
          SELECT MAX(COALESCE((SELECT MAX(id) FROM products), 0),
            COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'products'), 0)) + 1 AS next_id;
        `)
        let nextId = values[0].next_id
        for await (const batch of batches) {
          checkCancellation(options.signal)
          nextId = await insertBatch(database, catalogId, batch, nextId, options.signal)
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }, options)
      return true
    }),

    removeCatalog: (name, options) => access(async database => {
      checkCancellation(options.signal)
      const catalogId = await findCatalog(database, name)
      if (catalogId === undefined) return false
      await transaction(database, async () => {
        options.onProgress('removing')
        await changeBatches(database,
          `SELECT code AS key FROM codes WHERE catalog_id = ?
            AND NOT EXISTS (SELECT 1 FROM items WHERE items.product_id = codes.product_id)`,
          marks => `DELETE FROM codes WHERE code IN (${marks});`, catalogId, options.signal)
        await changeBatches(database,
          `SELECT id AS key FROM products WHERE catalog_id = ?
            AND NOT EXISTS (SELECT 1 FROM items WHERE items.product_id = products.id)
            AND NOT EXISTS (SELECT 1 FROM codes WHERE codes.product_id = products.id)`,
          marks => `DELETE FROM products WHERE id IN (${marks});`, catalogId, options.signal)

        // Detach retained collection products and their codes before deleting the catalog
        await changeBatches(database, 'SELECT code AS key FROM codes WHERE catalog_id = ?',
          marks => `UPDATE codes SET catalog_id = NULL WHERE code IN (${marks});`, catalogId, options.signal)
        await changeBatches(database, 'SELECT id AS key FROM products WHERE catalog_id = ?',
          marks => `UPDATE products SET catalog_id = NULL WHERE id IN (${marks});`, catalogId, options.signal)
        checkCancellation(options.signal)
        await database.run('DELETE FROM catalogs WHERE id = ?;', [catalogId], false)
      }, options)
      return true
    }),
  }
}

export const { isCatalogInstalled, importCatalog, removeCatalog } = createCatalogRepository()
