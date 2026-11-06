#!/usr/bin/env node
// Builds the static site into dist/ from the Google Sheet (served as JSON by apps-script/Code.gs).
//
//   node build.mjs            build from SHEET_JSON_URL (used by GitHub Actions)
//   node build.mjs --sample   build from sample-data.json, no network (local preview)
//   node build.mjs --offline  build from SHEET_JSON_URL but skip link previews / YouTube feed
//
// Any problem loading the sheet makes the build fail (exit 1), so the live site is never
// replaced by a broken or empty one.

import { readFile, writeFile, mkdir, rm, copyFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, '.cache');
const MEDIA_CACHE = path.join(CACHE, 'media');
const SAMPLE = process.argv.includes('--sample');
const OFFLINE = SAMPLE || process.argv.includes('--offline');
const UA = 'Mozilla/5.0 (compatible; PersonalSiteBuilder/1.0)';
const DAY = 864e5;

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('  ! ' + a.join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class BuildError extends Error {}

// ---------------------------------------------------------------- helpers

const slug = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const isYes = (s) => /^(y|yes|true|1|x|✓|✔)$/i.test(String(s ?? '').trim());
const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s,.;:–-]+$/, '') + '…';
};

const e = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function decodeEntities(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function safeUrl(u) {
  try {
    const url = new URL(String(u ?? '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function normUrl(u) {
  const url = new URL(u);
  url.hash = '';
  for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|igsh|si$)/i.test(k)) url.searchParams.delete(k);
  return (url.hostname.replace(/^(www|m)\./, '') + url.pathname.replace(/\/+$/, '') + url.search).toLowerCase();
}

function youtubeId(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host.endsWith('youtube.com')) {
      id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]+)/)?.[1];
    }
    return id && /^[\w-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Google Drive share links → direct image URL (file must be shared "Anyone with the link").
function imageSource(raw) {
  const url = safeUrl(raw);
  if (!url) return '';
  if (/drive\.google\.com|docs\.google\.com/.test(url)) {
    const id = url.match(/\/d\/([\w-]{20,})/)?.[1] || new URL(url).searchParams.get('id');
    if (id) return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;
  }
  return url;
}

function parseDate(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1));
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // day first (India / UK)
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const fmtDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal, headers: { 'user-agent': UA, ...opts.headers } });
  } finally {
    clearTimeout(timer);
  }
}

async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

// ---------------------------------------------------------------- sheet

async function loadSheet() {
  if (SAMPLE) return JSON.parse(await readFile(path.join(ROOT, 'sample-data.json'), 'utf8'));
  const url = process.env.SHEET_JSON_URL;
  if (!url) throw new BuildError('SHEET_JSON_URL is not set. Use --sample for a local preview.');
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, {}, 45000);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('response was not JSON — is the Apps Script web app deployed with access "Anyone"?');
      }
      if (!data || typeof data.tabs !== 'object') throw new Error('JSON has no "tabs" object');
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(3000 * attempt);
    }
  }
  throw new BuildError(`Could not load the Google Sheet: ${lastErr.message}`);
}

function toObjects(rows = []) {
  if (!rows.length) return [];
  const keys = rows[0].map(slug);
  return rows
    .slice(1)
    .map((r, i) => Object.assign(Object.fromEntries(keys.map((k, j) => [k, String(r[j] ?? '').trim()])), { _row: i + 2 }))
    .filter((o) => keys.some((k) => k && o[k]));
}

function readProfile(rows = []) {
  const p = {};
  for (const r of rows) {
    const k = slug(r[0]);
    if (k && k !== 'field') p[k] = String(r[1] ?? '').trim();
  }
  const get = (k) => p[k] || p[k.replace(/_url$/, '')] || '';
  return { raw: p, get };
}

// ---------------------------------------------------------------- platforms & icons

