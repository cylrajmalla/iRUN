import { Pool } from 'pg';

// A single shared pool. Under real load, tune max to your DB's connection
// budget (e.g. RDS default max_connections minus headroom for other services).
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 20),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. dropped connections) must not crash the process.
  // eslint-disable-next-line no-console
  console.error('[db] Unexpected error on idle client', err);
});

export async function checkDbConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
