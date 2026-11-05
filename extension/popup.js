const DEF = '網頁剪輯', NEWV = '__new__';
const sel = document.getElementById('nb'), nbNew = document.getElementById('nbNew');
async function loadNbs() {
  const { nbs = [], nbSel } = await chrome.storage.local.get(['nbs', 'nbSel']);
  const opts = nbs.map(x => ({ v: x.id, t: '📓 ' + x.name, name: x.name }));
  if (!nbs.some(x => x.name === DEF)) opts.unshift({ v: 'name:' + DEF, t: '📓 ' + DEF + '(自動建立)', name: DEF });
  opts.push({ v: 'none', t: '未分類', name: '未分類' }, { v: NEWV, t: '＋ 新記事本…' });
  sel.innerHTML = opts.map(o => `<option value="${o.v.replace(/"/g, '&quot;')}">${o.t.replace(/</g, '&lt;')}</option>`).join('');
  const want = nbSel ? (nbSel.id || 'name:' + nbSel.name) : 'name:' + DEF;
  sel.value = opts.some(o => o.v === want) ? want : (opts.find(o => o.name === DEF) || opts[0]).v;
  document.getElementById('nbHint').hidden = nbs.length > 0;
}
function chosen() {
  if (sel.value === NEWV) { const n = nbNew.value.trim(); return n ? { name: n } : null; }
  if (sel.value === 'none') return { id: 'none', name: '未分類' };
  if (sel.value.startsWith('name:')) return { name: sel.value.slice(5) };
  return { id: sel.value, name: sel.options[sel.selectedIndex].text.replace(/^📓 /, '') };
}
sel.onchange = () => { nbNew.hidden = sel.value !== NEWV; if (!nbNew.hidden) nbNew.focus(); };
loadNbs();
const st = document.getElementById('st');
document.querySelectorAll('button.act').forEach(b => b.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  document.querySelectorAll('button.act').forEach(x => x.disabled = true);
  st.className = ''; st.textContent = b.dataset.k === 'full' ? '截圖中,請不要切換分頁…' : b.dataset.k === 'article' ? '擷取中,正在下載圖片,請稍候…' : '處理中…';
  const pick = chosen();
  if (!pick) { st.className = 'err'; st.textContent = '請輸入新記事本名稱'; document.querySelectorAll('button.act').forEach(x => x.disabled = false); return; }
  try { await chrome.storage.local.set({ nbSel: pick }); } catch (e) {}
  const tags = document.getElementById('tags').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const r = await chrome.runtime.sendMessage({ type: 'clip', kind: b.dataset.k, tabId: tab.id, tags, note: document.getElementById('note').value.trim(), nb: pick.id, nbName: pick.name });
  document.querySelectorAll('button.act').forEach(x => x.disabled = false);
  if (r && r.ok) { st.className = 'ok'; st.textContent = '✓ 已送到雲筆記「' + pick.name + '」' + (r.images != null ? `(圖片 ${r.images} 張${r.failed ? `,${r.failed} 張下載失敗` : ''})` : ''); setTimeout(() => window.close(), 1800); }
  else { st.className = 'err'; st.textContent = (r && r.error) || '失敗了,請再試一次'; }
});
