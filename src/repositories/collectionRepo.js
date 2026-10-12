import { initializeDatabase } from '../database.js'

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
