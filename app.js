'use strict';

/* =========================================================
   1) 記録する項目の設定
   ここに1行足すだけで、入力欄・一覧・詳細表示が増えます。
   type: 'text' | 'textarea' | 'number' | 'select' | 'date' | 'checkbox'
   ========================================================= */
const FIELDS = [
  { key: 'memo', label: 'メモ', type: 'textarea', placeholder: '見たこと、気づいたこと' },
  // ↓ 使いたい行の「//」を消すと項目が増えます
  // { key: 'title',   label: 'タイトル', type: 'text' },
  // { key: 'temp',    label: '気温',     type: 'number', unit: '℃', step: 0.1 },
  // { key: 'weather', label: '天気',     type: 'select', options: ['晴れ', 'くもり', '雨', '雪'] },
  // { key: 'done',    label: '対応済み', type: 'checkbox' },
];

const PHOTO_MAX_SIZE = 1600;  // 写真の長辺(px)。小さくすると容量が減る
const PHOTO_QUALITY = 0.82;   // JPEG画質 0〜1

/* =========================================================
   2) データ保存（IndexedDB：ブラウザ内のデータベース）
   records … 記録本体（日時・場所・項目の値・写真ID）
   photos  … 写真の画像データ
   ========================================================= */
const DB_NAME = 'field-notes';
const DB_VERSION = 1;
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbGetAll(storeName) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const req = d.transaction(storeName).objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, id) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const req = d.transaction(storeName).objectStore(storeName).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// 複数の書き込みを「全部成功 or 全部失敗」でまとめて行う
async function dbWrite(fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(['records', 'photos'], 'readwrite');
    fn(t.objectStore('records'), t.objectStore('photos'));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/* =========================================================
   3) 小さな道具
   ========================================================= */
const $ = (sel) => document.querySelector(sel);
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : Date.now().toString(36) + Math.random().toString(36).slice(2));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.flat().forEach((c) => c != null && node.append(c));
  return node;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function hasValue(v) { return v !== null && v !== undefined && v !== '' && v !== false; }

function formatValue(f, v) {
  if (!hasValue(v)) return null;
  if (f.type === 'checkbox') return 'はい';
  return String(v) + (f.unit ? ` ${f.unit}` : '');
}

