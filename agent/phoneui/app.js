'use strict';
// „Zdjęcia z telefonu” — interfejs dla klienta kiosku. Token sesji jest w adresie (#token).
const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(`${path}${path.includes('?') ? '&' : '?'}t=${token}`, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Błąd ${r.status}`);
  return body;
};
const thumbUrl = (id, size) => `/api/thumb?id=${encodeURIComponent(id)}${size ? `&size=${size}` : ''}&t=${token}`;

const plural = (n, one, few, many) => {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
};
const photos = (n) => `${n} ${plural(n, 'zdjęcie', 'zdjęcia', 'zdjęć')}`;

let devices = [];
let device = null; // id wybranego telefonu
let items = [];
let album = null; // null = wszystkie
let selected = new Set();
let loadingDevice = null;
let previewIndex = -1;

// ---------- komunikaty ----------
let toastTimer;
function toast(text, err) {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

function show(section) {
  for (const id of ['empty', 'loading', 'noitems', 'grid']) $(id).hidden = id !== section;
  $('albums').hidden = section !== 'grid';
  $('select-all').hidden = section !== 'grid';
}

// ---------- telefony ----------
async function pollDevices() {
  try {
    const r = await api('/api/devices');
    const ids = r.devices.map((d) => d.id).join('|');
    const changed = ids !== devices.map((d) => d.id).join('|');
    devices = r.devices;
    if (changed) renderDevices();
    if (device && !devices.some((d) => d.id === device)) {
      // telefon odłączony
      device = null;
      items = [];
      selected.clear();
      updateBar();
      toast('Telefon został odłączony');
    }
    if (!device && devices.length) await choose(devices[0].id);
    if (!devices.length) {
      $('device-name').textContent = 'Podłącz telefon kablem USB';
      show('empty');
    }
  } catch {
    /* chwilowy błąd — kolejna próba za chwilę */
  }
}

function renderDevices() {
  const box = $('devices');
  box.innerHTML = '';
  box.hidden = devices.length < 2;
  for (const d of devices) {
    const b = document.createElement('button');
    b.className = `chip${d.id === device ? ' on' : ''}`;
    b.textContent = d.name;
    b.onclick = () => choose(d.id);
    box.append(b);
  }
}

async function choose(id) {
  device = id;
  album = null;
  selected.clear();
  updateBar();
  renderDevices();
  const d = devices.find((x) => x.id === id);
  $('device-name').textContent = d ? d.name : '';
  await loadItems();
}

async function loadItems() {
  if (!device) return;
  const dev = device;
  loadingDevice = dev;
  show('loading');
  try {
    const r = await api(`/api/items?device=${encodeURIComponent(dev)}`);
    if (device !== dev) return;
    items = r.items;
    const d = devices.find((x) => x.id === dev);
    $('device-name').textContent = d ? `${d.name} · ${photos(items.length)}` : '';
    if (!items.length) show('noitems');
    else {
      renderAlbums();
      renderGrid();
      show('grid');
    }
  } catch (e) {
    if (device === dev) {
      show('noitems');
      toast(e.message, true);
    }
  } finally {
    if (loadingDevice === dev) loadingDevice = null;
  }
}

// ---------- albumy i siatka ----------
function visible() {
  return album ? items.filter((i) => i.album === album) : items;
}

function renderAlbums() {
  const counts = new Map();
  for (const i of items) counts.set(i.album, (counts.get(i.album) || 0) + 1);
  const box = $('albums');
  box.innerHTML = '';
  const chip = (label, value, n) => {
    const b = document.createElement('button');
    b.className = `chip${album === value ? ' on' : ''}`;
    b.innerHTML = `${label}<small>${n}</small>`;
    b.onclick = () => {
      album = value;
      renderAlbums();
      renderGrid();
    };
    box.append(b);
  };
  chip('Wszystkie', null, items.length);
  if (counts.size > 1) [...counts.entries()].sort((a, b) => b[1] - a[1]).forEach(([name, n]) => chip(name, name, n));
}

function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const y = new Date(now.getTime() - 86400000);
  if (d.toDateString() === now.toDateString()) return 'Dzisiaj';
  if (d.toDateString() === y.toDateString()) return 'Wczoraj';
  return d.toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

function renderGrid() {
  const grid = $('grid');
  grid.innerHTML = '';
  const list = visible();
  const groups = [];
  for (const it of list) {
    const label = it.ts ? dayLabel(it.ts) : 'Bez daty';
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(it);
  }
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const sec = document.createElement('section');
    sec.className = 'day';
    const head = document.createElement('div');
    head.className = 'day-head';
    head.innerHTML = `<h3></h3><span class="count">${photos(g.items.length)}</span>`;
    head.querySelector('h3').textContent = g.label;
    const all = document.createElement('button');
    all.className = 'btn';
    const sync = () => (all.textContent = g.items.every((i) => selected.has(i.id)) ? 'Odznacz dzień' : 'Zaznacz dzień');
    sync();
    all.onclick = () => {
      const on = !g.items.every((i) => selected.has(i.id));
      for (const i of g.items) on ? selected.add(i.id) : selected.delete(i.id);
      for (const el of sec.querySelectorAll('.tile')) setTile(el, selected.has(el.dataset.id));
      sync();
      updateBar();
    };
    head.append(all);
    sec.append(head);
    const tiles = document.createElement('div');
    tiles.className = 'tiles';
    for (const it of g.items) tiles.append(tile(it, sync));
    sec.append(tiles);
    frag.append(sec);
  }
  grid.append(frag);
  updateBar();
}

function tile(it, onChange) {
  const b = document.createElement('div');
  b.className = 'tile';
  b.dataset.id = it.id;
  b.setAttribute('role', 'button');
  b.tabIndex = 0;
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.decoding = 'async';
  img.alt = it.name;
  img.src = thumbUrl(it.id);
  img.onerror = () => {
    img.remove();
    const n = document.createElement('div');
    n.className = 'noimg';
    n.textContent = it.name;
    b.prepend(n);
  };
  const check = document.createElement('span');
  check.className = 'check';
  b.append(img, check);
  if (it.video) {
    const v = document.createElement('span');
    v.className = 'video';
    v.textContent = '▶ Film';
    b.append(v);
  }
  const zoom = document.createElement('button');
  zoom.className = 'zoom';
  zoom.setAttribute('aria-label', 'Powiększ');
  zoom.textContent = '⤢';
  zoom.onclick = (e) => {
    e.stopPropagation();
    openPreview(visible().findIndex((x) => x.id === it.id));
  };
  b.append(zoom);
  setTile(b, selected.has(it.id));
  b.onclick = () => {
    const on = !selected.has(it.id);
    on ? selected.add(it.id) : selected.delete(it.id);
    setTile(b, on);
    onChange();
    updateBar();
  };
  return b;
}

function setTile(el, on) {
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', String(on));
  el.querySelector('.check').textContent = on ? '✓' : '';
}

function updateBar() {
  const n = selected.size;
  $('bar').hidden = n === 0;
  $('sel-count').textContent = n;
  $('sel-label').textContent = plural(n, 'zaznaczone', 'zaznaczone', 'zaznaczonych');
  const list = visible();
  $('select-all').textContent = list.length && list.every((i) => selected.has(i.id)) ? 'Odznacz wszystkie' : 'Zaznacz wszystkie';
}

$('select-all').onclick = () => {
  const list = visible();
  const on = !list.every((i) => selected.has(i.id));
  for (const i of list) on ? selected.add(i.id) : selected.delete(i.id);
  renderGrid();
};
$('clear').onclick = () => {
  selected.clear();
  renderGrid();
};
$('retry').onclick = () => loadItems();

// ---------- podgląd ----------
function openPreview(i) {
  const list = visible();
  if (i < 0 || i >= list.length) return;
  previewIndex = i;
  const it = list[i];
  $('preview-img').src = thumbUrl(it.id, 'large');
  $('preview-name').textContent = `${it.name}${it.video ? ' · film (podgląd klatki)' : ''}`;
  $('preview-toggle').textContent = selected.has(it.id) ? '✓ Zaznaczone' : 'Zaznacz';
  $('preview-toggle').className = `btn${selected.has(it.id) ? ' primary' : ''}`;
  $('prev').disabled = i === 0;
  $('next').disabled = i === list.length - 1;
  $('preview').hidden = false;
}
$('prev').onclick = () => openPreview(previewIndex - 1);
$('next').onclick = () => openPreview(previewIndex + 1);
$('preview-toggle').onclick = () => {
  const it = visible()[previewIndex];
  if (!it) return;
  selected.has(it.id) ? selected.delete(it.id) : selected.add(it.id);
  const el = document.querySelector(`.tile[data-id="${CSS.escape(it.id)}"]`);
  if (el) setTile(el, selected.has(it.id));
  updateBar();
  openPreview(previewIndex);
};
$('preview').onclick = (e) => {
  if (e.target === $('preview') || e.target.hasAttribute('data-close')) $('preview').hidden = true;
};
document.addEventListener('keydown', (e) => {
  if ($('preview').hidden) return;
  if (e.key === 'Escape') $('preview').hidden = true;
  if (e.key === 'ArrowLeft') openPreview(previewIndex - 1);
  if (e.key === 'ArrowRight') openPreview(previewIndex + 1);
});

// ---------- okno dialogowe ----------
function dialog(title, text, actions, progress) {
  $('dialog-title').textContent = title;
  $('dialog-text').textContent = text;
  $('dialog-progress').hidden = progress === undefined;
  if (progress !== undefined) $('dialog-progress').firstElementChild.style.width = `${progress}%`;
  const box = $('dialog-actions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = `btn ${a.cls || ''}`;
    b.textContent = a.label;
    b.onclick = a.onClick;
    box.append(b);
  }
  $('dialog').hidden = false;
}
const closeDialog = () => ($('dialog').hidden = true);

async function runOp(kind, ids) {
  const verb = kind === 'copy' ? 'Kopiuję' : 'Usuwam';
  try {
    await api(`/api/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  } catch (e) {
    closeDialog();
    return toast(e.message, true);
  }
  dialog(`${verb} ${photos(ids.length)}…`, kind === 'copy' ? 'Nie odłączaj telefonu.' : 'Nie odłączaj telefonu.', [], 0);
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    let op;
    try {
      op = (await api('/api/op')).op;
    } catch {
      continue;
    }
    if (!op) continue;
    $('dialog-title').textContent = `${verb} ${op.done} z ${op.total}…`;
    $('dialog-progress').firstElementChild.style.width = `${Math.round((op.done / op.total) * 100)}%`;
    if (!op.finished) continue;
    const ok = op.done - op.failed;
    selected.clear();
    if (kind === 'copy') {
      dialog(
        op.failed ? `Skopiowano ${ok} z ${op.total}` : `Skopiowano ${photos(ok)}`,
        op.failed ? `Nie udało się skopiować ${photos(op.failed)}: ${op.error || 'nieznany błąd'}. Pozostałe są w folderze Pobrane.` : 'Zdjęcia są w folderze Pobrane — możesz je teraz wybrać w przeglądarce lub programie.',
        [
          { label: 'Otwórz Pobrane', onClick: () => (api('/api/open-downloads').catch(() => {}), closeDialog()) },
          { label: 'Gotowe', cls: 'primary', onClick: closeDialog },
        ],
      );
      renderGrid();
    } else {
      dialog(
        op.failed ? `Usunięto ${ok} z ${op.total}` : `Usunięto ${photos(ok)} z telefonu`,
        op.failed ? `Nie udało się usunąć ${photos(op.failed)}: ${op.error || 'nieznany błąd'}.` : '',
        [{ label: 'Gotowe', cls: 'primary', onClick: closeDialog }],
      );
      await loadItems();
    }
    return;
  }
}

$('copy').onclick = () => runOp('copy', [...selected]);
$('delete').onclick = () => {
  const n = selected.size;
  dialog(`Usunąć ${photos(n)} z telefonu?`, 'Zdjęcia znikną z telefonu na stałe — tej operacji nie można cofnąć. Jeśli chcesz je zachować, najpierw skopiuj je do Pobranych.', [
    { label: 'Anuluj', onClick: closeDialog },
    { label: `Usuń ${photos(n)}`, cls: 'danger', onClick: () => runOp('delete', [...selected]) },
  ]);
};

// ---------- start ----------
show('empty');
pollDevices();
setInterval(pollDevices, 2500);
setInterval(() => api('/api/ping').catch(() => {}), 10000);