const PLATFORMS = {
  youtube: { label: 'YouTube', color: '#E62117', hosts: ['youtube.com', 'youtu.be'] },
  linkedin: { label: 'LinkedIn', color: '#0A66C2', hosts: ['linkedin.com', 'lnkd.in'] },
  instagram: { label: 'Instagram', color: '#D62976', hosts: ['instagram.com'] },
  x: { label: 'X', color: 'var(--ink)', hosts: ['x.com', 'twitter.com'] },
  facebook: { label: 'Facebook', color: '#1877F2', hosts: ['facebook.com', 'fb.watch'] },
  medium: { label: 'Medium', color: 'var(--ink)', hosts: ['medium.com'] },
  substack: { label: 'Substack', color: '#FF6719', hosts: ['substack.com'] },
  podcast: { label: 'Podcast', color: '#1DB954', hosts: ['open.spotify.com', 'podcasts.apple.com'] },
  article: { label: 'Article', color: 'var(--accent-text)', hosts: [] },
};

function detectPlatform(url, override) {
  const o = slug(override);
  if (o) {
    const hit = Object.entries(PLATFORMS).find(([k, v]) => k === o || slug(v.label) === o);
    return hit ? hit[0] : 'article';
  }
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {}
  for (const [k, v] of Object.entries(PLATFORMS)) if (v.hosts.some((h) => host === h || host.endsWith('.' + h))) return k;
  return 'article';
}

const svg = (body) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  linkedin: svg('<path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z"/><rect x="2" y="9" width="4" height="12"/><circle cx="4" cy="4" r="2"/>'),
  youtube: svg('<path d="M2.5 17a24.1 24.1 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.6 49.6 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.1 24.1 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.6 49.6 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/><path d="m10 15 5-3-5-3z"/>'),
  instagram: svg('<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><path d="M17.5 6.5h.01"/>'),
  x: svg('<path d="M4 4l11.7 16H20L8.3 4z"/><path d="M4 20l6.8-6.8M13.2 10.8 20 4"/>'),
  facebook: svg('<path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>'),
  podcast: svg('<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4"/>'),
  article: svg('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'),
  mail: svg('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'),
  arrow: svg('<path d="M7 17 17 7M7 7h10v10"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>'),
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
};
const platformIcon = (k) => ICONS[k] || ICONS.article;

// ---------------------------------------------------------------- images

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
let cachedMedia = null;

async function publishMedia(file) {
  const name = path.basename(file);
  await copyFile(file, path.join(OUT, 'media', name));
  return `media/${name}`;
}

// Downloads an image into the site so we never hotlink Drive / expiring CDN URLs.
async function localImage(raw, label, { fresh = false } = {}) {
  const url = imageSource(raw);
  if (!url || OFFLINE) return '';
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  cachedMedia ??= await readdir(MEDIA_CACHE).catch(() => []);
  const hit = cachedMedia.find((f) => f.startsWith(key + '.'));
  if (hit && !fresh) return publishMedia(path.join(MEDIA_CACHE, hit));
  try {
    const res = await fetchWithTimeout(url, {}, 20000);
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!type.startsWith('image/')) throw new Error(`got ${type || 'unknown'} instead of an image — is it shared "Anyone with the link"?`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 10e6) throw new Error('image is larger than 10 MB');
    const name = `${key}.${EXT[type] || 'img'}`;
    await mkdir(MEDIA_CACHE, { recursive: true });
    await writeFile(path.join(MEDIA_CACHE, name), buf);
    cachedMedia.push(name);
    return publishMedia(path.join(MEDIA_CACHE, name));
  } catch (err) {
    warn(`Could not download ${label} (${err.message})`);
    return hit ? publishMedia(path.join(MEDIA_CACHE, hit)) : '';
  }
}

// ---------------------------------------------------------------- content

