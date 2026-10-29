// Trip Photo Sorter - runs CLIP (an image/text AI model) in the browser to put each
// photo and video into a category, then asks SortTrip.ps1 to move the files.
// Photos never leave the laptop: only the model files are downloaded (once, then cached).
import {
  AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage, env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.6';

env.allowLocalModels = false;

const $ = (selector) => document.querySelector(selector);
const DUPLICATE_WINDOW = 12;        // compare each photo with the previous N (bursts sit next to each other)
const THUMB = 128;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FOLDER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';
const TRASH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';

const state = {
  session: null,
  settings: null,
  items: [],            // { file, thumb, folder, embedding }
  folders: new Map(),   // folder path -> { label, kind, card }
  sorted: 0,
  finished: false,
};

// ------------------------------------------------------------------ helpers

const fetchJson = async (url, options) => {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
  return res.json();
};
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const setStatus = (html) => { $('#status').innerHTML = html; };
const setBar = (fraction) => { $('#bar').style.width = `${Math.round(fraction * 100)}%`; };

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

function formatDuration(seconds) {
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'about 1 minute' : `about ${minutes} minutes`;
}

// ------------------------------------------------------------------ folders and cards

function folderFor(kind, label) { return `${kind === 'video' ? 'Videos' : 'Photos'}/${label}`; }

function addFolder(path, label, kind, container, extraClass = '') {
  const card = document.createElement('button');
  card.className = `card ${extraClass}`;
  card.innerHTML = `<div class="card-head">${extraClass === 'trash' ? TRASH_ICON : FOLDER_ICON}<span class="name">${escapeHtml(label)}</span><span class="count">0</span></div><div class="strip"><span class="ph"></span></div>`;
  card.addEventListener('click', () => openFolder(path));
  container.appendChild(card);
  state.folders.set(path, { label, kind, card });
}

function buildFolders() {
  const { settings, session } = state;
  const labels = [...settings.categories.map((c) => c.folder), settings.otherFolder];
  const hasVideos = session.files.some((f) => f.kind === 'video');
  labels.forEach((label) => addFolder(folderFor('photo', label), label, 'photo', $('#photoCards')));
  if (hasVideos) {
    $('#videoCards').innerHTML = '';
    labels.forEach((label) => addFolder(folderFor('video', label), label, 'video', $('#videoCards')));
    for (const { card } of [...state.folders.values()].filter((f) => f.kind === 'video')) card.hidden = true;
  } else {
    $('#videoColumn').hidden = true;
  }
  addFolder(settings.duplicatesFolder, `${settings.duplicatesFolder.replace(/ - to trash$/i, '')} → trash`, 'any', $('#specialCards'), 'trash');
}

function renderFolder(path) {
  const folder = state.folders.get(path);
  if (!folder) return;
  const members = state.items.filter((it) => it.folder === path);
  folder.card.querySelector('.count').textContent = members.length;
  if (folder.kind === 'video') folder.card.hidden = members.length === 0;
  const strip = folder.card.querySelector('.strip');
  const shown = members.slice(-5).map((it) => `<img src="${it.thumb}" alt="">`).join('');
  const more = members.length > 5 ? `<span class="more">+${members.length - 5}</span>` : '';
  strip.innerHTML = shown ? shown + more : '<span class="ph"></span>';
}

function renderStats() {
  const counted = state.items.filter((it) => it.folder);
  $('#statPhotos').textContent = counted.filter((it) => it.file.kind === 'photo').length;
  $('#statVideos').textContent = counted.filter((it) => it.file.kind === 'video').length;
  $('#statFolders').textContent = new Set(counted.map((it) => it.folder)).size;
}

// ------------------------------------------------------------------ the pile ("a total mess")

const TILE_COLORS = ['#e9c6d8', '#d8cbe8', '#c9dcea', '#f0d9c4', '#cfe3d3', '#e6d3dd', '#bfb3c6', '#a99aa9'];
let tiles = [];

function buildPile(count) {
  const pile = $('#pile');
  const size = pile.clientWidth || 300;
  tiles = Array.from({ length: Math.min(count, 110) }, (_, i) => {
    const tile = document.createElement('span');
    tile.className = 'tile';
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * (size / 2 - 22);
    tile.style.left = `${size / 2 + Math.cos(angle) * radius - 17}px`;
    tile.style.top = `${size / 2 + Math.sin(angle) * radius - 17}px`;
    tile.style.transform = `rotate(${Math.random() * 50 - 25}deg)`;
    tile.style.background = TILE_COLORS[i % TILE_COLORS.length];
    pile.appendChild(tile);
    return tile;
  });
}

function takeFromPile() {
  const total = state.session.files.length;
  const keep = Math.round(tiles.length * (1 - state.sorted / total));
  let start = null;
  while (tiles.length > keep) {
    const tile = tiles.splice(Math.floor(Math.random() * tiles.length), 1)[0];
    start ??= tile.getBoundingClientRect();
    tile.classList.add('gone');
  }
  $('#pileCaption').textContent = state.sorted < total ? `a total mess · ${total - state.sorted} left` : 'all sorted ✨';
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
  const sx = fromRect.left + fromRect.width / 2 - 17, sy = fromRect.top + fromRect.height / 2 - 17;
  img.animate([
    { transform: `translate(${sx}px, ${sy}px) rotate(${Math.random() * 40 - 20}deg) scale(1.3)` },
    { transform: `translate(${to.left}px, ${to.top}px) rotate(0deg) scale(1)` },
  ], { duration: 700, easing: 'cubic-bezier(.3,.7,.2,1)' }).finished.then(() => {
    img.remove();
    renderFolder(item.folder);
    folder.card.classList.remove('pulse');
    void folder.card.offsetWidth;
    folder.card.classList.add('pulse');
  });
}

// ------------------------------------------------------------------ AI model

async function loadModel(modelId) {
  const loaded = new Map();
  const onProgress = (p) => {
    if (p.status !== 'progress' || !p.total) return;
    loaded.set(p.file, [p.loaded, p.total]);
    let have = 0, total = 0;
    for (const [l, t] of loaded.values()) { have += l; total += t; }
    setStatus(`Downloading the AI model… ${Math.round((100 * have) / total)}% of ${Math.round(total / 1e6)} MB<br><span class="muted">First time only - after this it works from the browser cache.</span>`);
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

const BROKEN_THUMB = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = THUMB;
  const g = c.getContext('2d');
  g.fillStyle = '#eadbe4'; g.fillRect(0, 0, THUMB, THUMB);
  g.fillStyle = '#8b7f8d'; g.font = '600 18px sans-serif'; g.textAlign = 'center'; g.fillText('?', THUMB / 2, THUMB / 2 + 6);
  return c.toDataURL();
})();

// ------------------------------------------------------------------ sorting one file

async function sortFile(ai, categoryVectors, file, seenHashes, recent) {
  const { settings } = state;
  const url = `/media/${file.id}`;
  const item = { file, thumb: BROKEN_THUMB, folder: null, embedding: null };
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

    const screenshots = settings.categories.find((c) => c.folder.toLowerCase() === 'screenshots');
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
    const label = exp[best] / sum >= settings.minConfidence ? settings.categories[best].folder : settings.otherFolder;
    item.folder = folderFor(file.kind, label);
  } catch (err) {
    console.warn(`Could not read ${file.name}:`, err);
    item.folder = folderFor(file.kind, settings.otherFolder);
  }
  return item;
}

