// Trip Photo Sorter - the whole app runs on this page: find the phone, pick the trip dates,
// copy, sort with CLIP (an image/text AI model running in the browser), review, and
// optionally delete from the phone. SortTrip.ps1 does the file work behind /api/*.
// Photos never leave the laptop: only the model files are downloaded (once, then cached).
import {
  AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage, env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.allowLocalModels = false;

const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DUPLICATE_WINDOW = 12;        // compare each photo with the previous N (bursts sit next to each other)
const PILE_SIZE = 140;              // real thumbnails shown in "a total mess"
const THUMB = 128;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const TRASH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

const state = {
  stage: 'setup',
  devices: [],          // phones, memory cards, USB sticks: { id, name, kind, ready }
  deviceId: null,       // the one the photos come from
  watching: false,
  session: null,
  settings: null,
  items: [],            // { file, thumb, folder, embedding }
  folders: new Map(),   // folder path -> { label, kind, card }
  pileTiles: new Map(), // file id -> tile element
  spareTiles: [],
  sorted: 0,
  finished: false,
  closed: false,
  prefs: null,          // { folders: [category names], separateVideos }
};

// ------------------------------------------------------------------ which folders to make

const SIMPLE_FOLDERS = ['Me & selfies', 'Group photos', 'Nature', 'Food & cafés', 'Travel & vibe', 'Screenshots'];
const PREFS_KEY = 'trip-photo-sorter.folders';

function loadPrefs(categories) {
  const names = categories.map((c) => c.folder);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)); } catch { /* storage blocked */ }
  const simple = names.filter((n) => SIMPLE_FOLDERS.includes(n));
  const folders = (saved?.folders ?? (simple.length ? simple : names)).filter((n) => names.includes(n));
  return { folders, separateVideos: Boolean(saved?.separateVideos) };
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)); } catch { /* storage blocked */ }
}

function renderFolderChips() {
  const chosen = new Set(state.prefs.folders);
  $('#folderChips').innerHTML = state.settings.categories
    .map((c) => `<button type="button" data-folder="${escapeHtml(c.folder)}" class="${chosen.has(c.folder) ? 'on' : ''}">${escapeHtml(c.folder)}</button>`).join('');
  const count = chosen.size + 1;
  $('#folderNote').textContent = `${plural(count, 'folder')} at most — anything else goes into “${state.settings.otherFolder}”.`;
  $('#separateVideos').checked = state.prefs.separateVideos;
}

function chooseFolders(folders) {
  // Keep the settings.json order so folders always appear in the same place.
  state.prefs.folders = state.settings.categories.map((c) => c.folder).filter((n) => folders.includes(n));
  savePrefs();
  renderFolderChips();
}

