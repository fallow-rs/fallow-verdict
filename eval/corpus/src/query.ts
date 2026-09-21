type Database = { query: (sql: string) => Promise<unknown> };

/** Load an account using an externally supplied identifier. */
export const query = (identifier: string, database: Database): Promise<unknown> =>
  database.query(`SELECT * FROM accounts WHERE id = ${identifier}`);