function parseMeta(html, base) {
  const head = html.slice(0, 400000);
  const meta = (names) => {
    for (const n of names) {
      const tag = head.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${n}["'][^>]*>`, 'i'))?.[0];
      const m = tag?.match(/content\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
      const v = m && (m[1] ?? m[2]);
      if (v) return decodeEntities(v).trim();
    }
    return '';
  };
  let image = meta(['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image']);
  try {
    image = image ? new URL(image, base).href : '';
  } catch {
    image = '';
  }
  return {
    title: meta(['og:title', 'twitter:title']) || decodeEntities(head.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '').trim(),
    description: meta(['og:description', 'twitter:description', 'description']),
    image,
  };
}

async function enrich(it, cache) {
  if (OFFLINE) return;
  const c = cache.og[it.url];
  let meta = c && Date.now() - c.at < (c.ok ? 30 : 2) * DAY ? c : null;
  if (!meta) {
    try {
      const res = await fetchWithTimeout(it.url, { headers: { accept: 'text/html' } }, 10000);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      meta = { ok: true, at: Date.now(), ...parseMeta(await res.text(), res.url) };
    } catch (err) {
      meta = { ok: false, at: Date.now() };
      warn(`No preview for ${it.url} (${err.message}) — using the sheet's title/note`);
    }
    cache.og[it.url] = meta;
  }
  it.title ||= meta.title || '';
  it.note ||= meta.description || '';
  it.ogImage = meta.image || '';
}

async function resolveChannel(get) {
  const explicit = get('youtube_channel_id');
  if (/^UC[\w-]{22}$/.test(explicit)) return explicit;
  const url = safeUrl(explicit) || safeUrl(get('youtube_url'));
  if (!url || OFFLINE) return null;
  const direct = url.match(/\/channel\/(UC[\w-]{22})/)?.[1];
  if (direct) return direct;
  try {
    const html = await (await fetchWithTimeout(url, { headers: { 'accept-language': 'en' } }, 15000)).text();
    const id = html.match(/(?:"externalId"|"channelId")\s*:\s*"(UC[\w-]{22})"|\/channel\/(UC[\w-]{22})/);
    if (id) return id[1] || id[2];
    throw new Error('channel ID not found on page');
  } catch (err) {
    warn(`Could not find YouTube channel ID from ${url} (${err.message}). Add youtube_channel_id to the Profile tab.`);
    return null;
  }
}

async function youtubeFeed(channelId) {
  const res = await fetchWithTimeout(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {}, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, entry]) => {
      const tag = (t) => decodeEntities(entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] || '').trim();
      return { id: tag('yt:videoId'), title: tag('title'), date: tag('published').slice(0, 10), note: tag('media:description') };
    })
    .filter((v) => v.id);
}

async function buildContent(rows, get, cache) {
  const items = new Map();
  const hidden = new Set();

  rows.forEach((r, i) => {
    const raw = r.link || r.url;
    const url = safeUrl(raw);
    if (!url) {
      if (raw) warn(`Content row ${r._row}: "${raw}" is not a valid link — skipped`);
      return;
    }
    const platform = detectPlatform(url, r.platform);
    const yt = platform === 'youtube' ? youtubeId(url) : null;
    const key = yt ? `yt:${yt}` : normUrl(url);
    if (isYes(r.hide)) return void hidden.add(key);
    items.set(key, { url, platform, yt, title: r.title, date: r.date, note: r.note, image: r.image, featured: isYes(r.featured), order: i });
  });

  const channel = await resolveChannel(get);
  if (channel) {
    try {
      const videos = await youtubeFeed(channel);
      videos.forEach((v, i) => {
        const key = `yt:${v.id}`;
        if (hidden.has(key)) return;
        const existing = items.get(key);
        if (existing) {
          existing.title ||= v.title;
          existing.date ||= v.date;
          existing.note ||= v.note;
        } else {
          items.set(key, { url: `https://www.youtube.com/watch?v=${v.id}`, platform: 'youtube', yt: v.id, title: v.title, date: v.date, note: v.note, featured: false, order: 10000 + i });
        }
      });
      log(`  YouTube: ${videos.length} recent videos from channel ${channel}`);
    } catch (err) {
      warn(`YouTube feed failed (${err.message}) — showing only videos listed in the sheet`);
    }
  }

  const list = [...items.values()];
  await pool(list, 6, async (it) => {
    if (!it.yt && (!it.title || !it.image)) await enrich(it, cache);
    if (it.image) it.thumb = await localImage(it.image, `image for ${it.url}`);
    else if (it.yt && !SAMPLE) it.thumb = `https://i.ytimg.com/vi/${it.yt}/hqdefault.jpg`;
    else if (it.ogImage) it.thumb = await localImage(it.ogImage, `preview image for ${it.url}`);
  });

  for (const it of list) {
    it.time = parseDate(it.date);
    it.title = clip(it.title, 140);
    it.note = clip(it.note, 280);
    if (!it.title) {
      it.title = it.note ? clip(it.note, 90) : `${PLATFORMS[it.platform].label} post`;
      it.note = '';
    }
  }
  return list.sort((a, b) => b.featured - a.featured || (b.time ?? -Infinity) - (a.time ?? -Infinity) || a.order - b.order);
}