// ------------------------------------------------------------------ talking to SortTrip.ps1

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// Long jobs answer with one JSON object per line as they go.
async function* stream(url, body) {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

// ------------------------------------------------------------------ small helpers

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const setStatus = (html) => { $('#status').innerHTML = html; };
const setBar = (fraction) => { $('#bar').style.width = `${Math.round(Math.min(1, fraction) * 100)}%`; };
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatDuration(seconds) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

function normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const n = Math.sqrt(sum) || 1;
  return vec.map((v) => v / n);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function rows(tensor) {
  if (tensor.type !== 'float32') tensor = tensor.to('float32');
  const [count, dim] = tensor.dims;
  return Array.from({ length: count }, (_, i) => normalize(Array.from(tensor.data.subarray(i * dim, (i + 1) * dim))));
}

function setTitle(lead, name, tail = 'photos') {
  $('#titleLead').textContent = lead;
  $('#tripName').textContent = name;
  $('#titleTail').textContent = tail;
}

function showSetupPanel(name) {
  for (const id of ['setupForm', 'scanPanel', 'foundPanel']) $(`#${id}`).hidden = id !== name;
}

function showBoard() {
  $('#setupView').hidden = true;
  $('#board').hidden = false;
  $('#stats').hidden = false;
}

// ------------------------------------------------------------------ 1. start screen

function defaultTripName() {
  const from = parseDay($('#fromDate').value);
  const until = parseDay($('#untilDate').value);
  const month = (d) => d.toLocaleDateString(undefined, { month: 'short' });
  if (isNaN(from) || isNaN(until)) return `Trip ${isoDay(new Date())}`;
  if (isoDay(from) === isoDay(until)) return `Trip ${from.getDate()} ${month(from)} ${from.getFullYear()}`;
  const start = from.getMonth() === until.getMonth() ? `${from.getDate()}` : `${from.getDate()} ${month(from)}`;
  return `Trip ${start}–${until.getDate()} ${month(until)} ${until.getFullYear()}`;
}

function setRange(days) {
  const until = new Date();
  const from = new Date();
  from.setDate(until.getDate() - (days - 1));
  $('#fromDate').value = isoDay(from);
  $('#untilDate').value = isoDay(until);
  for (const chip of document.querySelectorAll('#rangeChips button')) chip.classList.toggle('on', Number(chip.dataset.days) === days);
  $('#tripInput').placeholder = defaultTripName();
}

const shortName = (name) => name.replace(/^Apple /, '');
const selectedDevice = () => state.devices.find((d) => d.id === state.deviceId);

function deviceLabel(device) {
  if (device.ready) return `${device.kind === 'phone' ? device.name : `${device.name[0].toUpperCase()}${device.name.slice(1)}`} connected`;
  return /iphone|ipad/i.test(device.name)
    ? `Unlock your ${shortName(device.name)} and tap “Trust”`
    : `Unlock your ${device.name} and choose “File transfer”`;
}

// One chip per phone, memory card or USB stick; with several, click one to choose it.
function updateDevices(devices) {
  state.devices = devices ?? [];
  if (!selectedDevice()?.ready) state.deviceId = state.devices.find((d) => d.ready)?.id ?? null;
  const box = $('#devices');
  box.classList.toggle('many', state.devices.length > 1);
  box.innerHTML = state.devices.length
    ? state.devices.map((d) => `<button type="button" class="phone-chip" role="radio" aria-checked="${d.id === state.deviceId}" data-id="${escapeHtml(d.id)}" data-state="${d.ready ? 'ready' : 'locked'}"><span class="pulse"></span><span>${escapeHtml(deviceLabel(d))}</span></button>`).join('')
    : '<span class="phone-chip" data-state="none"><span class="pulse"></span><span>Plug in your phone, memory card or USB stick</span></span>';
  const ready = Boolean(selectedDevice()?.ready);
  $('#findBtn').disabled = !ready;
  $('#findBtn').textContent = ready ? 'Find my trip photos' : 'Waiting for your phone or card…';
}

async function watchDevices() {
  if (state.watching) return;
  state.watching = true;
  while (!state.closed && ['setup', 'found'].includes(state.stage)) {
    try {
      const status = await getJson('/api/status');
      if (!['setup', 'found'].includes(state.stage)) break;
      updateDevices(status.devices);
      $('#saveNote').textContent = `Saved to ${status.tripsRoot} — your photos never leave this laptop.`;
    } catch { /* server busy or restarting */ }
    await sleep(2500);
  }
  state.watching = false;
}

async function scan(body) {
  state.stage = 'scanning';
  $('#scanError').hidden = true;
  showSetupPanel('scanPanel');
  $('#scanText').textContent = body.mode === 'folder' ? 'Looking through the folder…' : `Looking through your ${shortName(selectedDevice()?.name ?? 'phone')}…`;
  try {
    for await (const msg of stream('/api/scan', body)) {
      if (msg.type === 'progress' && msg.found) $('#scanText').textContent = `Found ${plural(msg.found, 'photo or video', 'photos and videos')} so far…`;
      if (msg.type === 'error') throw new Error(msg.message);
      if (msg.type === 'done') showFound(msg, body.mode);
    }
  } catch (err) {
    state.stage = 'setup';
    showSetupPanel('setupForm');
    $('#scanError').textContent = err.message;
    $('#scanError').hidden = false;
    watchDevices();
  }
}

function showFound(summary, mode) {
  state.stage = 'found';
  showSetupPanel('foundPanel');
  state.scanMode = mode;
  const folderName = mode === 'folder' ? (summary.where || '').split('\\').filter(Boolean).pop() : '';
  $('#foundWhere').textContent = mode === 'folder' ? `Found in “${folderName}”` : `Found on your ${shortName(summary.where || 'phone')}`;
  $('#foundWhere').title = summary.where || '';
  $('#foundPhotos').textContent = summary.photos.toLocaleString();
  $('#foundVideos').textContent = summary.videos.toLocaleString();
  const meta = [formatBytes(summary.bytes || 0)];
  if (summary.skipped) meta.push(`${plural(summary.skipped, 'file')} you already copied are skipped`);
  const nothing = mode === 'folder'
    ? `No photos or videos in ${summary.where} or the folders inside it. Try another folder.`
    : 'Nothing found for those dates. Try other dates.';
  $('#foundMeta').textContent = summary.total ? meta.join(' · ') : nothing;
  $('#changeBtn').textContent = mode === 'folder' ? 'Choose another folder' : 'Change dates';

  const days = summary.days.length <= 31 ? summary.days : [];
  const max = Math.max(1, ...days.map((d) => d.count));
  $('#dayBars').innerHTML = days.map((d) => {
    const date = parseDay(d.date);
    return `<div class="day" title="${date.toDateString()}: ${d.count}"><span class="n">${d.count}</span><span class="col" style="height:${Math.round((d.count / max) * 56)}px"></span><span class="d">${date.getDate()}</span></div>`;
  }).join('');
  $('#dayBars').hidden = !days.length;
  $('#copyBtn').disabled = !summary.total;
  $('#copyBtn').textContent = summary.total ? `Copy ${plural(summary.total, 'file')} to my laptop & sort` : 'Nothing to copy';
  watchDevices();
}

async function copyAndSort() {
  const trip = $('#tripInput').value.trim() || defaultTripName();
  state.stage = 'copying';
  setTitle('Sorting my', trip);
  showBoard();
  setStatus('Copying your photos to the laptop…');
  try {
    for await (const msg of stream('/api/copy', { trip })) {
      if (msg.type === 'progress') {
        setBar(msg.done / msg.total);
        setStatus(`Copying ${msg.done.toLocaleString()} of ${msg.total.toLocaleString()} to your laptop…`);
      }
      if (msg.type === 'done' && msg.failed) console.warn(`${msg.failed} files could not be copied`);
    }
    await startSorting();
  } catch (err) {
    setStatus(`Copying stopped: ${escapeHtml(err.message)}<br>Nothing was deleted anywhere.`);
  }
}

// ------------------------------------------------------------------ 2. folders, cards and the pile

// <trip>\Nature\ by default; <trip>\Photos\Nature\ and <trip>\Videos\Nature\ when videos are kept apart.
function folderFor(kind, label) {
  if (!state.prefs.separateVideos) return label;
  return `${kind === 'video' ? 'Videos' : 'Photos'}/${label}`;
}

function addFolder(path, label, kind, container, extraClass = '') {
  const card = document.createElement('button');
  card.className = `card ${extraClass}`;
  card.innerHTML = `<div class="card-head">${extraClass === 'trash' ? TRASH_ICON : FOLDER_ICON}<span class="name">${escapeHtml(label)}</span><span class="count">0</span></div><div class="strip"><span class="ph"></span><span class="ph"></span><span class="ph"></span></div>`;
  card.addEventListener('click', () => openFolder(path));
  container.appendChild(card);
  state.folders.set(path, { label, kind, card });
}

function buildFolders() {
  const { settings, session, prefs } = state;
  const labels = [...prefs.folders, settings.otherFolder];
  $('#photoCards').innerHTML = '';
  if (!prefs.separateVideos) {
    // One set of folders for photos and videos together.
    labels.forEach((label) => addFolder(folderFor('photo', label), label, 'all', $('#photoCards')));
    $('#photosHeading').innerHTML = '<i class="dot"></i>Folders';
    $('#videoColumn').hidden = true;
    $('#board').classList.add('no-videos');
  } else {
    labels.forEach((label) => addFolder(folderFor('photo', label), label, 'photo', $('#photoCards')));
    if (session.files.some((f) => f.kind === 'video')) {
      $('#videoCards').innerHTML = '';
      labels.forEach((label) => addFolder(folderFor('video', label), label, 'video', $('#videoCards')));
      for (const f of state.folders.values()) if (f.kind === 'video') f.card.hidden = true;
    } else {
      $('#videoColumn').hidden = true;
      $('#board').classList.add('no-videos');
    }
  }
  addFolder(settings.duplicatesFolder, `${settings.duplicatesFolder.replace(/ - to trash$/i, '')} → trash`, 'any', $('#specialCards'), 'trash');
}

function renderFolder(path) {
  const folder = state.folders.get(path);
  if (!folder) return;
  const members = state.items.filter((it) => it.folder === path);
  folder.card.querySelector('.count').textContent = members.length;
  if (folder.kind === 'video') folder.card.hidden = members.length === 0;
  const shown = members.slice(-6).map((it) => `<img src="${it.thumb}" alt="">`).join('');
  const more = members.length > 6 ? `<span class="more">+${members.length - 6}</span>` : '';
  folder.card.querySelector('.strip').innerHTML = shown ? shown + more : '<span class="ph"></span><span class="ph"></span><span class="ph"></span>';
}

function renderStats() {
  const counted = state.items.filter((it) => it.folder);
  $('#statPhotos').textContent = counted.filter((it) => it.file.kind !== 'video').length.toLocaleString();
  $('#statVideos').textContent = counted.filter((it) => it.file.kind === 'video').length.toLocaleString();
  $('#statFolders').textContent = new Set(counted.map((it) => it.folder)).size;
}

function pilePosition(size) {
  const angle = Math.random() * Math.PI * 2;
  const radius = Math.sqrt(Math.random()) * (size / 2 - 26);
  return [size / 2 + Math.cos(angle) * radius - 20, size / 2 + Math.sin(angle) * radius - 20];
}

function addTile(src, fileId) {
  const pile = $('#pile');
  const [x, y] = pilePosition(pile.clientWidth || 360);
  const tile = document.createElement(src ? 'img' : 'span');
  tile.className = 'tile';
  if (src) tile.src = src;
  tile.style.left = `${x}px`;
  tile.style.top = `${y}px`;
  tile.style.rotate = `${Math.random() * 50 - 25}deg`;
  tile.style.animationDelay = `${Math.random() * 0.25}s`;
  pile.appendChild(tile);
  if (fileId === undefined) state.spareTiles.push(tile); else state.pileTiles.set(fileId, tile);
}

// "A total mess": small real thumbnails of a sample of the trip, made while the AI loads.
async function buildPile(files) {
  const photos = files.filter((f) => f.kind === 'photo' && !['.heic', '.heif'].includes(f.ext));
  const step = Math.max(1, photos.length / PILE_SIZE);
  for (let i = 0; i < photos.length && state.pileTiles.size < PILE_SIZE; i += step) {
    const file = photos[Math.floor(i)];
    try {
      const blob = await (await fetch(`/media/${file.id}`)).blob();
      const bitmap = await createImageBitmap(blob, { resizeWidth: 96, resizeQuality: 'low' });
      const side = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 80;
      canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 80, 80);
      bitmap.close();
      addTile(canvas.toDataURL('image/jpeg', 0.7), file.id);
    } catch { /* skip files the browser can't open */ }
  }
  // Videos and the rest of a big trip appear as plain tiles.
  const extra = Math.min(files.length, PILE_SIZE + 40) - state.pileTiles.size;
  for (let i = 0; i < extra; i++) addTile(null);
}

