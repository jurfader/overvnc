// Narzędzia administracyjne:
//   npm run cli -- passwd <login>       ustaw/zmień hasło (tworzy konto właściciela, jeśli nie istnieje)
//   npm run cli -- reset-2fa <login>    wyłącz 2FA (np. po utracie telefonu) — przy logowaniu trzeba je skonfigurować od nowa
//   npm run cli -- unlock <login>       odblokuj konto
//   npm run cli -- users                lista kont
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
  if (res.changes === 0) db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'owner', ?)").run(arg, hash, Date.now());
  else db.prepare('UPDATE users SET must_change_password = 0 WHERE username = ?').run(arg);
  // wyloguj wszystkie sesje tego konta
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(arg);
  audit(db, 'system', res.changes === 0 ? 'user.create' : 'user.passwd', arg);
  console.log(res.changes === 0 ? `Utworzono konto "${arg}".` : `Zmieniono hasło "${arg}".`);
} else if (cmd === 'reset-2fa' && arg) {
  const res = db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0 WHERE username = ?').run(arg);
  if (res.changes === 0) fail(`Brak konta "${arg}".`);
  db.prepare('DELETE FROM recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(arg);
  db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(arg);
  audit(db, 'system', 'user.reset_2fa', arg, { via: 'cli' });
  console.log(`Wyłączono 2FA dla "${arg}". Przy następnym logowaniu trzeba je skonfigurować ponownie.`);
} else if (cmd === 'unlock' && arg) {
  if (db.prepare('UPDATE users SET disabled = 0 WHERE username = ?').run(arg).changes === 0) fail(`Brak konta "${arg}".`);
  audit(db, 'system', 'user.unlock', arg, { via: 'cli' });
  console.log(`Odblokowano "${arg}".`);
} else if (cmd === 'users') {
  console.table(
    db
      .prepare(
        "SELECT id, username, role, CASE disabled WHEN 1 THEN 'tak' ELSE '' END AS zablokowane, CASE totp_enabled WHEN 1 THEN 'tak' ELSE '' END AS \"2fa\", datetime(created_at/1000, 'unixepoch') AS utworzone FROM users",
      )
      .all(),
  );
} else {
  console.log('Użycie: npm run cli -- passwd <login> | reset-2fa <login> | unlock <login> | users');
  process.exit(1);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
