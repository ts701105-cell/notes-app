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

/* ---------- 主流程 ---------- */
async function clip({ kind, tabId, tags = [], note = '' }) {
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:/i.test(tab.url || '')) throw new Error('這個頁面(如 chrome:// 或商店頁)無法剪輯');
  const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: tab.title || '', url: tab.url, tags: tags.slice(0, 8), note, ts: Date.now() };
  if (kind === 'article' || kind === 'selection' || kind === 'bookmark') {
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
  return {};
}

chrome.runtime.onMessage.addListener((m, s, send) => {
  if (m.type === 'clip') { clip(m).then(r => send({ ok: true, ...r }), e => send({ ok: false, error: String(e && e.message || e) })); return true; }
  if (m.type === 'ack') { enqueue(q => q.filter(c => c.id !== m.id)).then(() => send({}), () => send({})); return true; }
});

/* ---------- 右鍵選單 ---------- */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'selection', title: '剪下選取的文字到雲筆記', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'article', title: '剪下本頁文章到雲筆記', contexts: ['page'] });
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
