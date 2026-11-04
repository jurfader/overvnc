// Narzędzia administracyjne:
//   npm run cli -- passwd <login>     ustaw/zmień hasło (tworzy konto, jeśli nie istnieje)
//   npm run cli -- users              lista kont
import { createInterface } from 'node:readline/promises';
import { loadConfig } from './config.ts';
import { audit, openDb } from './db.ts';
import { hashPassword } from './crypto.ts';

const db = openDb(loadConfig().dbFile);
const [cmd, arg] = process.argv.slice(2);

if (cmd === 'passwd' && arg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question(`Nowe hasło dla "${arg}" (min. 10 znaków): `);
  rl.close();
  if (pw.length < 10) {
    console.error('Hasło za krótkie.');
    process.exit(1);
  }
  const hash = await hashPassword(pw);
  const res = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, arg);
  if (res.changes === 0) db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(arg, hash, Date.now());
  // wyloguj wszystkie sesje tego konta
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(arg);
  audit(db, 'system', res.changes === 0 ? 'user.create' : 'user.passwd', arg);
  console.log(res.changes === 0 ? `Utworzono konto "${arg}".` : `Zmieniono hasło "${arg}".`);
} else if (cmd === 'users') {
  console.table(db.prepare("SELECT id, username, datetime(created_at/1000, 'unixepoch') AS created FROM users").all());
} else {
  console.log('Użycie: npm run cli -- passwd <login> | users');
  process.exit(1);
}
