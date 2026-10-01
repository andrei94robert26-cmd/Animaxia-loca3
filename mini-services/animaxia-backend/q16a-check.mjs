import pg from 'pg';
import fs from 'node:fs';

const env = {};
for (const line of fs.readFileSync('/home/z/my-project/mini-services/animaxia-backend/.env', 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const pool = new pg.Pool({ connectionString: env.DATABASEURL, max: 2 });
const [ext, tables, count] = await Promise.all([
  pool.query(`SELECT extname FROM pg_extension ORDER BY extname`),
  pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`),
  pool.query(`SELECT COUNT(*) AS n FROM content`),
]);
console.log('extensions:', ext.rows.map(r => r.extname).join(', '));
console.log('tables:', tables.rows.map(r => r.table_name).join(', '));
console.log('content rows:', count.rows[0].n);
const sample = await pool.query(`SELECT id, externalid, type, title, metadata->>'year' AS year, metadata->>'rating' AS rating, metadata->'genres' AS genres, metadata->'cast' AS cast, metadata->>'studios' AS studios FROM content ORDER BY id LIMIT 5`);
console.log(JSON.stringify(sample.rows, null, 1).slice(0, 2600));
await pool.end();
