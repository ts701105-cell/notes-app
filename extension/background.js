const APP = 'https://ts701105-cell.github.io/notes-app/';
const MAX_H = 7000, OUT_W = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 佇列(序列化讀寫,避免互相覆蓋) ---------- */
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(async () => {
    const { queue = [] } = await chrome.storage.local.get('queue');
    await chrome.storage.local.set({ queue: fn(queue) });
  });
  chain = p.catch(() => {});
  return p;
}

/* ---------- 注入網頁的擷取函式(需自給自足) ---------- */
function extractInPage(onlySelection) {
  const meta = n => { const e = document.querySelector(`meta[property="${n}"],meta[name="${n}"]`); return e && e.content ? e.content.trim() : ''; };
  const title = (meta('og:title') || document.title || '').trim();
  const desc = meta('og:description') || meta('description');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'NAV', 'FOOTER', 'ASIDE', 'FORM', 'IFRAME', 'SVG', 'BUTTON', 'SELECT', 'TEMPLATE', 'CANVAS', 'VIDEO', 'AUDIO', 'INPUT', 'TEXTAREA']);
  const BLK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'PRE', 'BLOCKQUOTE', 'TABLE', 'TR', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'HEADER', 'HR']);
  function toText(root, live) {
    const lines = []; let buf = '', pre = '';
    const flush = () => { const t = buf.replace(/[ \t ]+/g, ' ').trim(); if (t) lines.push(pre + t); buf = ''; pre = ''; };
    (function walk(el) {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) { buf += c.nodeValue.replace(/\s+/g, ' '); continue; }
        if (c.nodeType !== 1) continue;
        const tag = c.tagName;
        if (SKIP.has(tag) || c.hidden || c.getAttribute('aria-hidden') === 'true') continue;
        if (tag === 'HEADER' && root === document.body) continue;
        if (live) { const cs = getComputedStyle(c); if (cs.display === 'none' || cs.visibility === 'hidden') continue; }
        if (tag === 'BR') { flush(); continue; }
        if (tag === 'TD' || tag === 'TH') { walk(c); buf += ' | '; continue; }
        if (BLK.has(tag)) {
          flush();
          if (/^H[1-6]$/.test(tag)) pre = '## ';
          else if (tag === 'LI') pre = '• ';
          else if (tag === 'BLOCKQUOTE') pre = '> ';
          walk(c); flush();
        } else walk(c);
      }
    })(root);
    flush();
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  let text = '';
  if (onlySelection) {
    const s = getSelection();
    if (s && s.rangeCount && !s.isCollapsed) {
      const d = document.createElement('div');
      for (let i = 0; i < s.rangeCount; i++) d.append(s.getRangeAt(i).cloneContents());
      text = toText(d, false);
    }
  } else {
    let best = null, bl = 0;
    for (const e of document.querySelectorAll('article,[role=main],main,#content,.post-content,.article-content,.entry-content,.article-body')) {
      const l = (e.innerText || '').length; if (l > bl) { best = e; bl = l; }
    }
    text = toText(bl >= 300 ? best : document.body, true);
  }
  if (text.length > 80000) text = text.slice(0, 80000) + '\n…(內容過長,已截斷)';
  return { title, desc, url: location.href, text };
}


