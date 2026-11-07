'use strict';
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const api = async (path, body) => {
  const r = await fetch(`${path}?t=${token}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Błąd ${r.status}`);
  return j;
};
let shown = 0;
let lastDay = '';

function time(ts) {
  return new Date(ts).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });
}
function dayOf(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Dzisiaj';
  return d.toLocaleDateString('pl-PL', { day: 'numeric', month: 'long' });
}

function render(history) {
  if (history.length < shown) {
    // historia skrócona (najstarsze usunięte) — od nowa
    $('messages').querySelectorAll('.msg, .day').forEach((el) => el.remove());
    shown = 0;
    lastDay = '';
  }
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  for (const m of history.slice(shown)) {
    const day = dayOf(m.ts);
    if (day !== lastDay) {
      const d = document.createElement('div');
      d.className = 'day';
      d.textContent = day;
      box.append(d);
      lastDay = day;
    }
    const el = document.createElement('div');
    el.className = `msg ${m.from === 'operator' ? 'operator' : 'user'}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${m.from === 'operator' ? m.author || 'Wsparcie' : 'Ty'} · ${time(m.ts)}`;
    const text = document.createElement('div');
    text.textContent = m.text;
    el.append(meta, text);
    box.append(el);
  }
  shown = history.length;
  $('empty').hidden = history.length > 0;
  if (atBottom || history.length) box.scrollTop = box.scrollHeight;
}

async function poll() {
  try {
    const s = await api('/api/state');
    render(s.history);
    const st = $('status');
    st.className = `status ${s.online ? 'on' : 'off'}`;
    $('status-text').textContent = s.online ? 'Połączono — odpowiemy tutaj' : s.linked ? 'Brak internetu — wiadomości wyślą się później' : 'Łączenie z usługą OVERVNC…';
    $('remote').hidden = !s.remote || s.remote.length === 0;
    $('remote-names').textContent = s.remote && s.remote.length ? `Połączono: ${s.remote.join(', ')}` : '';
    $('computer').textContent = s.computer ? `Komputer: ${s.computer}` : '';
  } catch {
    $('status').className = 'status off';
    $('status-text').textContent = 'Brak połączenia z usługą OVERVNC';
  }
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  $('send').disabled = true;
  try {
    await api('/api/send', { text });
    $('text').value = '';
    await poll();
  } catch (err) {
    alert(err.message);
  } finally {
    $('send').disabled = false;
    $('text').focus();
  }
};
$('text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('form').requestSubmit();
  }
});
$('end-remote').onclick = async () => {
  if (!confirm('Zakończyć zdalną sesję? Osoba ze wsparcia straci podgląd Twojego ekranu.')) return;
  try {
    await api('/api/end-remote', {});
    await poll();
  } catch (err) {
    alert(err.message);
  }
};

poll();
setInterval(poll, 1500);
$('text').focus();