function takeFromPile(fileId) {
  const total = state.session.files.length;
  let start = null;
  const own = state.pileTiles.get(fileId);
  if (own) {
    start = own.getBoundingClientRect();
    own.classList.add('gone');
    state.pileTiles.delete(fileId);
  }
  // Keep the pile shrinking evenly even when this file had no tile of its own.
  const left = state.pileTiles.size + state.spareTiles.length;
  const keep = Math.round((PILE_SIZE + 40) * (1 - state.sorted / total));
  if (left > keep && state.spareTiles.length) {
    const tile = state.spareTiles.splice(Math.floor(Math.random() * state.spareTiles.length), 1)[0];
    start ??= tile.getBoundingClientRect();
    tile.classList.add('gone');
  }
  $('#pileCaption').textContent = state.sorted < total ? `a total mess · ${(total - state.sorted).toLocaleString()} left` : 'all sorted ✨';
  if (state.sorted >= total) for (const tile of $('#pile').children) tile.classList.add('gone');
  return start ?? $('#pile').getBoundingClientRect();
}

function fly(item, fromRect) {
  const folder = state.folders.get(item.folder);
  if (reduceMotion || !folder || document.hidden) { renderFolder(item.folder); return; }
  const to = folder.card.querySelector('.strip').getBoundingClientRect();
  const img = new Image();
  img.src = item.thumb;
  img.className = 'flyer';
  document.body.appendChild(img);
  const sx = fromRect.left + fromRect.width / 2 - 20, sy = fromRect.top + fromRect.height / 2 - 20;
  const mx = (sx + to.left) / 2, my = Math.min(sy, to.top) - 60;
  img.animate([
    { transform: `translate(${sx}px, ${sy}px) rotate(${Math.random() * 40 - 20}deg) scale(1.2)` },
    { transform: `translate(${mx}px, ${my}px) rotate(0deg) scale(1.35)`, offset: 0.45 },
    { transform: `translate(${to.left}px, ${to.top}px) rotate(0deg) scale(0.8)` },
  ], { duration: 800, easing: 'cubic-bezier(.35,.6,.25,1)' }).finished.then(() => {
    img.remove();
    renderFolder(item.folder);
    folder.card.classList.remove('pulse');
    void folder.card.offsetWidth;
    folder.card.classList.add('pulse');
  });
}

