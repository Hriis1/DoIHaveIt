import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

const sqlite = new SQLiteConnection(CapacitorSQLite)
let databasePromise
let databaseQueue = Promise.resolve()
let databaseAccessError

// Keep unrelated queries and writes outside catalog transactions
export function withDatabaseAccess(operation) {
  const result = databaseQueue.then(async () => {
    if (databaseAccessError) throw databaseAccessError
    return operation(await initializeDatabase())
  })
  databaseQueue = result.catch(() => {})
  return result
}

// Keep attached-file lifecycle on the same serialized connection as the import
export async function withAttachedDatabase(database, path, operation) {
  await database.run('ATTACH DATABASE ? AS catalog_source;', [path], false)
  try {
    return await operation()
  } finally {
    try {
      await database.run('DETACH DATABASE catalog_source;', [], false)
    } catch (error) {
      // Closing releases the attachment without misreporting an already committed import
      console.warn('Could not detach the temporary catalog database:', error)
      databasePromise = undefined
      try {
        await database.close()
      } catch {
        databaseAccessError = new Error('Database cleanup failed. Restart the app before trying again.')
      }
    }
  }
}

export function initializeDatabase() {
  // Share initialization across callers
  if (!databasePromise) {
    databasePromise = openDatabase().catch((error) => {
      databasePromise = undefined
      throw error
    })
  }

  return databasePromise
}

async function openDatabase() {
  // Reuse the connection, or open the existing database on disk
  await sqlite.checkConnectionsConsistency()
  const { result } = await sqlite.isConnection('doihaveit', false)
  const database = result
    ? await sqlite.retrieveConnection('doihaveit', false)
    : await sqlite.createConnection('doihaveit', false, 'no-encryption', 2, false)

  await database.open()

  // Enforce foreign keys outside the schema transaction
  await database.execute('PRAGMA foreign_keys = ON;', false)

  // Create the initial tables without replacing existing data
  await database.execute(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(255) NOT NULL UNIQUE,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(255) NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(255) NOT NULL,
      size VARCHAR(255),
      catalog_id INTEGER REFERENCES catalogs(id)
    );

    CREATE TABLE IF NOT EXISTS product_brands (
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      brand_id INTEGER NOT NULL REFERENCES brands(id),
      PRIMARY KEY (product_id, brand_id)
    );

    CREATE TABLE IF NOT EXISTS codes (
      code VARCHAR(255) PRIMARY KEY NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      catalog_id INTEGER REFERENCES catalogs(id),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES collections(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      image VARCHAR(255),
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS catalogs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name VARCHAR(255) NOT NULL UNIQUE
    );

    CREATE INDEX IF NOT EXISTS products_catalog_id ON products(catalog_id);
    -- Match product candidates by name, size, and overlapping brands during import
    CREATE INDEX IF NOT EXISTS products_name_size ON products(name, size);
    CREATE INDEX IF NOT EXISTS product_brands_brand_id ON product_brands(brand_id, product_id);
    CREATE INDEX IF NOT EXISTS codes_catalog_id ON codes(catalog_id);
    CREATE INDEX IF NOT EXISTS codes_product_id ON codes(product_id);
    CREATE INDEX IF NOT EXISTS items_product_id ON items(product_id);
  `)

  return database
}