/* ---------- 簡化擷取:保留文字、圖片、排版,移除廣告與留言(注入網頁執行,需自給自足) ---------- */
function simplifyInPage() {
  const abs = u => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } };
  const meta = n => { const e = document.querySelector(`meta[property="${n}"],meta[name="${n}"]`); return e && e.content ? e.content.trim() : ''; };
  const title = (meta('og:title') || document.title || '').trim();
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const NOISE_RE = /^(ad|ads|adv|advert\w*|adsense\w*|adslot|adunit|adbox|adwrap\w*|comment\w*|replies|respond|disqus\w*|fbcomments|share\w*|sharing|social\w*|sns|related\w*|recommend\w*|sponsor\w*|promo\w*|sidebar\w*|newsletter\w*|subscribe\w*|subscription|popup|modal|cookie\w*|consent|banner|breadcrumb\w*|taboola|outbrain|widget\w*|toolbar|navbar|nav|menu|masthead|footer|print|sticky)$/;
  const ROLES = new Set(['complementary', 'navigation', 'banner', 'contentinfo', 'search', 'dialog', 'alertdialog']);
  const noiseMemo = new Map();
  function selfNoise(el) {
    if (el.tagName === 'INS' || el.hasAttribute('data-ad') || el.hasAttribute('data-ad-slot') || el.hasAttribute('data-ad-client')) return true;
    if (ROLES.has((el.getAttribute('role') || '').toLowerCase())) return true;
    const raw = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
    return raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).some(t => t && NOISE_RE.test(t));
  }
  function inNoise(el) {
    const chain = []; let n = el, r = false;
    while (n && n !== document.body && n.nodeType === 1) {
      if (noiseMemo.has(n)) { r = noiseMemo.get(n); break; }
      chain.push(n); if (selfNoise(n)) { r = true; break; } n = n.parentElement;
    }
    for (const c of chain) noiseMemo.set(c, r);
    return r;
  }
  /* 找出主要內文區塊 */
  const score = new Map();
  const bump = (e, v) => { if (e && e !== document.documentElement) score.set(e, (score.get(e) || 0) + v); };
  for (const p of document.querySelectorAll('p,pre,td')) {
    const t = (p.textContent || '').trim(); if (t.length < 25) continue;
    if (inNoise(p)) continue;
    const v = Math.min(t.length, 300) + (t.match(/[,，。、]/g) || []).length * 3;
    bump(p.parentElement, v); if (p.parentElement) { bump(p.parentElement.parentElement, v / 2); if (p.parentElement.parentElement) bump(p.parentElement.parentElement.parentElement, v / 4); }
  }
  let top = null, ts = 0;
  for (const [e, v] of score) { if (v > ts) { top = e; ts = v; } }
  let root = ts >= 80 ? top : document.body;
  const arts = [...document.querySelectorAll('article,[role=main],main')].filter(a => !inNoise(a) && !(a.getAttribute('role') === 'main' && false)).sort((a, b) => b.textContent.length - a.textContent.length);
  if (arts[0] && (!root || arts[0].textContent.length >= 0.6 * root.textContent.length) && arts[0].querySelector('p,h1,h2')) root = arts[0];
  const rootLen = (root.textContent || '').length;

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'TEMPLATE', 'CANVAS', 'VIDEO', 'AUDIO', 'NAV', 'FOOTER', 'ASIDE', 'DIALOG', 'LINK', 'META', 'MAP']);
  const BLOCK = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FIGURE', 'CENTER', 'DL', 'DD', 'DT', 'ADDRESS', 'DETAILS', 'SUMMARY', 'FIELDSET']);
  const imgs = [], seen = new Map();
  const BADIMG = /(avatar|logo|icon|emoji|emoticon|sprite|pixel|tracking|badge|spacer|blank|loading|placeholder|gravatar|qrcode|qr-code)/i;
  function bestSrc(c) {
    const srcset = c.getAttribute('data-srcset') || c.getAttribute('srcset') || '';
    let best = '', bw = 0;
    for (const part of srcset.split(',')) { const [u, w] = part.trim().split(/\s+/); const n = parseFloat(w) || 1; if (u && n >= bw) { best = u; bw = n; } }
    return best || c.getAttribute('data-original') || c.getAttribute('data-src') || c.getAttribute('data-lazy-src') || c.getAttribute('data-actualsrc') || c.currentSrc || c.getAttribute('src') || '';
  }
  function imgHtml(c) {
    const u = abs(bestSrc(c)); if (!u) return '';
    if (/\.svg(\?|$)/i.test(u) || BADIMG.test(u + ' ' + (c.className || '') + ' ' + (c.id || ''))) return '';
    const w = c.naturalWidth || +c.getAttribute('width') || 0, h = c.naturalHeight || +c.getAttribute('height') || 0;
    if ((w && w < 90) || (h && h < 60)) return '';
    if (!seen.has(u)) { if (imgs.length >= 25) return ''; seen.set(u, imgs.length); imgs.push(u); }
    return `<img data-i="${seen.get(u)}">`;
  }
  function hidden(c) {
    if (c.hidden || c.getAttribute('aria-hidden') === 'true') return true;
    const cs = getComputedStyle(c); return cs.display === 'none' || cs.visibility === 'hidden';
  }
  function kids(el, wrap) {
    let out = '', run = '';
    const flush = () => { if (run.trim()) out += wrap ? `<div>${run.trim()}</div>` : run; run = ''; };
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { run += esc(c.nodeValue.replace(/\s+/g, ' ')); continue; }
      if (c.nodeType !== 1) continue;
      const r = node(c); if (!r) continue;
      if (r.block) { flush(); out += r.h; } else run += r.h;
    }
    flush(); return out;
  }
  function node(c) {
    const t = c.tagName;
    if (SKIP.has(t) || hidden(c)) return null;
    if (c !== root && selfNoise(c) && !((c.textContent || '').length > 0.6 * rootLen && c.querySelector('p'))) return null;
    if (/^H[1-6]$/.test(t)) { const k = Math.min(3, +t[1]); const x = kids(c, false).trim(); return x ? { block: true, h: `<h${k}>${x}</h${k}>` } : null; }
    if (t === 'P') { const x = kids(c, false).trim(); return x ? { block: true, h: `<p>${x}</p>` } : null; }
    if (t === 'UL' || t === 'OL') { const x = kids(c, false); return x.trim() ? { block: true, h: `<${t.toLowerCase()}>${x}</${t.toLowerCase()}>` } : null; }
    if (t === 'LI') { const x = kids(c, true).trim(); return x ? { block: true, h: `<li>${x}</li>` } : null; }
    if (t === 'BLOCKQUOTE') { const x = kids(c, true).trim(); return x ? { block: true, h: `<blockquote>${x}</blockquote>` } : null; }
    if (t === 'PRE') { const x = (c.textContent || '').replace(/\s+$/, ''); return x ? { block: true, h: `<pre>${esc(x)}</pre>` } : null; }
    if (t === 'HR') return { block: true, h: '<hr>' };
    if (t === 'BR') return { block: false, h: '<br>' };
    if (t === 'FIGCAPTION') { const x = kids(c, false).trim(); return x ? { block: true, h: `<div><i>${x}</i></div>` } : null; }
    if (t === 'TABLE') { const x = kids(c, false); return x.trim() ? { block: true, h: `<table>${x}</table>` } : null; }
    if (t === 'TBODY' || t === 'THEAD' || t === 'TFOOT') return { block: true, h: kids(c, false) };
    if (t === 'TR') { const x = kids(c, false); return x.trim() ? { block: true, h: `<tr>${x}</tr>` } : null; }
    if (t === 'TD' || t === 'TH') { const x = kids(c, true).trim(); return { block: true, h: `<${t.toLowerCase()}>${x}</${t.toLowerCase()}>` }; }
    if (t === 'IMG') { const x = imgHtml(c); return x ? { block: false, h: x } : null; }
    if (t === 'PICTURE') { const im = c.querySelector('img'); const x = im ? imgHtml(im) : ''; return x ? { block: false, h: x } : null; }
    if (t === 'A') {
      const h = abs(c.getAttribute('href') || ''), x = kids(c, false); if (!x.trim()) return null;
      return { block: false, h: h ? `<a href="${esc(h)}">${x}</a>` : x };
    }
    const inl = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', DEL: 's', STRIKE: 's', MARK: 'mark', SUB: 'sub', SUP: 'sup', CODE: 'code' }[t];
    if (inl) { const x = kids(c, false); return x.trim() ? { block: false, h: `<${inl}>${x}</${inl}>` } : null; }
    if (BLOCK.has(t)) {
      const x = kids(c, true); return x.trim() ? { block: true, h: x } : null;
    }
    const x = kids(c, false); return x ? { block: false, h: x } : null; // span、font 等行內元素
  }
  let html = kids(root, true);
  html = html.replace(/<(p|div|li|blockquote|h[1-3])>\s*(<br>\s*)*<\/\1>/g, '').replace(/(<br>\s*){3,}/g, '<br><br>').replace(/<li><div>((?:(?!<\/?div>).)*)<\/div><\/li>/g, '<li>$1</li>');
  const first = html.match(/^<h1>(.*?)<\/h1>/);
  if (first) { const ft = first[1].replace(/<[^>]+>/g, '').trim(); if (ft && title && (title.includes(ft) || ft.includes(title))) html = html.slice(first[0].length); }
  if (html.length > 600000) html = html.slice(0, 600000);
  return { title, url: location.href, html, imgs };
}

