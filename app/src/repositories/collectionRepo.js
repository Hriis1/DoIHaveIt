import { withDatabaseAccess } from '../database.js'

export async function getCollections() {
  return withDatabaseAccess(async database => {
    const { values } = await database.query(
      'SELECT id, name, created_at, updated_at FROM collections ORDER BY id ASC;'
    )

    return values ?? []
  })
}

export async function addCollection(name) {
  const collectionName = name.trim()
  if (!collectionName) throw new Error('Enter a collection name.')

  return withDatabaseAccess(database => database.run('INSERT INTO collections (name) VALUES (?);', [collectionName]))
}

export async function deleteCollection(id) {
  return withDatabaseAccess(database => database.run('DELETE FROM collections WHERE id = ?;', [id]))
}
