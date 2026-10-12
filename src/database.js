import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

const sqlite = new SQLiteConnection(CapacitorSQLite)
let databasePromise

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

export async function getCollections() {
  const database = await initializeDatabase()
  const { values } = await database.query(
    'SELECT id, name, created_at, updated_at FROM collections ORDER BY id ASC;'
  )

  return values ?? []
}

export async function addCollection(name) {
  const collectionName = name.trim()
  if (!collectionName) throw new Error('Enter a collection name.')

  const database = await initializeDatabase()
  await database.run('INSERT INTO collections (name) VALUES (?);', [collectionName])
}

export async function deleteCollection(id) {
  const database = await initializeDatabase()
  await database.run('DELETE FROM collections WHERE id = ?;', [id])
}

async function openDatabase() {
  // Reuse the connection, or open the existing database on disk
  await sqlite.checkConnectionsConsistency()
  const { result } = await sqlite.isConnection('doihaveit', false)
  const database = result
    ? await sqlite.retrieveConnection('doihaveit', false)
    : await sqlite.createConnection('doihaveit', false, 'no-encryption', 2, false)

  await database.open()

  // Create the initial schema without replacing existing collections
  await database.execute(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)

  return database
}
