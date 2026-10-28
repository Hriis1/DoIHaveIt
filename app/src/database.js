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

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      size VARCHAR(255),
      catalog_id INTEGER REFERENCES catalogs(id)
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
    -- Enforce product identity for both known and unknown sizes
    CREATE UNIQUE INDEX IF NOT EXISTS products_brand_name_size ON products(brand, name, size) WHERE size IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS products_brand_name_null_size ON products(brand, name) WHERE size IS NULL;
    CREATE INDEX IF NOT EXISTS codes_catalog_id ON codes(catalog_id);
    CREATE INDEX IF NOT EXISTS codes_product_id ON codes(product_id);
    CREATE INDEX IF NOT EXISTS items_product_id ON items(product_id);

    -- Resolve size matching for each import batch without retaining source rows in JavaScript
    CREATE TEMP TABLE IF NOT EXISTS catalog_import_rows (
      source_id INTEGER PRIMARY KEY,
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      size TEXT
    );
    CREATE INDEX IF NOT EXISTS temp.catalog_import_rows_identity ON catalog_import_rows(brand, name, source_id);
    CREATE TEMP TABLE IF NOT EXISTS catalog_import_sizes (
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      known_count INTEGER NOT NULL,
      first_size TEXT,
      ambiguous_after INTEGER,
      PRIMARY KEY (brand, name)
    );
  `)

  return database
}
