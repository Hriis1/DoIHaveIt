export function createPurchaseRepository(database) {
  return {
    async processPurchase({ userId, store, environment, transactionId, productId, credits, refunded, allowGrant }) {
      const key = [store, environment, transactionId]
      // Every balance change and its processing marker commit or roll back together.
      const statements = [database.prepare(`
        INSERT INTO purchases (user_id, store, environment, transaction_id, product_id, credits, status)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE ? OR ?
        ON CONFLICT (store, environment, transaction_id) DO NOTHING;
      `).bind(userId, ...key, productId, credits, refunded ? 'refunded' : 'granted', refunded ? 1 : 0, allowGrant ? 1 : 0)]
      const owner = 'store = ? AND environment = ? AND transaction_id = ? AND user_id = ? AND product_id = ?'
      const parameters = [...key, userId, productId]
      if (refunded) {
        statements.push(database.prepare(`
          UPDATE users SET credits = MAX(0, credits - (
            SELECT credits FROM purchases WHERE ${owner}
          )), updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM purchases WHERE ${owner} AND granted_at IS NOT NULL AND refunded_at IS NULL
          );
        `).bind(...parameters, userId, ...parameters))
        statements.push(database.prepare(`
          UPDATE purchases SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE ${owner} AND refunded_at IS NULL;
        `).bind(...parameters))
      } else if (allowGrant) {
        statements.push(database.prepare(`
          UPDATE users SET credits = credits + (
            SELECT credits FROM purchases WHERE ${owner}
          ), updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND EXISTS (
            SELECT 1 FROM purchases WHERE ${owner} AND status = 'granted' AND granted_at IS NULL
          );
        `).bind(...parameters, userId, ...parameters))
        statements.push(database.prepare(`
          UPDATE purchases SET granted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE ${owner} AND status = 'granted' AND granted_at IS NULL;
        `).bind(...parameters))
      }
      statements.push(database.prepare('SELECT user_id, product_id FROM purchases WHERE store = ? AND environment = ? AND transaction_id = ?;').bind(...key))
      const results = await database.batch(statements)
      const record = results.at(-1).results[0]
      if (record && (record.user_id !== userId || record.product_id !== productId)) {
        throw new Error('Purchase identity conflict')
      }
    },
    getStatus: (userId, transactionId) => database.prepare(`
      SELECT users.credits, COALESCE((
        SELECT status FROM purchases
        WHERE user_id = users.id AND store = 'PLAY_STORE' AND transaction_id = ?
        ORDER BY CASE environment WHEN 'PRODUCTION' THEN 0 ELSE 1 END LIMIT 1
      ), 'processing') AS status FROM users WHERE id = ?;
    `).bind(transactionId, userId).first(),
    getUser: userId => database.prepare('SELECT id FROM users WHERE id = ?;').bind(userId).first(),
  }
}