// ------------------------------------------------------------------ review dialog

function folderOptions(kind) {
  return [...state.folders.entries()].filter(([, f]) => f.kind === kind || f.kind === 'any');
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
    const options = folderOptions(item.file.kind)
      .map(([p, f]) => `<option value="${escapeHtml(p)}"${p === path ? ' selected' : ''}>${escapeHtml(f.label)}</option>`).join('');
    fig.innerHTML = `<img src="${item.thumb}" alt=""><figcaption title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</figcaption><select aria-label="Folder for ${escapeHtml(item.file.name)}">${options}</select>`;
    fig.querySelector('select').addEventListener('change', (e) => {
      item.folder = e.target.value;
      fig.style.opacity = 0.35;
      renderFolder(path);
      renderFolder(item.folder);
      renderStats();
    });
    grid.appendChild(fig);
  }
  $('#folderDialog').showModal();
}

// ------------------------------------------------------------------ finishing: move files and write the report

function reportHtml(css, result) {
  const { session, settings } = state;
  const card = (path, f) => {
    const members = state.items.filter((it) => it.folder === path);
    if (!members.length) return '';
    const href = path.split('/').map(encodeURIComponent).join('/') + '/';
    const thumbs = members.slice(0, 8).map((it) => `<img src="${it.thumb}" alt="">`).join('');
    const more = members.length > 8 ? `<span class="more">+${members.length - 8}</span>` : '';
    return `<a class="card${path === settings.duplicatesFolder ? ' trash' : ''}" href="${href}"><div class="card-head">${path === settings.duplicatesFolder ? TRASH_ICON : FOLDER_ICON}<span class="name">${escapeHtml(f.label)}</span><span class="count">${members.length}</span></div><div class="strip">${thumbs}${more}</div></a>`;
  };
  const column = (kind) => [...state.folders.entries()].filter(([, f]) => f.kind === kind).map(([p, f]) => card(p, f)).join('');
  const dup = state.folders.get(settings.duplicatesFolder);
  const photos = state.items.filter((it) => it.file.kind === 'photo').length;
  const videos = state.items.length - photos;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(session.trip)} - sorted photos</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@1&display=swap" rel="stylesheet">
