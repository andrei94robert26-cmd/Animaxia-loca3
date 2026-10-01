import { localDb } from './modules/local/sqlite.js';

localDb.exec(`
PRAGMA foreign_keys=OFF;
PRAGMA legacy_alter_table=ON;
DROP TABLE tenants;
ALTER TABLE tenants_new RENAME TO tenants;
PRAGMA legacy_alter_table=OFF;
PRAGMA foreign_keys=ON;
`);

console.log('TENANTS SWAP OK');
