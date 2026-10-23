// 在雲筆記網頁中執行:把佇列中的剪輯交給網頁,網頁確認收到後才從佇列移除
const post = (type, extra) => window.postMessage(Object.assign({ src: 'cloudnotes-ext', type }, extra), location.origin);
async function flush() {
  try {
    const { queue = [] } = await chrome.storage.local.get('queue');
    for (const clip of queue) post('clip', { clip });
  } catch (e) { /* 擴充套件重新載入後舊的 content script 會失效,忽略 */ }
}
window.addEventListener('message', e => {
  const d = e.data;
  if (e.source !== window || !d || d.src !== 'cloudnotes-app') return;
  if (d.type === 'ready') flush();
  if (d.type === 'ack' && typeof d.id === 'string') { try { chrome.runtime.sendMessage({ type: 'ack', id: d.id }); } catch (x) {} }
});
try { chrome.storage.onChanged.addListener(ch => { if (ch.queue) flush(); }); } catch (e) {}
flush();
setInterval(flush, 5000);