/* ---------- 截圖 ---------- */
function b64(buf) {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
async function grab(windowId) {
  const url = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 85 });
  return createImageBitmap(await (await fetch(url)).blob());
}
async function finish(cv) {
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
  return { img: 'data:image/jpeg;base64,' + b64(await blob.arrayBuffer()), w: cv.width, h: cv.height };
}
async function shotVisible(tab) {
  const bm = await grab(tab.windowId);
  const k = OUT_W / bm.width, cv = new OffscreenCanvas(OUT_W, Math.max(1, Math.round(bm.height * k)));
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, cv.width, cv.height);
  g.drawImage(bm, 0, 0, cv.width, cv.height); bm.close();
  return finish(cv);
}
async function shotFull(tab) {
  const tabId = tab.id, run = (func, args = []) => chrome.scripting.executeScript({ target: { tabId }, func, args }).then(r => r[0].result);
  const m = await run(() => ({ sh: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), vh: innerHeight, dpr: devicePixelRatio }));
  if (m.sh <= m.vh + 4) return shotVisible(tab);
  await run(() => { window.__cn = { sb: document.documentElement.style.scrollBehavior, y: scrollY, hid: [] }; document.documentElement.style.scrollBehavior = 'auto'; });
  try {
    let cv = null, k = 0, maxY = m.sh;
    const ys = []; for (let y = 0; y < m.sh - m.vh; y += m.vh) ys.push(y); ys.push(m.sh - m.vh);
    for (let i = 0; i < ys.length; i++) {
      const y = await run((y, hide) => {
        scrollTo(0, y);
        if (hide) for (const e of document.querySelectorAll('*')) {
          const p = getComputedStyle(e).position;
          if ((p === 'fixed' || p === 'sticky') && e.style.visibility !== 'hidden') { window.__cn.hid.push([e, e.style.visibility]); e.style.visibility = 'hidden'; }
        }
        return scrollY;
      }, [ys[i], i > 0]);
      await sleep(650); // 等圖片載入,同時避開 captureVisibleTab 的每秒次數限制
      const bm = await grab(tab.windowId);
      if (!cv) {
        k = OUT_W / bm.width;
        maxY = Math.min(m.sh, MAX_H / (m.dpr * k));
        cv = new OffscreenCanvas(OUT_W, Math.max(1, Math.round(Math.min(m.sh * m.dpr * k, MAX_H))));
        const g0 = cv.getContext('2d'); g0.fillStyle = '#fff'; g0.fillRect(0, 0, cv.width, cv.height);
      }
      if (y < maxY) cv.getContext('2d').drawImage(bm, 0, Math.round(y * m.dpr * k), OUT_W, Math.round(bm.height * k));
      bm.close();
      if (y + m.vh >= maxY) break;
    }
    return await finish(cv);
  } finally {
    await run(() => { const c = window.__cn; if (!c) return; for (const [e, v] of c.hid) e.style.visibility = v; document.documentElement.style.scrollBehavior = c.sb; scrollTo(0, c.y); delete window.__cn; }).catch(() => {});
  }
}


