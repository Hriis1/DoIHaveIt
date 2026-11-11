export function createCreditRepository(database) {
  return {
    // Check the balance and active session in the same write that spends the credits
    deductCredits: (userId, tokenHash, cost) => database.prepare(`
      UPDATE users SET credits = credits - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND credits >= ? AND EXISTS (
        SELECT 1 FROM sessions
        WHERE user_id = users.id AND token_hash = ? AND expires_at > CURRENT_TIMESTAMP
      )
      RETURNING credits;
    `).bind(cost, userId, cost, tokenHash).first(),

    refundCredits: (userId, cost) => database.prepare(`
      UPDATE users SET credits = credits + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? RETURNING credits;
    `).bind(cost, userId).first(),
  }
}