// ------------------------------------------------------------------ 3. the AI model

async function loadModel(modelId) {
  const loaded = new Map();
  const onProgress = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    loaded.set(p.file, [p.loaded, p.total]);
    let have = 0, total = 0;
    for (const [l, t] of loaded.values()) { have += l; total += t; }
    setStatus(`Downloading the AI… ${Math.round((100 * have) / total)}% of ${Math.round(total / 1e6)} MB<br><span class="muted small">First time only — after this it's ready instantly.</span>`);
    setBar(have / total);
  };

  // The text model only runs once (for the category prompts), so it always uses the small CPU version.
  // The image model runs for every photo: half precision on the graphics chip when possible.
  const tryDevice = async (device) => {
    const visionOptions = { device, dtype: device === 'webgpu' ? 'fp16' : 'q8', progress_callback: onProgress };
    const [processor, tokenizer, vision, text] = await Promise.all([
      AutoProcessor.from_pretrained(modelId, { progress_callback: onProgress }),
      AutoTokenizer.from_pretrained(modelId, { progress_callback: onProgress }),
      CLIPVisionModelWithProjection.from_pretrained(modelId, visionOptions),
      CLIPTextModelWithProjection.from_pretrained(modelId, { device: 'wasm', dtype: 'q8', progress_callback: onProgress }),
    ]);
    return { processor, tokenizer, vision, text, device };
  };

  let gpu = false;
  try { gpu = Boolean((await navigator.gpu?.requestAdapter())?.features.has('shader-f16')); } catch { /* no WebGPU */ }
  if (gpu) {
    try { return await tryDevice('webgpu'); } catch (err) { console.warn('WebGPU failed, using CPU', err); }
  }
  return tryDevice('wasm');
}

async function embedCategories(ai, categories) {
  const prompts = categories.flatMap((c) => c.prompts);
  const tokens = ai.tokenizer(prompts, { padding: true, truncation: true });
  const vectors = rows((await ai.text(tokens)).text_embeds);
  let i = 0;
  return categories.map((c) => {
    const mine = vectors.slice(i, (i += c.prompts.length));
    return normalize(mine[0].map((_, d) => mine.reduce((sum, v) => sum + v[d], 0)));
  });
}

