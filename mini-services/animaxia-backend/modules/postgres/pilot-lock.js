/**
 * Native pilot catalog writer/projector coordination.
 *
 * Both sides acquire this exact transaction-scoped lock BEFORE touching or
 * reading a particular externalid. A projector cannot commit a snapshot
 * concurrently with a newer native writer transaction for the same key.
 *
 * PostgreSQL advisory locks are session-local and automatically released
 * on COMMIT/ROLLBACK. This does not serialize unrelated content IDs.
 */
export async function lockPgPilotExternalId(client,externalid){
  if(!client||typeof client.query!=='function'||
    typeof externalid!=='string'||externalid.length<1||externalid.length>220)
    throw Object.assign(new Error('Invalid pilot advisory lock arguments'),{status:400});
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 89241))',
    [externalid]
  );
}