// ---------------------------------------------------------------- cache

async function loadCache() {
  try {
    return { og: {}, ...JSON.parse(await readFile(path.join(CACHE, 'og.json'), 'utf8')) };
  } catch {
    return { og: {} };
  }
}
async function saveCache(cache) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(path.join(CACHE, 'og.json'), JSON.stringify(cache));
}

// ---------------------------------------------------------------- render

function paragraphs(s) {
  return String(s ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${e(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function details(s) {
  let out = '';
  let list = [];
  const flush = () => {
    if (list.length) out += `<ul>${list.map((l) => `<li>${e(l)}</li>`).join('')}</ul>`;
    list = [];
  };
  for (const line of String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^[-•*–]\s*(.*)/);
    if (m) list.push(m[1]);
    else {
      flush();
      out += `<p>${e(line)}</p>`;
    }
  }
  flush();
  return out;
}

function accentColors(hex) {
  const valid = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex || '') ? hex : '#1E5B57';
  let h = valid.slice(1);
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { accent: '#' + h, ink: lum > 0.4 ? '#141412' : '#ffffff' };
}

const initials = (name) =>
  name.split(/\s+/).filter(Boolean).map((w) => w[0]).filter((_, i, a) => i === 0 || i === a.length - 1).join('').toUpperCase();

function card(it) {
  const P = PLATFORMS[it.platform];
  const date = it.time ? `<span aria-hidden="true">·</span><time datetime="${new Date(it.time).toISOString().slice(0, 10)}">${fmtDate.format(it.time)}</time>` : '';
  return `<article class="card" data-platform="${it.platform}" style="--pc:${P.color}">
  <a href="${e(it.url)}" target="_blank" rel="noopener">
    <div class="thumb"><span class="ph-icon">${platformIcon(it.platform)}</span>${it.thumb ? `<img src="${e(it.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">${it.yt ? `<span class="play">${ICONS.play}</span>` : ''}` : ''}${it.featured ? '<span class="badge">Featured</span>' : ''}</div>
    <div class="card-body">
      <div class="meta"><span class="plat">${platformIcon(it.platform)}${e(P.label)}</span>${date}</div>
      <h3>${e(it.title)}</h3>
      ${it.note ? `<p>${e(it.note)}</p>` : ''}
    </div>
  </a>
</article>`;
}

async function render({ get, highlights, services, content, resume, photo }) {
  const css = await readFile(path.join(ROOT, 'src/styles.css'), 'utf8');
  const js = await readFile(path.join(ROOT, 'src/site.js'), 'utf8');
  const name = get('name');
  const headline = get('headline');
  const intro = get('intro');
  const siteUrl = safeUrl(get('site_url')).replace(/\/$/, '');
  const description = get('meta_description') || clip(intro || get('about'), 160);
  const { accent, ink } = accentColors(get('accent_color'));
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('email')) ? get('email') : '';
  const resumePdf = safeUrl(get('resume_pdf'));
  const ctaLink = safeUrl(get('cta_link'));
  const ctaLabel = get('cta_label') || (ctaLink ? 'Book a call' : 'Get in touch');
  const socials = [
    ['linkedin', 'LinkedIn', get('linkedin_url')],
    ['youtube', 'YouTube', get('youtube_url')],
    ['instagram', 'Instagram', get('instagram_url')],
    ['x', 'X', get('x_url') || get('twitter_url')],
    ['facebook', 'Facebook', get('facebook_url')],
  ]
    .map(([k, label, u]) => [k, label, safeUrl(u)])
    .filter(([, , u]) => u);
  const socialLinks = (cls = '') =>
    socials.map(([k, label, u]) => `<a class="social ${cls}" href="${e(u)}" target="_blank" rel="noopener me" aria-label="${label}">${ICONS[k]}</a>`).join('');

  const hasAbout = Boolean(get('about'));
  const nav = [
    hasAbout && ['#about', 'About'],
    services.length && ['#services', get('services_heading') || 'What I do'],
    content.length && ['#content', 'Content'],
    resume.length && ['#resume', 'Resume'],
  ].filter(Boolean);

  const platformsPresent = Object.entries(content.reduce((acc, it) => ((acc[it.platform] = (acc[it.platform] || 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]);

  const resumeGroups = [];
  for (const r of resume) {
    const sec = r.section || 'Experience';
    let g = resumeGroups.find((x) => x.name === sec);
    if (!g) resumeGroups.push((g = { name: sec, items: [] }));
    g.items.push(r);
  }

  const favicon = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${accent}"/><text x="32" y="43" text-anchor="middle" font-family="Georgia,serif" font-size="28" fill="${ink}">${e(initials(name))}</text></svg>`,
  )}`;
  const ogImage = siteUrl && photo ? `${siteUrl}/${photo}` : '';
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name,
    ...(headline && { jobTitle: headline }),
    ...(description && { description }),
    ...(siteUrl && { url: siteUrl }),
    ...(ogImage && { image: ogImage }),
    ...(email && { email: `mailto:${email}` }),
    ...(socials.length && { sameAs: socials.map(([, , u]) => u) }),
  }).replace(/</g, '\\u003c');
  const title = headline ? `${name} — ${headline}` : name;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(description)}">
${siteUrl ? `<link rel="canonical" href="${e(siteUrl)}/">` : ''}
<meta property="og:type" content="profile">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
${siteUrl ? `<meta property="og:url" content="${e(siteUrl)}/">` : ''}
${ogImage ? `<meta property="og:image" content="${e(ogImage)}">` : ''}
<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="${accent}">
<link rel="icon" href="${favicon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap">
<style>
${css}
:root { --accent: ${accent}; --accent-ink: ${ink}; }
</style>
<script type="application/ld+json">${jsonLd}</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="nav">
  <div class="wrap">
    <a class="brand" href="#top">${e(name)}</a>
    <nav aria-label="Sections"><ul class="nav-links">${nav.map(([h, l]) => `<li><a href="${h}">${e(l)}</a></li>`).join('')}</ul></nav>
    <a class="btn btn-primary btn-sm" href="#contact">Contact</a>
  </div>
</header>

<main id="main">
<section class="hero" id="top">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      ${get('location') ? `<p class="eyebrow">${ICONS.pin}${e(get('location'))}</p>` : ''}
      <h1>${e(name)}</h1>
      ${headline ? `<p class="headline">${e(headline)}</p>` : ''}
      ${intro ? `<p class="intro">${e(intro)}</p>` : ''}
      <div class="actions">
        <a class="btn btn-primary" href="${ctaLink ? e(ctaLink) : '#contact'}"${ctaLink ? ' target="_blank" rel="noopener"' : ''}>${e(ctaLabel)}</a>
        ${resumePdf ? `<a class="btn btn-ghost" href="${e(resumePdf)}" target="_blank" rel="noopener">${ICONS.download}Resume</a>` : resume.length ? '<a class="btn btn-ghost" href="#resume">View resume</a>' : ''}
      </div>
      ${socials.length ? `<div class="socials">${socialLinks()}</div>` : ''}
    </div>
    <div class="portrait">
      ${photo ? `<img src="${e(photo)}" alt="Portrait of ${e(name)}" width="760" height="950">` : `<div class="initials" aria-hidden="true">${e(initials(name))}</div>`}
    </div>
  </div>
</section>

${highlights.length ? `<section class="stats" aria-label="Highlights">
  <div class="wrap"><div class="stats-grid">
    ${highlights.map((h) => `<div class="stat"><b>${e(h.value)}</b><span>${e(h.label)}</span></div>`).join('\n    ')}
  </div></div>
</section>` : ''}

${hasAbout ? `<section id="about">
  <div class="wrap about-grid">
    <div><p class="kicker">About</p><h2>${e(get('about_heading') || `Hello, I'm ${name.split(/\s+/)[0]}`)}</h2></div>
    <div class="prose">${paragraphs(get('about'))}</div>
  </div>
</section>` : ''}

${services.length ? `<section id="services" class="tinted">
  <div class="wrap">
    <div class="section-head"><div><p class="kicker">Services</p><h2>${e(get('services_heading') || 'What I do')}</h2></div></div>
    <div class="services">
      ${services.map((s, i) => `<div class="service"><span class="num">${String(i + 1).padStart(2, '0')}</span><h3>${e(s.title)}</h3>${s.description ? paragraphs(s.description) : ''}</div>`).join('\n      ')}
    </div>
  </div>
</section>` : ''}

${content.length ? `<section id="content">
  <div class="wrap">
    <div class="section-head">
      <div><p class="kicker">Featured &amp; recent</p><h2>${e(get('content_heading') || 'Talks, videos & writing')}</h2></div>
      ${platformsPresent.length > 1 ? `<div class="chips" role="group" aria-label="Filter by platform">
        <button class="chip" data-filter="all" aria-pressed="true">All</button>
        ${platformsPresent.map(([k]) => `<button class="chip" data-filter="${k}" aria-pressed="false">${e(PLATFORMS[k].label)}</button>`).join('\n        ')}
      </div>` : ''}
    </div>
    <div class="grid" data-grid>
${content.map(card).join('\n')}
    </div>
    <button class="btn btn-ghost more" data-more hidden>Show more</button>
  </div>
</section>` : ''}

${resume.length ? `<section id="resume" class="tinted">
  <div class="wrap resume-grid">
    <div class="resume-side">
      <p class="kicker">Resume</p>
      <h2>${e(get('resume_heading') || 'Experience')}</h2>
      ${resumePdf ? `<a class="btn btn-primary" href="${e(resumePdf)}" target="_blank" rel="noopener">${ICONS.download}Download PDF</a>` : ''}
    </div>
    <div>
      ${resumeGroups.map((g) => `<div class="resume-group">
        <h3 class="group-title">${e(g.name)}</h3>
        ${g.items.map((r) => `<div class="item">
          <div class="dates">${e(r.dates)}</div>
          <div>
            <h4>${e(r.title)}</h4>
            ${r.organization ? `<p class="org">${e(r.organization)}</p>` : ''}
            ${r.details ? `<div class="details">${details(r.details)}</div>` : ''}
          </div>
        </div>`).join('\n        ')}
      </div>`).join('\n      ')}
    </div>
  </div>
</section>` : ''}

<section id="contact">
  <div class="wrap">
    <div class="contact">
      <h2>${e(get('contact_heading') || "Let's work together")}</h2>
      ${get('contact_text') ? `<p>${e(get('contact_text'))}</p>` : ''}
      <div class="actions center">
        ${email ? `<a class="btn btn-inverse" href="mailto:${e(email)}">${ICONS.mail}${e(email)}</a>` : ''}
        ${ctaLink ? `<a class="btn btn-outline-inverse" href="${e(ctaLink)}" target="_blank" rel="noopener">${e(ctaLabel)}</a>` : ''}
      </div>
      ${socials.length ? `<div class="socials center">${socialLinks('inverse')}</div>` : ''}
    </div>
  </div>
</section>
</main>

<footer class="footer">
  <div class="wrap">
    <span>© ${new Date().getFullYear()} ${e(name)}</span>
    <a href="#top">Back to top ↑</a>
  </div>
</footer>
<script>
${js}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- main

async function main() {
  const t0 = Date.now();
  log(SAMPLE ? 'Building from sample-data.json' : 'Building from Google Sheet');
  const data = await loadSheet();
  const tab = (name) => data.tabs[Object.keys(data.tabs).find((t) => t.trim().toLowerCase() === name.toLowerCase())] || [];

  const { get } = readProfile(tab('Profile'));
  if (!get('name')) throw new BuildError('The Profile tab has no "name" — refusing to publish an empty site.');
  const highlights = toObjects(tab('Highlights')).filter((h) => h.value || h.label);
  const services = toObjects(tab('Services')).filter((s) => s.title);
  const resume = toObjects(tab('Resume')).filter((r) => r.title || r.organization);

  const cache = await loadCache();
  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'media'), { recursive: true });

  const photo = await localImage(get('photo'), 'profile photo', { fresh: true });
  const content = await buildContent(toObjects(tab('Content')), get, cache);
  await saveCache(cache);

  await writeFile(path.join(OUT, 'index.html'), await render({ get, highlights, services, content, resume, photo }));
  await writeFile(path.join(OUT, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  log(`Done: ${content.length} content items, ${services.length} services, ${resume.length} resume entries → dist/ (${Date.now() - t0} ms)`);
}

main().catch((err) => {
  console.error(`\nBUILD FAILED: ${err.message}`);
  if (!(err instanceof BuildError)) console.error(err.stack);
  process.exit(1);
});
