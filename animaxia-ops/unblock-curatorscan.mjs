import pg from 'pg';
const envText = await Bun.file('/home/z/my-project/mini-services/animaxia-backend/.env').text();
const cs = envText.split('\n').find((l) => l.startsWith('DATABASEURL=')).slice('DATABASEURL='.length).trim();
const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
await client.connect();

/* Terminăm DOAR sesiunile blocate pe cross-join-ul trigram curatorScan (degradarea
 * documentată FAZA-32-B) care rulează de > 5 minute — query-uri orfane de la
 * procese client moarte (kill -9). Zero cod modificat; este acțiune operațională
 * de deblocare (lock-chain: curatorScan → ALTER TABLE shardid → COUNT(*) boot). */
const r = await client.query(
  `SELECT pid, pg_terminate_backend(pid) AS terminated, now()-query_start AS age
   FROM pg_stat_activity
   WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
     AND state = 'active'
     AND query ILIKE '%similarity(a.title, b.title)%'
     AND now() - query_start > interval '2 minutes'`,
);
for (const row of r.rows) console.log(`terminated PID ${row.pid} (age ${Math.round(row.age.seconds)}s): ${row.terminated}`);
if (r.rows.length === 0) console.log('no stale curatorScan queries found');
await client.end();
