import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { ensureAdmin } from './auth.ts';
import { buildApp } from './app.ts';

const config = loadConfig();
const db = openDb(config.dbFile);

const created = await ensureAdmin(db);
if (created) {
  console.log('\n==================================================');
  console.log(' Utworzono konto administratora (pokazywane tylko raz):');
  console.log(`   login: ${created.username}`);
  console.log(`   hasło: ${created.password}`);
  console.log(' Zmiana hasła: npm run cli -- passwd <login>');
  console.log('==================================================\n');
}

const { app } = await buildApp(config, db);

// łagodne zamknięcie: dokończ żądania, zamknij WebSockety, zapisz WAL
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} — zamykanie serwera`);
    await app.close();
    db.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
