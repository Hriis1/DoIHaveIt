
## Database Access

`src/database.js` owns the shared SQLite connection, initial table creation, and schema upgrades. Initialization must preserve existing data and return the same cached connection promise to all callers.

Only repository files in `src/repositories/` may execute table-specific data queries and mutations. For example, `collectionRepo.js` owns collection reads, inserts, updates, and deletes. Repositories obtain the initialized connection through `initializeDatabase()` and use parameterized SQL; they must not create tables or manage connections.

Screens call repository functions and must not contain SQL or directly access the SQLite plugin. Keep schema changes in `database.js` or an explicitly organized migration layer; released databases must be upgraded without deleting user data.
