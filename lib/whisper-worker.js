// 錄音轉文字:在背景執行緒用 Whisper 模型(transformers.js)辨識,不會卡住畫面
import { pipeline, env } from './tfjs/transformers.min.js';
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = new URL('./tfjs/', import.meta.url).href;
let tr = null, curModel = '';
self.onmessage = async ev => {
  const m = ev.data;
  try {
    if (m.type === 'load') {
      if (!tr || curModel !== m.model) {
        tr = await pipeline('automatic-speech-recognition', m.model, { dtype: 'q8', device: 'wasm', progress_callback: p => self.postMessage({ type: 'progress', p }) });
        curModel = m.model;
      }
      self.postMessage({ type: 'ready' });
    } else if (m.type === 'run') {
      const out = await tr(m.audio, { language: m.lang, task: 'transcribe', chunk_length_s: 30 });
      self.postMessage({ type: 'text', id: m.id, text: (out && out.text) || '' });
    }
  } catch (e) { self.postMessage({ type: 'error', msg: String((e && e.message) || e) }); }
};