async function embedImage(ai, canvas) {
  const inputs = await ai.processor(RawImage.fromCanvas(canvas));
  return rows((await ai.vision(inputs)).image_embeds)[0];
}

// ------------------------------------------------------------------ decoding photos and videos

let heicLib;
function loadHeicLib() {
  heicLib ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    script.onload = () => resolve(window.heic2any);
    script.onerror = () => reject(new Error('could not load the HEIC decoder'));
    document.head.appendChild(script);
  });
  return heicLib;
}

async function photoBitmap(file, blob) {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    if (!['.heic', '.heif'].includes(file.ext)) throw err;
    const heic2any = await loadHeicLib();
    const jpeg = await heic2any({ blob, toType: 'image/jpeg', quality: 0.8 });
    return createImageBitmap(Array.isArray(jpeg) ? jpeg[0] : jpeg);
  }
}

function videoBitmap(url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    const finish = (err, bitmap) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      if (err) reject(err); else resolve(bitmap);
    };
    const timer = setTimeout(() => finish(new Error('video took too long to open')), 20000);
    video.onerror = () => finish(new Error('this browser cannot play this video format'));
    video.onloadedmetadata = () => { video.currentTime = Math.min(1, (video.duration || 2) / 2); };
    video.onseeked = () => {
      if (!video.videoWidth) { finish(new Error('no picture in video')); return; }
      createImageBitmap(video).then((b) => finish(null, b), finish);
    };
    video.src = url;
  });
}

