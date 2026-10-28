import { withDatabaseAccess, withAttachedDatabase } from '../database.js'
import { checkCancellation } from '../modules/catalog/cancellation.js'

const batchSize = 400
const placeholders = values => values.map(() => '?').join(',')
const importBatchSize = 5000

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

  async function validateCatalog(database, signal) {
    checkCancellation(signal)
    const { values: tables } = await database.query("SELECT type FROM catalog_source.sqlite_master WHERE name = 'catalog_products';")
    if (tables[0]?.type !== 'table') throw new Error('The catalog database is missing its product table.')
    const { values: columns } = await database.query("PRAGMA catalog_source.table_info('catalog_products');")
    const required = { source_id: 'INTEGER', barcode: 'TEXT', brand: 'TEXT', name: 'TEXT', size: 'TEXT' }
    if (Object.entries(required).some(([name, type]) => !columns.some(column => column.name === name && column.type.toUpperCase() === type)) ||
        columns.find(column => column.name === 'source_id').pk !== 1 || columns.filter(column => column.pk).length !== 1) {
      throw new Error('The catalog database has an unsupported product schema.')
    }
    const { values: indexes } = await database.query("PRAGMA catalog_source.index_list('catalog_products');")
    let uniqueBarcode = false
    for (const index of indexes.filter(index => index.unique && !index.partial)) {
      checkCancellation(signal)
      const name = index.name.replaceAll("'", "''")
      const { values } = await database.query(`PRAGMA catalog_source.index_info('${name}');`)
      if (values.length === 1 && values[0].name === 'barcode') uniqueBarcode = true
    }
    if (!uniqueBarcode) throw new Error('The catalog database must have unique barcodes.')
    checkCancellation(signal)
    const { values: integrity } = await database.query('PRAGMA catalog_source.quick_check(1);')
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw new Error('The catalog database is damaged.')
    checkCancellation(signal)
    const { values } = await database.query(`
      SELECT (SELECT source_id FROM catalog_source.catalog_products ORDER BY source_id LIMIT 1) AS first_id,
        (SELECT source_id FROM catalog_source.catalog_products ORDER BY source_id DESC LIMIT 1) AS last_id;
    `)
    if (!Number.isSafeInteger(values[0].first_id) || values[0].first_id < 1 || !Number.isSafeInteger(values[0].last_id)) {
      throw new Error('The catalog database is empty or has invalid product identifiers.')
    }
    return values[0].last_id
  }

  async function mergeBatch(database, catalogId, baseId, afterId, lastId, signal) {
    checkCancellation(signal)
    const { values: invalid } = await database.query(`
      SELECT 1 AS invalid FROM catalog_source.catalog_products
      WHERE source_id > ? AND source_id <= ? AND (
        typeof(barcode) <> 'text' OR trim(barcode) = '' OR barcode <> trim(barcode)
        OR typeof(brand) <> 'text' OR trim(replace(brand, ',', '')) = ''
        OR typeof(name) <> 'text' OR trim(name) = ''
        OR (size IS NOT NULL AND typeof(size) <> 'text')
      ) LIMIT 1;
    `, [afterId, lastId])
    if (invalid.length) throw new Error('The catalog contains a product with invalid or missing fields.')
    checkCancellation(signal)
    // Split brands inside SQLite and ignore rows whose barcodes are already installed
    const brandParts = `WITH RECURSIVE brand_parts(source_id, remaining, brand) AS (
      SELECT source_id, brand || ',', '' FROM catalog_source.catalog_products AS source
      WHERE source_id > ? AND source_id <= ?
        AND NOT EXISTS (SELECT 1 FROM main.codes WHERE code = source.barcode)
      UNION ALL
      SELECT source_id, substr(remaining, instr(remaining, ',') + 1),
        trim(substr(remaining, 1, instr(remaining, ',') - 1))
      FROM brand_parts WHERE remaining <> ''
    )`
    await database.executeSet([
      { statement: 'DELETE FROM temp.catalog_import_merges;', values: [] },
      {
        statement: `INSERT INTO main.products (id, name, size, catalog_id)
          SELECT ? + source.source_id, trim(source.name), NULLIF(trim(source.size), ''), ?
          FROM catalog_source.catalog_products AS source
          WHERE source.source_id > ? AND source.source_id <= ?
            AND NOT EXISTS (SELECT 1 FROM main.codes WHERE code = source.barcode)
          ORDER BY source.source_id;`,
        values: [baseId, catalogId, afterId, lastId],
      },
      {
        statement: `${brandParts}
          INSERT INTO main.brands (name)
          SELECT DISTINCT brand FROM brand_parts WHERE brand <> ''
          ON CONFLICT(name) DO NOTHING;`,
        values: [afterId, lastId],
      },
      {
        statement: `${brandParts}
          INSERT INTO main.product_brands (product_id, brand_id)
          SELECT DISTINCT ? + parts.source_id, brands.id FROM brand_parts AS parts
          JOIN main.brands AS brands ON brands.name = parts.brand
          WHERE parts.brand <> '';`,
        values: [afterId, lastId, baseId],
      },
      {
        // Every new barcode starts with its reserved product before connected products are merged
        statement: `INSERT INTO main.codes (code, product_id, catalog_id)
          SELECT source.barcode, ? + source.source_id, ?
          FROM catalog_source.catalog_products AS source
          WHERE source.source_id > ? AND source.source_id <= ?
            AND NOT EXISTS (SELECT 1 FROM main.codes WHERE code = source.barcode)
          ORDER BY source.source_id;`,
        values: [baseId, catalogId, afterId, lastId],
      },
      {
        // Walk brand connections for each name/size, including bridges between existing products
        statement: `WITH RECURSIVE reachable(seed, brand_id, name, size) AS (
          SELECT DISTINCT pb.brand_id, pb.brand_id, p.name, p.size
          FROM main.products AS p JOIN main.product_brands AS pb ON pb.product_id = p.id
          WHERE p.id > ? AND p.id <= ?
          UNION
          SELECT r.seed, linked.brand_id, r.name, r.size FROM reachable AS r
          CROSS JOIN main.products AS p INDEXED BY products_name_size
          JOIN main.product_brands AS matched ON matched.product_id = p.id AND matched.brand_id = r.brand_id
          JOIN main.product_brands AS linked ON linked.product_id = p.id
          WHERE p.name = r.name AND p.size IS r.size
        ), members AS (
          SELECT DISTINCT r.seed, r.name, r.size, p.id
          FROM reachable AS r
          CROSS JOIN main.products AS p INDEXED BY products_name_size
          JOIN main.product_brands AS pb ON pb.product_id = p.id AND pb.brand_id = r.brand_id
          WHERE p.name = r.name AND p.size IS r.size
        ), targets AS (
          SELECT seed, name, size, MIN(id) AS target_id FROM members GROUP BY seed, name, size
        )
        INSERT INTO temp.catalog_import_merges (product_id, target_id)
        SELECT members.id, MIN(targets.target_id) FROM members
        JOIN targets ON targets.seed = members.seed AND targets.name = members.name AND targets.size IS members.size
        GROUP BY members.id HAVING members.id <> MIN(targets.target_id);`,
        values: [baseId + afterId, baseId + lastId],
      },
      {
        // Preserve local ownership if any merged product was independent of catalogs
        statement: `UPDATE main.products SET catalog_id = NULL WHERE id IN (
          SELECT merges.target_id FROM temp.catalog_import_merges AS merges
          JOIN main.products AS p ON p.id = merges.product_id WHERE p.catalog_id IS NULL
        );`,
        values: [],
      },
      {
        statement: `UPDATE main.codes SET product_id = (
          SELECT target_id FROM temp.catalog_import_merges WHERE product_id = codes.product_id
        ) WHERE product_id IN (SELECT product_id FROM temp.catalog_import_merges);`,
        values: [],
      },
      {
        statement: `UPDATE main.items SET product_id = (
          SELECT target_id FROM temp.catalog_import_merges WHERE product_id = items.product_id
        ) WHERE product_id IN (SELECT product_id FROM temp.catalog_import_merges);`,
        values: [],
      },
      {
        statement: `INSERT INTO main.product_brands (product_id, brand_id)
          SELECT merges.target_id, pb.brand_id FROM temp.catalog_import_merges AS merges
          JOIN main.product_brands AS pb ON pb.product_id = merges.product_id WHERE 1
          ON CONFLICT(product_id, brand_id) DO NOTHING;`,
        values: [],
      },
      {
        statement: 'DELETE FROM main.products WHERE id IN (SELECT product_id FROM temp.catalog_import_merges);',
        values: [],
      },
      { statement: 'DELETE FROM temp.catalog_import_merges;', values: [] },
    ], false)
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

    importCatalog: (name, path, options) => access(async database => {
      checkCancellation(options.signal)
      if (await findCatalog(database, name) !== undefined) return false
      return withAttachedDatabase(database, path, async () => {
        options.onProgress('checking')
        const maximumSourceId = await validateCatalog(database, options.signal)
        await transaction(database, async () => {
          options.onProgress('importing')
          await database.run('INSERT INTO catalogs (name) VALUES (?);', [name], false)
          const catalogId = await findCatalog(database, name)
          const { values } = await database.query(`
            SELECT MAX(COALESCE((SELECT MAX(id) FROM products), 0),
              COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'products'), 0)) AS base_id;
          `)
          const baseId = values[0].base_id
          if (!Number.isSafeInteger(baseId + maximumSourceId)) throw new Error('The catalog product identifiers are too large.')
          let afterId = 0
          while (afterId < maximumSourceId) {
            checkCancellation(options.signal)
            const { values: boundary } = await database.query(`
              SELECT MAX(source_id) AS last_id FROM (
                SELECT source_id FROM catalog_source.catalog_products
                WHERE source_id > ? ORDER BY source_id LIMIT ${importBatchSize}
              );
            `, [afterId])
            const lastId = boundary[0].last_id
            if (!Number.isSafeInteger(lastId) || lastId <= afterId) throw new Error('The catalog product identifiers are invalid.')
            await mergeBatch(database, catalogId, baseId, afterId, lastId, options.signal)
            afterId = lastId
            await new Promise(resolve => setTimeout(resolve, 0))
          }
        }, options)
        return true
      })
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
