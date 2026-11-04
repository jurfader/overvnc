import { LogOut } from 'lucide-react';
import type { Me } from '../api.ts';
import { Button } from '../components.tsx';
import { MfaSetupFlow, PasswordForm } from './security.tsx';

/** Ekran wymuszonej czynności: ustawienie własnego hasła albo konfiguracja 2FA. */
export function Setup({ me, onDone, onLogout }: { me: Me; onDone: () => void; onLogout: () => void }) {
  const password = me.restriction === 'password_change_required';
  return (
    <div className="setup-wrap">
      <div className="glass-card setup-card anim-pop">
        <div className="login-head">
          <img src="/logo.png" alt="" />
          <h1>{password ? 'Ustaw własne hasło' : 'Włącz weryfikację dwuetapową'}</h1>
          <p>
            {password
              ? 'Logowanie odbyło się hasłem tymczasowym. Ustaw własne hasło, aby kontynuować.'
              : `Rola „${me.roleLabel}” wymaga weryfikacji dwuetapowej (2FA). To chroni wszystkie komputery na wypadek wycieku hasła.`}
          </p>
        </div>
        {password ? <PasswordForm onDone={onDone} submitLabel="Ustaw hasło" /> : <MfaSetupFlow onDone={onDone} />}
        <div style={{ borderTop: '1px solid var(--glass-border)', paddingTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span className="small muted">
            Zalogowano jako <strong>{me.username}</strong>
          </span>
          <Button size="sm" variant="ghost" icon={LogOut} onClick={onLogout}>
            Wyloguj
          </Button>
        </div>
      </div>
    </div>
  );
}