// Small canvas for the AI (shortest side 256 px) plus a square thumbnail.
function toCanvasAndThumb(bitmap) {
  const scale = Math.min(1, 256 / Math.min(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const side = Math.min(canvas.width, canvas.height);
  const thumb = document.createElement('canvas');
  thumb.width = thumb.height = THUMB;
  thumb.getContext('2d').drawImage(canvas, (canvas.width - side) / 2, (canvas.height - side) / 2, side, side, 0, 0, THUMB, THUMB);
  return { canvas, thumb: thumb.toDataURL('image/jpeg', 0.72) };
}

function labelThumb(text) {
  const c = document.createElement('canvas');
  c.width = c.height = THUMB;
  const g = c.getContext('2d');
  g.fillStyle = '#dce6f3'; g.fillRect(0, 0, THUMB, THUMB);
  g.fillStyle = '#74819a'; g.font = '600 22px sans-serif'; g.textAlign = 'center'; g.fillText(text, THUMB / 2, THUMB / 2 + 8);
  return c.toDataURL();
}
const BROKEN_THUMB = labelThumb('?');
const RAW_THUMB = labelThumb('RAW');

// ------------------------------------------------------------------ 4. sorting one file

async function sortFile(ai, categoryVectors, file, seenHashes, recent) {
  const { settings } = state;
  const url = `/media/${file.id}`;
  const item = { file, thumb: BROKEN_THUMB, folder: null, embedding: null, twins: [] };
  try {
    let bitmap;
    if (file.kind === 'video') {
      bitmap = await videoBitmap(url);
    } else {
      const blob = await (await fetch(url)).blob();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      if (seenHashes.has(hash)) item.folder = settings.duplicatesFolder;
      seenHashes.add(hash);
      bitmap = await photoBitmap(file, blob);
    }
    const { canvas, thumb } = toCanvasAndThumb(bitmap);
    item.thumb = thumb;
    if (item.folder) return item;   // exact duplicate

    item.embedding = await embedImage(ai, canvas);
    if (file.kind === 'photo' && recent.some((other) => dot(other, item.embedding) >= settings.duplicateSimilarity)) {
      item.folder = settings.duplicatesFolder;
      return item;
    }
    if (file.kind === 'photo') {
      recent.push(item.embedding);
      if (recent.length > DUPLICATE_WINDOW) recent.shift();
    }

    const chosen = new Set(state.prefs.folders);
    const screenshots = settings.categories.find((c) => c.folder.toLowerCase() === 'screenshots' && chosen.has(c.folder));
    if (file.kind === 'photo' && file.ext === '.png' && settings.pngIsScreenshot && screenshots) {
      item.folder = folderFor('photo', screenshots.folder);   // phones save screenshots as PNG, cameras never do
      return item;
    }

    // CLIP zero-shot: similarity to each category, turned into probabilities.
    const logits = categoryVectors.map((v) => 100 * dot(v, item.embedding));
    const max = Math.max(...logits);
    const exp = logits.map((l) => Math.exp(l - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    const best = logits.indexOf(max);
    // The best match among ALL categories decides; if that folder wasn't picked, the photo goes to Other
    // (rather than being forced into a picked folder it doesn't belong in).
    const winner = settings.categories[best].folder;
    const label = exp[best] / sum >= settings.minConfidence && chosen.has(winner) ? winner : settings.otherFolder;
    item.folder = folderFor(file.kind, label);
  } catch (err) {
    console.warn(`Could not read ${file.name}:`, err);
    item.folder = folderFor(file.kind, settings.otherFolder);
  }
  return item;
}

async function startSorting() {
  state.stage = 'sorting';
  const [session, settings] = await Promise.all([getJson('/api/session'), getJson('/settings.json')]);
  Object.assign(state, { session, settings });
  state.prefs ??= loadPrefs(settings.categories);
  setTitle('Sorting my', session.trip);
  document.title = `Sorting ${session.trip}`;
  showBoard();
  $('#statTotal').textContent = session.files.length.toLocaleString();
  buildFolders();
  setBar(0);
  setStatus('Waking up the AI…');

  const [ai] = await Promise.all([loadModel(settings.aiModel), buildPile(session.files)]);
  const categoryVectors = await embedCategories(ai, settings.categories);
  $('#loader').classList.add('off');

  const seenHashes = new Set();
  const recent = [];
  const started = performance.now();
  const raws = session.files.filter((f) => f.kind === 'raw');
  for (const file of session.files.filter((f) => f.kind !== 'raw')) {
    const item = await sortFile(ai, categoryVectors, file, seenHashes, recent);
    state.items.push(item);
    state.sorted++;
    fly(item, takeFromPile(file.id));
    renderStats();
    const perFile = (performance.now() - started) / 1000 / state.sorted;
    setBar(state.sorted / (session.files.length - raws.length));
    setStatus(`Sorting ${state.sorted.toLocaleString()} of ${session.files.length.toLocaleString()} · ${formatDuration(perFile * (session.files.length - raws.length - state.sorted))} left<br><span class="muted small">AI on the ${ai.device === 'webgpu' ? 'graphics chip' : 'processor'} · photos stay on this laptop</span>`);
  }

  // Camera RAW files (browsers can't open them) follow the JPG with the same name: IMG_0042.CR2 goes
  // wherever IMG_0042.JPG went. A RAW without a JPG twin goes to Other.
  const twinKey = (file) => file.rel.replace(/\.[^./]+$/, '').toLowerCase();
  const byName = new Map(state.items.map((it) => [twinKey(it.file), it]));
  for (const file of raws) {
    const twin = byName.get(twinKey(file));
    const item = { file, thumb: twin?.thumb ?? RAW_THUMB, folder: twin?.folder ?? folderFor('photo', settings.otherFolder), embedding: null, twins: [] };
    twin?.twins.push(item);
    state.items.push(item);
    state.sorted++;
    fly(item, takeFromPile(file.id));
  }
  renderStats();

  state.finished = true;
  state.stage = 'review';
  for (const path of state.folders.keys()) renderFolder(path);
  setStatus('All sorted! Click any folder to check it and fix mistakes.');
  $('#applyBtn').hidden = false;
}

// ------------------------------------------------------------------ 5. review dialog

function folderOptions(kind) {
  return [...state.folders.entries()].filter(([, f]) => f.kind === kind || f.kind === 'any' || f.kind === 'all');
}

function openFolder(path) {
  if (!state.finished) return;
  const folder = state.folders.get(path);
  $('#dialogTitle').textContent = `${folder.label}${folder.kind === 'video' ? ' (videos)' : ''}`;
  const grid = $('#dialogGrid');
  const members = state.items.filter((it) => it.folder === path);
  grid.innerHTML = members.length ? '' : '<p class="empty">Nothing here.</p>';
  for (const item of members) {
    const fig = document.createElement('figure');
    const options = folderOptions(item.file.kind === 'video' ? 'video' : 'photo')
      .map(([p, f]) => `<option value="${escapeHtml(p)}"${p === path ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
    fig.innerHTML = `<img src="${item.thumb}" alt=""><figcaption title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</figcaption><select aria-label="Folder for ${escapeHtml(item.file.name)}" ${state.applied ? 'disabled' : ''}>${options}</select>`;
    fig.querySelector('select').addEventListener('change', (e) => {
      // A photo's RAW twin moves with it.
      for (const moved of [item, ...item.twins]) moved.folder = e.target.value;
      fig.style.opacity = 0.35;
      renderFolder(path);
      renderFolder(item.folder);
      renderStats();
    });
    grid.appendChild(fig);
  }
  $('#folderDialog').showModal();
}

// ------------------------------------------------------------------ 6. move files, report, free up the phone

function reportHtml(css, result) {
  const { session, settings } = state;
  const card = (path, f) => {
    const members = state.items.filter((it) => it.folder === path);
    if (!members.length) return '';
    const href = path.split('/').map(encodeURIComponent).join('/') + '/';
    const thumbs = members.slice(0, 8).map((it) => `<img src="${it.thumb}" alt="">`).join('');
    const more = members.length > 8 ? `<span class="more">+${members.length - 8}</span>` : '';
    const trash = path === settings.duplicatesFolder;
    return `<a class="card${trash ? ' trash' : ''}" href="${href}"><div class="card-head">${trash ? TRASH_ICON : FOLDER_ICON}<span class="name">${escapeHtml(f.label)}</span><span class="count">${members.length}</span></div><div class="strip">${thumbs}${more}</div></a>`;
  };
  const column = (kind) => [...state.folders.entries()].filter(([, f]) => f.kind === kind).map(([p, f]) => card(p, f)).join('');
  const videos = state.items.filter((it) => it.file.kind === 'video').length;
  const photos = state.items.length - videos;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(session.trip)} - sorted photos</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>${css} .board{grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)}</style></head><body>
<header class="top"><div class="brand"><div class="avatar">✓</div><div><div class="eyebrow"><b>Trip Photo Sorter</b> <span class="muted">· ${new Date().toLocaleDateString()}</span></div>
<h1>Sorted my <em>${escapeHtml(session.trip)}</em> photos</h1></div></div>
<div class="stats"><div class="stat"><span class="label">Total files</span><span class="value">${state.items.length}</span></div>
<div class="stat"><span class="label"><i class="dot video"></i>Videos</span><span class="value">${videos}</span></div>
<div class="stat"><span class="label"><i class="dot"></i>Photos</span><span class="value">${photos}</span></div>
<div class="stat"><span class="label">Folders created</span><span class="value">${result.folders}</span></div></div></header>
<main class="board">${state.prefs.separateVideos
    ? `<section><h2><i class="dot"></i>Photos</h2><div class="cards">${column('photo')}</div></section>
<section><h2><i class="dot video"></i>Videos</h2><div class="cards">${column('video') || '<p class="empty">No videos.</p>'}</div>`
    : `<section><h2><i class="dot"></i>Folders</h2><div class="cards">${column('all')}</div></section><section>`}
<h2>Check, then delete</h2><div class="cards">${card(settings.duplicatesFolder, state.folders.get(settings.duplicatesFolder)) || '<p class="empty">No duplicates found.</p>'}</div></section></main>
</body></html>`;
}

async function applySorting() {
  const button = $('#applyBtn');
  button.disabled = true;
  setStatus('Creating folders and moving files…');
  try {
    const assignments = state.items.map((it) => ({ id: it.file.id, folder: it.folder }));
    const result = await postJson('/api/apply', { assignments });
    const css = await (await fetch('/style.css')).text();
    await postJson('/api/report', reportHtml(css, result));
    state.applied = result;
    state.stage = 'done';
    setTitle('Sorted my', state.session.trip);
    button.hidden = true;
    setStatus(`✅ ${plural(result.moved, 'file')} sorted into ${plural(result.folders, 'folder')}.`);
    showDonePanels(result);
  } catch (err) {
    setStatus(`Something went wrong while moving files: ${escapeHtml(err.message)}<br>Nothing on your phone or card was touched.`);
    button.disabled = false;
  }
}

function showDonePanels(result) {
  const actions = $('#actions');
  actions.innerHTML = '';
  const done = document.createElement('div');
  done.className = 'panel ok';
  done.innerHTML = `<h3>Your trip is on your laptop</h3><p><code>${escapeHtml(result.tripDir)}</code></p>
    ${result.leftover ? `<p>${plural(result.leftover, 'file')} stayed in <code>_incoming</code>.</p>` : ''}
    <div class="row"><button class="primary" id="openBtn">Open the folder</button></div>`;
  actions.appendChild(done);
  $('#openBtn').addEventListener('click', () => postJson('/api/open-folder'));

  const { canFreeUp, sourceKind } = state.session;
  const source = shortName(state.session.sourceName ?? 'phone');
  const itsName = sourceKind === 'phone' ? 'phone' : sourceKind === 'drive' && /^usb/i.test(source) ? 'USB stick' : 'card';
  if (canFreeUp && result.deletable > 0) {
    const free = document.createElement('div');
    free.className = 'panel';
    free.id = 'freePanel';
    free.innerHTML = `<h3>Free up space on your ${escapeHtml(source)}?</h3>
      <p>All ${plural(result.deletable, 'file')} were checked: each one is on your laptop with exactly the same size.</p>
      <div class="row"><button class="danger" id="deleteBtn">Delete them from my ${itsName}</button><button class="ghost-btn" id="keepBtn">Keep them</button></div>`;
    actions.appendChild(free);
    $('#deleteBtn').addEventListener('click', () => {
      $('#deleteCount').textContent = result.deletable.toLocaleString();
      $('#deletePhone').textContent = source;
      $('#deleteNote').innerHTML = sourceKind === 'phone'
        ? 'Deleting over the cable is <b>permanent on the phone</b> — they skip “Recently Deleted”.'
        : `Deleting is <b>permanent</b> — a ${itsName} has no Recycle Bin.`;
      $('#deleteConfirm').textContent = `Yes, delete from ${itsName}`;
      $('#deleteDialog').showModal();
    });
    $('#keepBtn').addEventListener('click', () => { free.innerHTML = `<p>OK — nothing was deleted from your ${itsName}.</p>`; });
  }

  const finish = document.createElement('button');
  finish.className = 'ghost-btn';
  finish.textContent = 'Done';
  finish.addEventListener('click', closeApp);
  actions.appendChild(finish);
}

async function deleteFromPhone() {
  $('#deleteDialog').close();
  const panel = $('#freePanel');
  const source = shortName(state.session.sourceName ?? 'phone');
  const isPhone = state.session.sourceKind === 'phone';
  panel.innerHTML = `<h3>Deleting from your ${escapeHtml(source)}…</h3><p id="deleteProgress">Starting…</p><div class="progress"><div class="bar" id="deleteBar"></div></div>`;
  try {
    for await (const msg of stream('/api/delete')) {
      if (msg.type === 'progress') {
        $('#deleteProgress').textContent = `Deleted ${msg.done.toLocaleString()} of ${msg.total.toLocaleString()}…`;
        $('#deleteBar').style.width = `${Math.round((100 * msg.done) / msg.total)}%`;
      }
      if (msg.type === 'checking') $('#deleteProgress').textContent = 'Checking…';
      if (msg.type === 'done') {
        const all = msg.deleted === msg.total;
        const why = isPhone
          ? 'iPhones with iCloud Photos switched on don’t allow deleting over the cable. Delete them in the Photos app instead'
          : 'The card may be write-protected (check the little lock switch on its side)';
        panel.innerHTML = `<h3>${all ? '✨ Space freed up' : `Some files stayed on the ${isPhone ? 'phone' : 'card'}`}</h3>
          <p>Deleted ${msg.deleted.toLocaleString()} of ${msg.total.toLocaleString()} files from your ${escapeHtml(source)}.</p>
          ${all ? '' : `<p class="muted">${why} — they’re all safe on your laptop.</p>`}`;
      }
    }
  } catch (err) {
    panel.innerHTML = `<h3>Deleting stopped</h3><p>${escapeHtml(err.message)}</p>`;
  }
}

async function closeApp() {
  state.closed = true;
  try { await postJson('/api/finish'); } catch { /* already closed */ }
  $('#actions').innerHTML = '<div class="panel ok"><h3>All done ✨</h3><p>You can close this tab. Enjoy the memories!</p></div>';
}

// ------------------------------------------------------------------ wiring

$('#rangeChips').addEventListener('click', (e) => { if (e.target.dataset.days) setRange(Number(e.target.dataset.days)); });
for (const id of ['fromDate', 'untilDate']) {
  $(`#${id}`).addEventListener('change', () => {
    for (const chip of document.querySelectorAll('#rangeChips button')) chip.classList.remove('on');
    $('#tripInput').placeholder = defaultTripName();
  });
}
$('#findBtn').addEventListener('click', () => scan({
  mode: 'device', device: state.deviceId,
  from: $('#fromDate').value, until: $('#untilDate').value, skipImported: $('#skipImported').checked,
}));
$('#devices').addEventListener('click', (e) => {
  const chip = e.target.closest('button[data-id]');
  if (!chip || chip.dataset.state !== 'ready') return;
  state.deviceId = chip.dataset.id;
  updateDevices(state.devices);
});
$('#folderBtn').addEventListener('click', async () => {
  const button = $('#folderBtn');
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'A “choose a folder” window has opened — pick your folder there';
  try {
    const { path } = await postJson('/api/pick-folder');
    if (path) scan({ mode: 'folder', path });
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});
$('#changeBtn').addEventListener('click', () => {
  state.stage = 'setup';
  showSetupPanel('setupForm');
  if (state.scanMode === 'folder') $('#folderBtn').click();
});
$('#copyBtn').addEventListener('click', copyAndSort);
$('#applyBtn').addEventListener('click', applySorting);
$('#dialogClose').addEventListener('click', () => $('#folderDialog').close());
$('#deleteCancel').addEventListener('click', () => $('#deleteDialog').close());
$('#deleteConfirm').addEventListener('click', deleteFromPhone);

// Tell the helper the page is still open (it quits by itself 30 minutes after it's closed).
setInterval(() => { if (!state.closed) fetch('/api/ping').catch(() => {}); }, 20000);

$('#folderChips').addEventListener('click', (e) => {
  const name = e.target.dataset.folder;
  if (!name) return;
  const folders = new Set(state.prefs.folders);
  if (folders.has(name)) folders.delete(name); else folders.add(name);
  chooseFolders([...folders]);
});
for (const button of document.querySelectorAll('[data-preset]')) {
  button.addEventListener('click', () => chooseFolders(button.dataset.preset === 'all'
    ? state.settings.categories.map((c) => c.folder)
    : SIMPLE_FOLDERS));
}
$('#separateVideos').addEventListener('change', (e) => { state.prefs.separateVideos = e.target.checked; savePrefs(); });

async function main() {
  setRange(7);
  state.settings = await getJson('/settings.json');
  state.prefs = loadPrefs(state.settings.categories);
  renderFolderChips();
  const status = await getJson('/api/status');
  if (status.hasSession && !status.applied) { await startSorting(); return; }
  updateDevices(status.devices);
  $('#saveNote').textContent = `Saved to ${status.tripsRoot} — your photos never leave this laptop.`;
  watchDevices();
}

main().catch((err) => {
  console.error(err);
  setStatus(`Could not start: ${escapeHtml(err.message)}<br>Check your internet connection (needed once to download the AI) and reload this page.`);
});
