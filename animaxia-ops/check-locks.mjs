import pg from 'pg';
const envText = await Bun.file('/home/z/my-project/mini-services/animaxia-backend/.env').text();
const cs = envText.split('\n').find((l) => l.startsWith('DATABASEURL=')).slice('DATABASEURL='.length).trim();
const client = new pg.Client({ connectionString: cs, ssl: { rejectUnauthorized: false } });
await client.connect();
const r = await client.query(
  `SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blocked_by,
          now()-query_start AS age, left(query,130) AS q
   FROM pg_stat_activity WHERE datname IS NOT NULL AND pid <> pg_backend_pid()
   ORDER BY query_start`,
);
for (const row of r.rows) {
  const ageS = Math.round(row.age.seconds + row.age.minutes * 60);
  console.log(
    `PID ${row.pid} | ${row.state} | wait=${row.wait_event_type}/${row.wait_event} | blocked_by=${JSON.stringify(row.blocked_by)} | age=${ageS}s | Q=${String(row.q).replace(/\s+/g, ' ').slice(0, 110)}`,
  );
}
await client.end();