/* ---------- 下載並壓縮圖片,轉成內嵌資料 ---------- */
async function pullImage(u) {
  const r = await fetch(u, { credentials: 'omit' });
  if (!r.ok) throw new Error('http ' + r.status);
  const blob = await r.blob();
  if (!/^image\//.test(blob.type) || blob.size > 8e6) throw new Error('bad type/size');
  const bm = await createImageBitmap(blob);
  const k = Math.min(1, OUT_W / Math.max(bm.width, bm.height));
  const w = Math.max(1, Math.round(bm.width * k)), h = Math.max(1, Math.round(bm.height * k));
  const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d');
  const png = blob.type === 'image/png' && w * h <= 160000;
  if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
  g.drawImage(bm, 0, 0, w, h); bm.close();
  const out = await cv.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.8 });
  return `data:${out.type};base64,` + b64(await out.arrayBuffer());
}
async function pullAll(urls) {
  const res = new Array(urls.length).fill(null); let next = 0, budget = 15e6;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      try { const d = await pullImage(urls[i]); if (budget - d.length >= 0) { budget -= d.length; res[i] = d; } } catch (e) { /* 下載失敗就略過這張圖 */ }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return res;
}

/* ---------- 主流程 ---------- */
async function clip({ kind, tabId, tags = [], note = '' }) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) throw new Error('這個頁面(如 chrome:// 或商店頁)無法剪輯');
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: tab.title || '', url: tab.url, tags: tags.slice(0, 8), note, ts: Date.now() };
  let info = {};
  if (kind === 'simple') {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: simplifyInPage }).then(x => x[0].result);
    if (!r || !r.html || r.html.replace(/<[^>]+>/g, '').trim().length < 20) throw new Error('這個頁面抓不到主要內容,可試試整頁截圖');
    const data = await pullAll(r.imgs);
    let ok = 0;
    c.html = r.html.replace(/<img data-i="(\d+)">/g, (m, i) => data[+i] ? (ok++, `<img src="${data[+i]}">`) : '');
    info = { images: ok, failed: r.imgs.length - data.filter(Boolean).length };
    c.kind = 'html'; c.title = r.title || c.title; c.url = r.url;
  } else if (kind === 'article' || kind === 'selection' || kind === 'bookmark') {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: extractInPage, args: [kind === 'selection'] }).then(x => x[0].result);
    if (kind === 'selection' && !r.text) throw new Error('請先在網頁上選取(反白)要剪下的文字');
    c.kind = 'text'; c.title = r.title || c.title; c.url = r.url;
    c.text = kind === 'bookmark' ? (r.desc || '') : r.text;
    if (kind !== 'bookmark' && !c.text) throw new Error('這個頁面抓不到文字,可試試截圖');
  } else if (kind === 'shot' || kind === 'full') {
    Object.assign(c, { kind: 'shot' }, kind === 'full' ? await shotFull(tab) : await shotVisible(tab));
  } else throw new Error('未知的剪輯類型');
  await enqueue(q => [...q, c]);
  const apps = await chrome.tabs.query({ url: APP + '*' });
  if (!apps.length) await chrome.tabs.create({ url: APP, active: false });
  chrome.action.setBadgeBackgroundColor({ color: '#188038' }); chrome.action.setBadgeText({ text: '✓' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 3000);
  return info;
}

chrome.runtime.onMessage.addListener((m, s, send) => {
  if (m.type === 'clip') { clip(m).then(r => send({ ok: true, ...r }), e => send({ ok: false, error: String(e && e.message || e) })); return true; }
  if (m.type === 'ack') { enqueue(q => q.filter(c => c.id !== m.id)).then(() => send({}), () => send({})); return true; }
});

/* ---------- 右鍵選單 ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'selection', title: '剪下選取的文字到雲筆記', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'simple', title: '簡化擷取本頁(文字+圖片,去廣告留言)', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'article', title: '剪下本頁純文字到雲筆記', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'full', title: '整頁截圖到雲筆記', contexts: ['page'] });
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  clip({ kind: info.menuItemId, tabId: tab.id }).catch(e => {
    chrome.action.setBadgeBackgroundColor({ color: '#d93025' }); chrome.action.setBadgeText({ text: '!' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000); console.warn(e);
  });
});