/* =========================================================
   4) 写真の縮小（そのままだと1枚数MBになるため）
   ========================================================= */
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function compressImage(file) {
  const { img, url } = await loadImage(file);
  try {
    const scale = Math.min(1, PHOTO_MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * scale);
    const h = Math.round(img.naturalHeight * scale);
    const canvas = el('canvas', { width: w, height: h });
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', PHOTO_QUALITY));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* =========================================================
   5) 入力欄を FIELDS から自動で作る
   ========================================================= */
function renderFields(container) {
  container.replaceChildren();
  FIELDS.forEach((f) => {
    const label = el('span', { className: 'field-label', textContent: f.label + (f.unit ? `（${f.unit}）` : '') });
    let input;
    if (f.type === 'textarea') {
      input = el('textarea', { rows: 5 });
    } else if (f.type === 'select') {
      input = el('select', {},
        ['', ...(f.options || [])].map((o) => el('option', { value: o, textContent: o || '選んでください' })));
    } else {
      input = el('input', { type: f.type || 'text' });
      if (f.step) input.step = f.step;
      if (f.type === 'number') input.inputMode = 'decimal';
    }
    input.name = f.key;
    if (f.placeholder) input.placeholder = f.placeholder;

    const wrap = el('label', { className: f.type === 'checkbox' ? 'field field-check' : 'field' });
    if (f.type === 'checkbox') wrap.append(input, label);
    else wrap.append(label, input);
    container.append(wrap);
  });
}

function readFields(container) {
  const values = {};
  FIELDS.forEach((f) => {
    const input = container.querySelector(`[name="${f.key}"]`);
    if (!input) return;
    if (f.type === 'checkbox') values[f.key] = input.checked;
    else if (f.type === 'number') values[f.key] = input.value === '' ? null : Number(input.value);
    else values[f.key] = input.value.trim();
  });
  return values;
}

/* =========================================================
   6) 新しい記録（入力画面）
   ========================================================= */
let draft = null; // { createdAt, location, locState, locPromise, photos: [{id, blob, url}] }

function openForm() {
  draft = { createdAt: new Date(), location: null, locState: 'idle', locPromise: null, photos: [] };
  $('#formTime').textContent = `${fmtDay(draft.createdAt)} ${fmtTime(draft.createdAt)}`;
  renderFields($('#fieldsArea'));
  renderDraftPhotos();
  $('#saveBtn').disabled = false;
  $('#saveBtn').textContent = '保存';
  showView('formView');
  requestLocation();
}

function discardDraft() {
  if (draft) draft.photos.forEach((p) => URL.revokeObjectURL(p.url));
  draft = null;
}

function requestLocation() {
  const current = draft;
  if (!('geolocation' in navigator)) { setLoc('unsupported'); return; }
  setLoc('loading');
  current.locPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (draft === current) {
          draft.location = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
          };
          setLoc('ok');
        }
        resolve();
      },
      (err) => {
        if (draft === current) setLoc(err.code === 1 ? 'denied' : 'error');
        resolve();
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

function setLoc(state) {
  if (!draft) return;
  draft.locState = state;
  const text = {
    loading: '取得しています…',
    ok: draft.location && `${draft.location.lat.toFixed(5)}, ${draft.location.lng.toFixed(5)}（誤差 約${draft.location.accuracy}m）`,
    denied: '位置情報が許可されていません。ブラウザの設定で許可すると記録できます',
    error: '取得できませんでした',
    unsupported: 'この端末では使えません',
  }[state];
  $('#locStatus').textContent = text || '';
  $('#locRetry').hidden = !(state === 'denied' || state === 'error');
}

async function addFiles(files) {
  for (const file of files) {
    try {
      const blob = await compressImage(file);
      if (!draft) return;
      draft.photos.push({ id: uid(), blob, url: URL.createObjectURL(blob) });
    } catch {
      toast('この写真は読み込めませんでした');
    }
  }
  renderDraftPhotos();
}

function renderDraftPhotos() {
  const box = $('#photoPreview');
  box.replaceChildren();
  if (!draft) return;
  draft.photos.forEach((p, i) => {
    const remove = el('button', { type: 'button', textContent: '×', ariaLabel: `${i + 1}枚目の写真を外す` });
    remove.addEventListener('click', () => {
      URL.revokeObjectURL(p.url);
      draft.photos = draft.photos.filter((x) => x !== p);
      renderDraftPhotos();
    });
    box.append(el('div', { className: 'thumb' }, el('img', { src: p.url, alt: '' }), remove));
  });
}

async function saveDraft() {
  if (!draft) return;
  const values = readFields($('#fieldsArea'));
  if (!draft.photos.length && !Object.values(values).some(hasValue)) {
    toast('写真かメモを入れてください');
    return;
  }
  const btn = $('#saveBtn');
  btn.disabled = true;

  // 位置情報の取得中なら最大5秒だけ待つ
  if (draft.locState === 'loading' && draft.locPromise) {
    btn.textContent = '位置を待っています';
    await Promise.race([draft.locPromise, sleep(5000)]);
  }
  if (!draft) return;

  const record = {
    id: uid(),
    schema: 1,                                // データ形式の版（将来の変更用）
    createdAt: draft.createdAt.toISOString(),
    location: draft.location,                 // {lat, lng, accuracy} または null
    values,                                   // FIELDS の各項目
    photoIds: draft.photos.map((p) => p.id),
  };
  const photos = draft.photos.map((p) => ({ id: p.id, recordId: record.id, blob: p.blob }));

  try {
    await dbWrite((records, photoStore) => {
      photos.forEach((p) => photoStore.put(p));
      records.put(record);
    });
  } catch {
    btn.disabled = false;
    btn.textContent = '保存';
    toast('保存できませんでした。端末の空き容量を確認してください');
    return;
  }

  // ブラウザに「このデータを勝手に消さないで」とお願いする
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  toast('保存しました');
  history.back();
  renderList();
}

/* =========================================================
   7) 一覧
   ========================================================= */
let listUrls = [];

function summaryText(rec) {
  for (const f of FIELDS) {
    const v = formatValue(f, rec.values && rec.values[f.key]);
    if (v) return { text: (f.type === 'textarea' || f.type === 'text') ? v : `${f.label}：${v}`, empty: false };
  }
  return { text: rec.photoIds.length ? '写真のみ' : '（内容なし）', empty: true };
}

async function renderList() {
  listUrls.forEach((u) => URL.revokeObjectURL(u));
  listUrls = [];

  const records = (await dbGetAll('records')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#count').textContent = records.length ? `${records.length}件` : '';
  $('#empty').hidden = records.length > 0;

  const list = $('#list');
  list.replaceChildren();
  const thumbJobs = [];
  let lastDay = '';

  records.forEach((rec) => {
    const d = new Date(rec.createdAt);
    const day = fmtDay(d);
    if (day !== lastDay) {
      list.append(el('h2', { className: 'day', textContent: day }));
      lastDay = day;
    }
    const s = summaryText(rec);
    const meta = [];
    if (rec.photoIds.length > 1) meta.push(`写真${rec.photoIds.length}枚`);
    if (rec.location) meta.push('位置あり');

    const thumb = rec.photoIds.length ? el('img', { className: 'entry-thumb', alt: '' }) : el('span');
    const item = el('button', { className: 'entry', type: 'button' },
      el('span', { className: 'entry-time', textContent: fmtTime(d) }),
      el('span', { className: 'entry-main' },
        el('span', { className: 'entry-text' + (s.empty ? ' placeholder' : ''), textContent: s.text }),
        meta.length ? el('span', { className: 'entry-meta', textContent: meta.join('、') }) : null),
      thumb);
    item.addEventListener('click', () => openDetail(rec.id));
    list.append(item);
    if (rec.photoIds.length) thumbJobs.push([thumb, rec.photoIds[0]]);
  });

  // サムネイルは後から順に読み込む
  for (const [img, id] of thumbJobs) {
    const p = await dbGet('photos', id);
    if (p) {
      const u = URL.createObjectURL(p.blob);
      listUrls.push(u);
      img.src = u;
    }
  }
}

/* =========================================================
   8) 詳細
   ========================================================= */
let detailUrls = [];
let detailRecord = null;

async function openDetail(id) {
  const rec = await dbGet('records', id);
  if (!rec) return;
  detailRecord = rec;
  const d = new Date(rec.createdAt);
  $('#detailTitle').textContent = `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`;

  const body = $('#detailBody');
  body.replaceChildren();

  const photosBox = el('div', { className: 'detail-photos' });
  for (const pid of rec.photoIds) {
    const p = await dbGet('photos', pid);
    if (!p) continue;
    const u = URL.createObjectURL(p.blob);
    detailUrls.push(u);
    photosBox.append(el('img', { src: u, alt: '記録した写真' }));
  }
  if (photosBox.children.length) body.append(photosBox);

  const rows = [['日時', `${fmtDay(d)} ${fmtTime(d)}`]];
  if (rec.location) {
    const { lat, lng, accuracy } = rec.location;
    const link = el('a', {
      className: 'map-link',
      href: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      target: '_blank', rel: 'noopener',
      textContent: '地図で見る',
    });
    rows.push(['場所', [`${lat.toFixed(5)}, ${lng.toFixed(5)}（誤差 約${accuracy}m） `, link]]);
  } else {
    rows.push(['場所', '記録なし']);
  }
  FIELDS.forEach((f) => {
    const v = formatValue(f, rec.values && rec.values[f.key]);
    if (v) rows.push([f.label, v]);
  });

  body.append(el('dl', { className: 'meta' },
    rows.map(([k, v]) => el('div', { className: 'meta-row' },
      el('dt', { textContent: k }),
      el('dd', { className: 'detail-value' }, v)))));

  showView('detailView');
}

function closeDetail() {
  detailUrls.forEach((u) => URL.revokeObjectURL(u));
  detailUrls = [];
  detailRecord = null;
}

async function deleteCurrent() {
  if (!detailRecord) return;
  if (!confirm('この記録を削除しますか？写真も一緒に消えます。')) return;
  const rec = detailRecord;
  await dbWrite((records, photos) => {
    rec.photoIds.forEach((id) => photos.delete(id));
    records.delete(rec.id);
  });
  toast('削除しました');
  history.back();
  renderList();
}

/* =========================================================
   9) 画面の切り替え（スマホの「戻る」でも閉じられるように）
   ========================================================= */
function showView(id) {
  $('#' + id).hidden = false;
  $('#' + id).scrollTop = 0;
  history.pushState({ view: id }, '');
}

window.addEventListener('popstate', () => {
  if (!$('#formView').hidden) { $('#formView').hidden = true; discardDraft(); }
  if (!$('#detailView').hidden) { $('#detailView').hidden = true; closeDetail(); }
});

/* =========================================================
   10) バックアップ（書き出し・読み込み）
   ========================================================= */
const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

async function exportAll() {
  const records = await dbGetAll('records');
  const photos = await dbGetAll('photos');
  const data = {
    app: 'field-notes',
    version: 1,
    exportedAt: new Date().toISOString(),
    records,
    photos: await Promise.all(photos.map(async (p) => ({ id: p.id, recordId: p.recordId, dataUrl: await blobToDataURL(p.blob) }))),
  };
  const now = new Date();
  const name = `field-notes-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });

  // iPhone などでは共有メニューで保存（ファイルAppやGoogleドライブへ）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = el('a', { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('ファイルを読めませんでした'); return; }
  if (!data || data.app !== 'field-notes' || !Array.isArray(data.records)) {
    toast('このアプリのバックアップではありません');
    return;
  }
  const photos = await Promise.all((data.photos || []).map(async (p) => ({
    id: p.id, recordId: p.recordId, blob: await (await fetch(p.dataUrl)).blob(),
  })));
  await dbWrite((records, photoStore) => {
    photos.forEach((p) => photoStore.put(p));
    data.records.forEach((r) => records.put(r)); // 同じIDは上書き、新しいものは追加
  });
  toast(`${data.records.length}件を読み込みました`);
  renderList();
}

async function showStorageInfo() {
  const info = $('#storageInfo');
  info.textContent = '';
  if (navigator.storage && navigator.storage.estimate) {
    const { usage = 0 } = await navigator.storage.estimate();
    info.textContent = `使用中の容量：約${(usage / 1024 / 1024).toFixed(1)}MB`;
  }
}

/* =========================================================
   11) ボタンをつなぐ
   ========================================================= */
$('#newBtn').addEventListener('click', openForm);
$('#cancelBtn').addEventListener('click', () => {
  const dirty = draft && (draft.photos.length || Object.values(readFields($('#fieldsArea'))).some(hasValue));
  if (dirty && !confirm('入力中の内容を破棄しますか？')) return;
  history.back();
});
$('#saveBtn').addEventListener('click', saveDraft);
$('#locRetry').addEventListener('click', requestLocation);
['#cameraInput', '#pickInput'].forEach((sel) => {
  $(sel).addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = ''; // 同じ写真をもう一度選べるように
    await addFiles(files);
  });
});
$('#backBtn').addEventListener('click', () => history.back());
$('#deleteBtn').addEventListener('click', deleteCurrent);

$('#menuBtn').addEventListener('click', () => { showStorageInfo(); $('#menu').showModal(); });
$('#menuClose').addEventListener('click', () => $('#menu').close());
$('#exportBtn').addEventListener('click', () => exportAll().catch(() => toast('書き出しに失敗しました')));
$('#importBtn').addEventListener('click', () => $('#importInput').click());
$('#importInput').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) { $('#menu').close(); await importFile(f).catch(() => toast('読み込みに失敗しました')); }
});

renderList();

// オフラインでも開けるようにする（PWAの仕組み）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