<style>${css} a.card{display:block;text-decoration:none} .board{grid-template-columns:1fr 1fr}</style></head><body>
<header class="top"><div class="brand"><div class="avatar">✿</div><div><div class="eyebrow">Trip Photo Sorter · <span class="muted">${new Date().toLocaleDateString()}</span></div>
<h1>Sorted my <em>${escapeHtml(session.trip)}</em> photos</h1></div></div>
<div class="stats"><div class="stat"><span class="label">Total files</span><span class="value">${state.items.length}</span></div>
<div class="stat"><span class="label"><i class="dot"></i>Photos</span><span class="value">${photos}</span></div>
<div class="stat"><span class="label"><i class="dot video"></i>Videos</span><span class="value">${videos}</span></div>
<div class="stat"><span class="label">Folders created</span><span class="value">${result.folders}</span></div></div></header>
<main class="board"><section><h2>Photos</h2><div class="cards">${column('photo')}</div></section>
<section><h2>Videos</h2><div class="cards">${column('video') || '<p class="empty">No videos.</p>'}</div>
<h2>Check, then delete</h2><div class="cards">${card(settings.duplicatesFolder, dup) || '<p class="empty">No duplicates found.</p>'}</div></section></main>
</body></html>`;
}

async function applySorting() {
  const button = $('#applyBtn');
  button.disabled = true;
  setStatus('Creating folders and moving files…');
  try {
    const assignments = state.items.map((it) => ({ id: it.file.id, folder: it.folder }));
    const result = await fetchJson('/api/apply', { method: 'POST', body: JSON.stringify({ assignments }) });
    const css = await (await fetch('/style.css')).text();
    await fetchJson('/api/report', { method: 'POST', body: reportHtml(css, result) });
    await fetch('/api/finish', { method: 'POST' });
    button.hidden = true;
    $('#hint').hidden = true;
    setStatus(`✅ Moved <b>${result.moved}</b> files into <b>${result.folders}</b> folders.`);
    const panel = document.createElement('div');
    panel.className = 'done-panel';
    const phoneStep = state.session.fromPhone
      ? '<p><b>Next:</b> go back to the black <b>Trip Photo Sorter</b> window. It has checked every file and will ask whether to delete these photos from your phone.</p>'
      : '';
    panel.innerHTML = `<p>Your sorted trip is in<br><code>${escapeHtml(result.tripDir)}</code><br>with a <b>Sorting report.html</b> inside.</p>${result.leftover ? `<p>${result.leftover} files were left in <code>_incoming</code>.</p>` : ''}${phoneStep}<p class="muted">You can close this tab.</p>`;
    $('.center').appendChild(panel);
  } catch (err) {
    setStatus(`Something went wrong while moving files: ${escapeHtml(err.message)}<br>Nothing on your phone was touched.`);
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ main

async function main() {
  const [session, settings] = await Promise.all([fetchJson('/api/session'), fetchJson('/settings.json')]);
  Object.assign(state, { session, settings });
  $('#tripName').textContent = session.trip;
  document.title = `Sorting ${session.trip}`;
  $('#statTotal').textContent = session.files.length;
  buildFolders();
  buildPile(session.files.length);

  setStatus('Loading the AI model…');
  const ai = await loadModel(settings.aiModel);
  const categoryVectors = await embedCategories(ai, settings.categories);

  const seenHashes = new Set();
  const recent = [];
  const started = performance.now();
  for (const file of session.files) {
    const item = await sortFile(ai, categoryVectors, file, seenHashes, recent);
    state.items.push(item);
    state.sorted++;
    fly(item, takeFromPile());
    renderStats();
    const perFile = (performance.now() - started) / 1000 / state.sorted;
    setBar(state.sorted / session.files.length);
    setStatus(`Sorting ${state.sorted} of ${session.files.length} · ${formatDuration(perFile * (session.files.length - state.sorted))} left<br><span class="muted">AI on ${ai.device === 'webgpu' ? 'graphics chip' : 'processor'} · photos stay on this laptop</span>`);
  }

  state.finished = true;
  for (const path of state.folders.keys()) renderFolder(path);
  setStatus('All sorted! Click a folder to check it, then press the button to create the folders on your laptop.');
  $('#applyBtn').disabled = false;
}

$('#applyBtn').addEventListener('click', applySorting);
$('#dialogClose').addEventListener('click', () => $('#folderDialog').close());
main().catch((err) => {
  console.error(err);
  setStatus(`Could not start: ${escapeHtml(err.message)}<br>Check your internet connection (needed once to download the AI model) and reload this page.`);
});
