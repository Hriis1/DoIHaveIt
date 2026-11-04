import { AuthError } from '../auth/errors.js'

export function createAuthRepository(database) {
  return {
    getUserByEmail: email => database.prepare(`
      SELECT id, email, password_hash, credits FROM users WHERE email = ?;
    `).bind(email).first(),

    registerUser: async ({ email, passwordHash, tokenHash, expiresAt }) => {
      try {
        // Creating the account and its first session must succeed or roll back together
        const [created] = await database.batch([
          database.prepare(`
            INSERT INTO users (email, password_hash) VALUES (?, ?)
            RETURNING id, email, credits;
          `).bind(email, passwordHash),
          database.prepare(`
            INSERT INTO sessions (user_id, token_hash, expires_at)
            SELECT id, ?, ? FROM users WHERE email = ?;
          `).bind(tokenHash, expiresAt, email),
        ])
        return created.results[0]
      } catch (error) {
        if (/UNIQUE constraint failed: users.email/i.test(`${error.message} ${error.cause?.message ?? ''}`)) {
          throw new AuthError('An account with this email already exists.', 409)
        }
        throw error
      }
    },

    createSession: (userId, tokenHash, expiresAt) => database.prepare(`
      INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?);
    `).bind(userId, tokenHash, expiresAt).run(),

    getSessionUser: (tokenHash, now) => database.prepare(`
      SELECT users.id, users.email, users.credits
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?;
    `).bind(tokenHash, now).first(),

    deleteSession: tokenHash => database.prepare(`
      DELETE FROM sessions WHERE token_hash = ?;
    `).bind(tokenHash).run(),
  }
}
