import { withDatabaseAccess } from '../database.js'

export function createUserRepository(access = withDatabaseAccess) {
  return {
    async getCurrentUser() {
      return access(async database => {
        const { values } = await database.query('SELECT id, email, credits FROM users LIMIT 1;')
        return values?.[0] ?? null
      })
    },
    async saveCurrentUser({ id, email, credits }) {
      return access(database => database.run(
        'INSERT OR REPLACE INTO users (id, email, credits) VALUES (?, ?, ?);', [id, email, credits], false
      ))
    },
    async deleteCurrentUser() {
      return access(database => database.run('DELETE FROM users;', [], false))
    },
  }
}

export const { getCurrentUser, saveCurrentUser, deleteCurrentUser } = createUserRepository()
