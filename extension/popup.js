const st = document.getElementById('st');
document.querySelectorAll('button.act').forEach(b => b.onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  document.querySelectorAll('button.act').forEach(x => x.disabled = true);
  st.className = ''; st.textContent = b.dataset.k === 'full' ? '截圖中,請不要切換分頁…' : '處理中…';
  const tags = document.getElementById('tags').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean);
  const r = await chrome.runtime.sendMessage({ type: 'clip', kind: b.dataset.k, tabId: tab.id, tags, note: document.getElementById('note').value.trim() });
  document.querySelectorAll('button.act').forEach(x => x.disabled = false);
  if (r && r.ok) { st.className = 'ok'; st.textContent = '✓ 已送到雲筆記「網頁剪輯」記事本'; setTimeout(() => window.close(), 1200); }
  else { st.className = 'err'; st.textContent = (r && r.error) || '失敗了,請再試一次'; }
});
