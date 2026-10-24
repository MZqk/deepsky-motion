/* ============================================================================
 * deepsky-motion — web/app.js
 *
 * Application flow: upload -> 分析 -> live preview -> params -> 生成视频 ->
 * artifacts. Vanilla ES modules, no framework, no CDN, fully offline.
 *
 * Talks to the HTTP API frozen in docs/CONTRACTS.md §3.8. Endpoint paths are
 * declared once in `API` below so a contract change is a one-line edit.
 * ========================================================================== */

import {
  createPreview,
  backendLabel,
  DEFAULT_PARAMS,
  withDefaults,
  previewKey,
} from './renderer.js';

/* ------------------------------------------------------------- endpoints -- */

const API = {
  upload: '/api/upload',
  preview: (id) => '/api/preview/' + encodeURIComponent(id),
  scene: (id) => '/api/scene/' + encodeURIComponent(id),
  params: (id) => '/api/scene/' + encodeURIComponent(id) + '/params',
  render: '/api/render',
  job: (id) => '/api/jobs/' + encodeURIComponent(id),
  jobEvents: (id) => '/api/jobs/' + encodeURIComponent(id) + '/events',
  cancel: (id) => '/api/jobs/' + encodeURIComponent(id) + '/cancel',
  health: '/api/health',
  clearPreview: (id) => '/api/jobs/' + encodeURIComponent(id) + '/preview/clear',
  sample: '/samples/nebula-1600.png',
};

const SAMPLE_NAME = 'nebula-1600.png';

/* ------------------------------------------------------- param metadata --- */
/* Every RenderParams key from CONTRACTS.md §2.4 gets exactly one control.
   `group` drives the panel headings, `note` is the inline hint. */

const PARAM_SPEC = [
  { key: 'durationSec', label: '时长', group: '时间', min: 2, max: 20, step: 0.5, unit: '秒', fmt: (v) => v.toFixed(1) },
  { key: 'fps', label: '帧率', group: '时间', min: 12, max: 60, step: 1, unit: 'fps', fmt: (v) => String(Math.round(v)) },
  { key: 'resolution', label: '分辨率（长边）', group: '时间', min: 480, max: 2560, step: 80, unit: 'px', fmt: (v) => String(Math.round(v)), note: '准确预览使用所选格式的实际输出尺寸' },
  { key: 'dollyEase', label: '推进曲线', group: '时间', type: 'segment', options: [['inOut', '缓入缓出'], ['linear', '匀速'], ['outIn', '缓出缓入'], ['easeOut', '渐停']] },
  { key: 'loopMode', label: '循环模式', group: '时间', type: 'segment', options: [['forward', '单向推进'], ['pingpong', '往返循环']], note: '往返循环可在动图与实况图中无缝首尾相接' },

  { key: 'dolly', label: '推进幅度', group: '纵深', min: 0, max: 1, step: 0.01, fmt: pct, note: '相机向前推进的距离' },
  { key: 'parallax', label: '视差强度', group: '纵深', min: 0, max: 2, step: 0.01, fmt: (v) => v.toFixed(2) + '×', note: '星点相对星云的位移倍率' },
  { key: 'depthSpread', label: '层间距', group: '纵深', min: 0, max: 1, step: 0.01, fmt: pct, note: '0 = 所有星点同层，1 = 拉满纵深' },
  { key: 'depthPower', label: '纵深分布', group: '纵深', min: 0.4, max: 3, step: 0.01, fmt: (v) => v.toFixed(2), note: '亮度到深度的映射指数' },
  { key: 'occlusion', label: '星云遮挡', group: '纵深', min: 0, max: 1, step: 0.01, fmt: pct, note: '亮区压暗其后的星点，强化前后关系' },
  { key: 'coc', label: '焦外虚化', group: '焦外', min: 0, max: 1, step: 0.01, fmt: pct, note: '偏离对焦平面的星点弥散程度' },
  { key: 'focus', label: '对焦平面', group: '焦外', min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2), note: '合焦所在的深度层（0 = 最近，1 = 最远）' },

  { key: 'twinkle', label: '闪烁', group: '星点', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'starScale', label: '星点大小', group: '星点', min: 0.5, max: 2, step: 0.01, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'starGain', label: '星点亮度', group: '星点', min: 0.2, max: 2, step: 0.01, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'starColor', label: '恒星色彩', group: '星点', min: 0, max: 2, step: 0.05, fmt: pct, note: '保持恒星真实天体物理光谱色彩' },
  { key: 'bloom', label: '光晕', group: '星点', min: 0, max: 1, step: 0.01, fmt: pct },

  { key: 'nebulaGain', label: '星云亮度', group: '画面', min: 0.2, max: 2, step: 0.01, fmt: (v) => v.toFixed(2) + '×' },
  { key: 'background', label: '背景辉光', group: '画面', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'vignette', label: '暗角', group: '画面', min: 0, max: 1, step: 0.01, fmt: pct },
  { key: 'seed', label: '随机种子', group: '画面', min: 0, max: 9999, step: 1, fmt: (v) => String(Math.round(v)), note: '相同种子 = 完全一致的闪烁与噪声' },
];

function pct(v) { return Math.round(v * 100) + '%'; }

const PRESETS = {
  natural: { dolly: 0.45, parallax: 1, depthSpread: 0.6, depthPower: 1.35, twinkle: 0.25, starScale: 1, starColor: 0.85, bloom: 0.16, starGain: 1.0, nebulaGain: 1.05, coc: 0.06, background: 0, vignette: 0.15, dollyEase: 'inOut', loopMode: 'forward' },
  dreamy: { dolly: 0.62, parallax: 1.45, depthSpread: 0.85, depthPower: 1.1, twinkle: 0.55, starScale: 1.15, starColor: 1.1, bloom: 0.32, starGain: 1.05, nebulaGain: 1.15, coc: 0.12, background: 0.25, vignette: 0.25, dollyEase: 'inOut', loopMode: 'pingpong' },
  deep: { dolly: 0.8, parallax: 1.8, depthSpread: 1, depthPower: 2.1, twinkle: 0.15, starScale: 0.9, starColor: 0.9, bloom: 0.10, starGain: 0.90, nebulaGain: 1.10, coc: 0.04, background: 0.05, vignette: 0.25, dollyEase: 'linear', loopMode: 'forward' },
  subtle: { dolly: 0.28, parallax: 0.55, depthSpread: 0.35, depthPower: 1.6, twinkle: 0.1, starScale: 0.85, starColor: 0.7, bloom: 0.06, starGain: 0.85, nebulaGain: 1.0, coc: 0.02, background: 0, vignette: 0.1, dollyEase: 'easeOut', loopMode: 'forward' },
};

/* ------------------------------------------------------------- DOM lookup -- */

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $('stage-canvas'),
  canvasWrap: $('canvas-wrap'),
  stageViewport: $('stage-viewport'),
  thirds: $('thirds'),
  canvasEmpty: $('canvas-empty'),
  canvasBusy: $('canvas-busy'),
  busyLabel: $('busy-label'),
  busyElapsed: $('busy-elapsed'),
  badgeSrc: $('badge-src'),

  engineChip: $('engine-chip'), engineDot: $('engine-dot'), engineLabel: $('engine-label'),
  healthChip: $('health-chip'), healthDot: $('health-dot'), healthLabel: $('health-label'),

  sceneHint: $('scene-hint'),
  readoutStars: $('readout-stars'),
  readoutFps: $('readout-fps'),
  btnThirds: $('btn-thirds'),
  btnReplay: $('btn-replay'),
  btnPlay: $('btn-play'),
  playLabel: $('play-label'),
  icoPlay: document.querySelector('.ico-play'),
  icoPause: document.querySelector('.ico-pause'),

  scrub: $('scrub'),
  scrubOut: $('scrub-out'),
  timeOut: $('time-out'),

  dropzone: $('dropzone'),
  fileInput: $('file-input'),
  btnSample: $('btn-sample'),
  btnClear: $('btn-clear'),
  btnEmptyPick: $('btn-empty-pick'),
  btnEmptySample: $('btn-empty-sample'),
  sourceMeta: $('source-meta'),
  srcName: $('src-name'), srcDims: $('src-dims'), srcId: $('src-id'),
  srcWarnings: $('src-warnings'),
  btnAnalyze: $('btn-analyze'), analyzeLabel: $('analyze-label'),

  analysisTag: $('analysis-tag'),
  stCount: $('st-count'), stFwhm: $('st-fwhm'), stEllip: $('st-ellip'), stDensity: $('st-density'),
  histCanvas: $('hist-canvas'), histRange: $('hist-range'),
  analysisNotes: $('analysis-notes'),

  params: $('params'),
  presets: $('presets'),
  btnReset: $('btn-reset'),

  format: $('format'),
  formatNote: $('format-note'),
  btnRender: $('btn-render'), renderLabel: $('render-label'),
  btnPreview: $('btn-preview'),
  progressWrap: $('progress-wrap'),
  progressbar: $('progressbar'), progressFill: $('progress-fill'),
  jobStage: $('job-stage'), jobPct: $('job-pct'), jobMessage: $('job-message'),
  btnCancel: $('btn-cancel'),
  artifacts: $('artifacts'), artifactList: $('artifact-list'), artifactPreview: $('artifact-preview'),
  jobStatus: $('job-status'),

  statusMsg: $('status-msg'), statusRes: $('status-res'),
  statusBackend: $('status-backend'), statusVersion: $('status-version'),
  toasts: $('toasts'),
};

/* ----------------------------------------------------------------- state -- */

const state = {
  sourceId: null,
  filename: null,
  width: 0,
  height: 0,
  scene: null,
  recommended: null,
  analyzed: false,
  analyzing: false,
  params: withDefaults({}),
  activePreset: 'natural',
  jobId: null,
  jobActive: false,
  jobPoll: 0,
  jobSSE: null,
  artifacts: [],
  serverDefaults: null,
  userTouched: {},
  busyTimer: 0,
  busyStart: 0,
  reducedMotion: false,
  prepared: null,
  jobKey: null,
  exportRequested: false,
  sourceVersion: 0,
  cancelRequested: false,
  loadingPreview: false,
};

/** @type {import('./renderer.js').PreviewRenderer|null} */
let preview = null;

/* ---------------------------------------------------------------- helpers -- */

function toast(kind, title, msg, ms = 5200) {
  const node = document.createElement('div');
  node.className = 'toast toast-' + kind;
  const body = document.createElement('div');
  body.className = 'toast-body';
  const t = document.createElement('div');
  t.className = 'toast-title';
  t.textContent = title;
  body.appendChild(t);
  if (msg) {
    const m = document.createElement('div');
    m.className = 'toast-msg';
    m.textContent = msg;
    body.appendChild(m);
  }
  node.appendChild(body);
  el.toasts.appendChild(node);
  const kill = () => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 200);
  };
  node.addEventListener('click', kill);
  if (ms > 0) setTimeout(kill, ms);
  return node;
}

function setStatus(msg) {
  el.statusMsg.textContent = msg;
}

function busy(on, label) {
  if (on) {
    state.busyStart = performance.now();
    if (label) el.busyLabel.textContent = label;
    el.canvasBusy.hidden = false;
    if (!state.busyTimer) {
      state.busyTimer = setInterval(() => {
        const s = (performance.now() - state.busyStart) / 1000;
        el.busyElapsed.textContent = s.toFixed(1) + 's';
      }, 100);
    }
  } else {
    el.canvasBusy.hidden = true;
    if (state.busyTimer) { clearInterval(state.busyTimer); state.busyTimer = 0; }
    el.busyElapsed.textContent = '0.0s';
  }
}

function setBtnBusy(btn, on) {
  btn.classList.toggle('is-busy', !!on);
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
}

/** Format a byte count for humans. */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtNum(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

/* ------------------------------------------------------------- API client -- */

/**
 * Fetch JSON with a hard timeout and a friendly error.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs]
 */
async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = { raw: text.slice(0, 400) }; }
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || ('HTTP ' + res.status + ' ' + res.statusText));
      err.code = (body && body.code) || 'HTTP_' + res.status;
      err.status = res.status;
      throw err;
    }
    return body;
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error('请求超时（' + Math.round(timeoutMs / 1000) + 's）');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- renderer glue -- */

function initRenderer() {
  state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  preview = createPreview(el.canvas, {
    onStats: (stats, progress) => {
      el.readoutFps.querySelector('b').textContent = stats.fps ? Math.round(stats.fps) : '—';
      const label = backendLabel(stats.backend);
      el.engineLabel.textContent = label;
      el.statusBackend.textContent = label;
      el.engineDot.className = 'dot ' + (stats.backend === 'none' ? 'is-bad' : 'is-ok');
      syncScrub(progress);
      syncPlayButton();
      updatePreviewControls();
    },
    onError: (err) => {
      if (state.prepared) state.prepared.key = null;
      toast('error', '准确预览播放失败', err.message);
      el.sceneHint.textContent = err.message;
      finishRenderButton();
    },
  });
  // The canvas element may have been swapped for a fresh one during the 2D
  // fallback (see PreviewRenderer._init2D); keep our reference current.
  if (preview.canvas && preview.canvas !== el.canvas) {
    el.canvas = preview.canvas;
    el.canvas.id = 'stage-canvas';
  }
  const label = backendLabel(preview.backend);
  el.engineLabel.textContent = label;
  el.statusBackend.textContent = label;
  el.engineDot.className = 'dot ' + (preview.backend === 'none' ? 'is-bad' : 'is-ok');
  if (preview.backend === 'none') {
    toast('error', '无法创建预览画布', '浏览器不支持 Canvas 2D。');
  }
  return preview;
}

function syncPlayButton() {
  const playing = preview ? preview.playing : false;
  el.btnPlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
  el.playLabel.textContent = playing ? '暂停' : '播放';
  if (el.icoPlay) el.icoPlay.toggleAttribute('hidden', playing);
  if (el.icoPause) el.icoPause.toggleAttribute('hidden', !playing);
}

let scrubbing = false;

function syncScrub(t) {
  const stats = preview?.getStats();
  el.timeOut.textContent = (stats?.timeSec || 0).toFixed(3) + ' / ' + (stats?.durationSec || 0).toFixed(3) + 's';
  if (scrubbing) return;
  const max = Math.max(0, (preview?.frameCount || 1) - 1);
  el.scrub.max = String(max);
  const v = Math.round(t * max);
  el.scrub.value = String(v);
  el.scrub.style.setProperty('--pct', (t * 100).toFixed(2) + '%');
  el.scrubOut.textContent = (t * 100).toFixed(1) + '%';
}

function currentPreviewKey() { return previewKey(state.sourceId, state.params, el.format.value); }

function updatePreviewControls() {
  const playable = !!preview?.manifest && preview._ready;
  const draftable = !!state.sourceId && !!state.analyzed;
  el.btnPlay.disabled = el.btnReplay.disabled = !playable;
  el.scrub.disabled = !(playable || draftable);
  el.btnPreview.disabled = !(state.sourceId && state.analyzed) || state.jobActive;
}

function invalidatePreview(message = '参数已更改，请重新生成准确预览') {
  if (state.prepared && state.prepared.key !== currentPreviewKey()) {
    state.prepared = null;
  }
  if (state.prepared) {
    el.sceneHint.textContent = '准确预览与当前导出一致';
  } else if (state.analyzed) {
    el.sceneHint.textContent = '实时草稿（参数已更新）· 点击「生成准确预览」渲染最终视频效果';
  }
  el.artifacts.hidden = true;
  finishRenderButton();
}

/** Lay the canvas out inside the stage viewport (letterboxed). */
function relayout() {
  if (!preview) return;
  const vp = el.stageViewport;
  const rect = vp.getBoundingClientRect();
  const availW = Math.max(120, rect.width - 8);
  const availH = Math.max(100, rect.height - 8);
  preview.layout(availW, availH);
  preview.render();
}

/* --------------------------------------------------------------- uploads -- */

function setSource(info) {
  if (state.prepared) fetchJson(API.clearPreview(state.prepared.job.id), { method: 'POST' }).catch(() => {});
  state.prepared = null;
  state.scene = null;
  state.recommended = null;
  state.userTouched = {};
  state.analyzed = false;
  resetAnalysisPanel();
  if (preview) preview.setScene(null, { plate: null });
  state.sourceId = info.id;
  state.filename = info.filename || '未命名';
  state.width = info.width || 0;
  state.height = info.height || 0;

  el.srcName.textContent = state.filename;
  el.srcDims.textContent = state.width && state.height ? state.width + ' × ' + state.height : '—';
  el.srcId.textContent = state.sourceId;
  el.sourceMeta.hidden = false;
  el.badgeSrc.hidden = false;
  el.badgeSrc.textContent = state.filename + (state.width ? '  ·  ' + state.width + '×' + state.height : '');

  const warnings = Array.isArray(info.warnings) ? info.warnings : [];
  if (warnings.length) {
    el.srcWarnings.hidden = false;
    el.srcWarnings.replaceChildren();
    const ul = document.createElement('ul');
    for (const w of warnings) {
      const li = document.createElement('li');
      li.textContent = '⚠ ' + w;
      ul.appendChild(li);
    }
    el.srcWarnings.appendChild(ul);
  } else {
    el.srcWarnings.hidden = true;
    el.srcWarnings.replaceChildren();
  }

  el.btnAnalyze.disabled = false;
  el.btnClear.disabled = false;
  el.statusRes.textContent = state.width ? state.width + '×' + state.height : '—';
  setStatus('已上传 ' + state.filename + ' · 点「分析」提取星点与深度');
}

function clearSource() {
  state.sourceVersion++;
  if (state.prepared) fetchJson(API.clearPreview(state.prepared.job.id), { method: 'POST' }).catch(() => {});
  state.prepared = null;
  state.sourceId = null;
  state.filename = null;
  state.scene = null;
  state.recommended = null;
  state.userTouched = {};
  state.analyzed = false;
  state.width = 0;
  state.height = 0;
  el.sourceMeta.hidden = true;
  el.badgeSrc.hidden = true;
  el.btnAnalyze.disabled = true;
  el.btnClear.disabled = true;
  el.btnRender.disabled = true;
  el.canvasEmpty.hidden = false;
  el.canvasWrap.classList.remove('is-live');
  el.canvasWrap.classList.add('is-empty');
  resetAnalysisPanel();
  el.statusRes.textContent = '—';
  setStatus('就绪 · 拖入一张深空照片开始');
  el.sceneHint.textContent = '尚未载入素材';
  el.readoutStars.querySelector('b').textContent = '—';
  updatePreviewControls();
  if (preview) {
    preview.setScene(null, { plate: null });
    preview.setProgress(0);
    preview.render();
  }
}

async function uploadFile(file) {
  if (!file) return;
  const maxBytes = 256 * 1024 * 1024;
  if (file.size > maxBytes) {
    toast('error', '文件过大', '上限 256 MB，当前 ' + fmtBytes(file.size) + '。');
    return;
  }
  const version = ++state.sourceVersion;
  if (state.jobActive) cancelRender();
  setStatus('正在上传 ' + file.name + ' …');
  busy(true, '上传中…');
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const res = await fetchJson(API.upload, { method: 'POST', body: fd }, 180000);
    if (!res || !res.id) throw new Error('上传响应缺少 id 字段');
    if (version !== state.sourceVersion) return;
    setSource(res);
    // show the normalized preview immediately, before analysis
    await loadPreviewImage(res.previewUrl || API.preview(res.id));
    toast('ok', '上传成功', (res.filename || file.name) + (res.width ? ' · ' + res.width + '×' + res.height : ''));
  } catch (e) {
    toast('error', '上传失败', e.message);
    setStatus('上传失败：' + e.message);
  } finally {
    busy(false);
  }
}

/** Show the normalized source until an accurate preview has been generated. */
async function loadPreviewImage(url, version = state.sourceVersion) {
  const image = await loadImageElement(url);
  if (version !== state.sourceVersion || !preview) return;
  preview.setPlate(image);
  el.canvasWrap.classList.remove('is-empty');
  el.canvasEmpty.hidden = true;
  relayout();
  preview.render();
}

async function loadSample() {
  setStatus('正在获取示例素材 …');
  busy(true, '获取示例…');
  try {
    const res = await fetch(API.sample, { cache: 'no-store' });
    if (!res.ok) throw new Error('示例文件不可用（HTTP ' + res.status + '）');
    const blob = await res.blob();
    const file = new File([blob], SAMPLE_NAME, { type: blob.type || 'image/png' });
    busy(false);
    await uploadFile(file);
    await analyze();
  } catch (e) {
    busy(false);
    toast('error', '示例载入失败', e.message + '（示例由 samples/ 提供，需先运行 pnpm samples）');
    setStatus('示例载入失败');
  }
}

/* -------------------------------------------------------------- analysis -- */

function resetAnalysisPanel() {
  state.analyzed = false;
  el.analysisTag.textContent = '未分析';
  el.analysisTag.className = 'panel-tag';
  for (const node of [el.stCount, el.stFwhm, el.stEllip, el.stDensity]) {
    node.textContent = '—';
    node.classList.add('is-null');
  }
  el.histRange.textContent = '近 — · 远 —';
  el.analysisNotes.hidden = true;
  drawHistogram(null);
  el.btnRender.disabled = true;
}

async function analyze() {
  if (!state.sourceId || state.analyzing) return;
  const sourceId = state.sourceId;
  const version = state.sourceVersion;
  state.analyzing = true;
  setBtnBusy(el.btnAnalyze, true);
  el.btnAnalyze.disabled = true;
  el.analyzeLabel.textContent = '分析中…';
  el.analysisTag.textContent = '分析中';
  el.analysisTag.className = 'panel-tag is-warn';
  busy(true, '分析中（首次较慢）…');
  setStatus('正在分析星点、PSF 与深度 …');

  try {
    const payload = await fetchJson(API.scene(sourceId), {}, 180000);
    if (sourceId !== state.sourceId || version !== state.sourceVersion) return;
    const scene = payload && payload.scene ? payload.scene : payload;
    if (!scene || !Array.isArray(scene.stars)) throw new Error('分析结果缺少 scene.stars');

    state.scene = scene;
    state.analyzed = true;
    const recommended = scene.recommended || payload.recommended;
    state.recommended = recommended || null;

    // 若用户未手动改动过参数，自动应用自适应星点默认值
    if (recommended && Object.keys(state.userTouched).length === 0) {
      state.params = withDefaults({ ...state.params, ...recommended });
      syncParamPanel();
      if (['depthSpread', 'depthPower', 'seed'].some((k) => k in recommended)) {
        updateDepthsLocal();
      }
    }

    if (state.prepared) fetchJson(API.clearPreview(state.prepared.job.id), { method: 'POST' }).catch(() => {});
    state.prepared = null;
    preview.setScene(scene);
    preview.setParams(state.params);
    await loadPreviewImage(payload.sourceUrl || payload.previewUrl || API.preview(sourceId), version);
    if (sourceId !== state.sourceId || version !== state.sourceVersion) return;

    renderAnalysis(payload);
    el.btnRender.disabled = false;
    el.canvasWrap.classList.add('is-live');
    el.canvasEmpty.hidden = true;
    relayout();
    syncPlayButton();
    el.sceneHint.textContent = '原图 · 点击「生成准确预览」查看最终结果';
    updatePreviewControls();
    el.readoutStars.querySelector('b').textContent = String(scene.stars.length);
    el.statusRes.textContent = scene.width + '×' + scene.height;
    setStatus('分析完成 · 检出 ' + scene.stars.length + ' 颗星 · 可调参并生成视频');
    const SCENE_NAMES = {
      nebula: '弥漫星云',
      galaxy: '河外星系',
      cluster: '密集星团',
      widefield: '广角星野',
    };
    const sceneLabel = recommended?.inferredScene ? (SCENE_NAMES[recommended.inferredScene] || recommended.inferredScene) : '';
    const sceneTip = sceneLabel ? `，已自适应匹配「${sceneLabel}」星点基座。` : '，已按深度分层。';
    toast('ok', '分析完成', '检出 ' + scene.stars.length + ' 颗星点' + sceneTip);
  } catch (e) {
    el.analysisTag.textContent = '失败';
    el.analysisTag.className = 'panel-tag is-warn';
    toast('error', '分析失败', e.message);
    setStatus('分析失败：' + e.message);
  } finally {
    state.analyzing = false;
    setBtnBusy(el.btnAnalyze, false);
    el.btnAnalyze.disabled = !state.sourceId;
    el.analyzeLabel.textContent = state.analyzed ? '重新分析' : '分析';
    busy(false);
  }
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.decoding = 'async';
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('无法加载 ' + url));
    i.src = url;
  });
}

function renderAnalysis(payload) {
  const scene = state.scene || {};
  const psf = scene.psf || {};
  el.analysisTag.textContent = '已分析';
  el.analysisTag.className = 'panel-tag is-ok';

  setStat(el.stCount, Number.isFinite(psf.starCount) ? String(Math.round(psf.starCount)) : String(scene.stars.length));
  setStat(el.stFwhm, Number.isFinite(psf.medianFwhm) ? fmtNum(psf.medianFwhm, 2) + ' px' : '—');
  setStat(el.stEllip, Number.isFinite(psf.medianEllipticity) ? fmtNum(psf.medianEllipticity, 3) : '—');
  setStat(el.stDensity, Number.isFinite(psf.density) ? fmtNum(psf.density, 4) : '—');

  const d = scene.depth || {};
  el.histRange.textContent = '近 ' + fmtNum(d.zStarsNear, 2) + ' · 远 ' + fmtNum(d.zStarsFar, 2);

  const hist = Array.isArray(payload && payload.depthHistogram) ? payload.depthHistogram
    : Array.isArray(d.histogram) ? d.histogram
    : computeHistogram(scene.stars);
  drawHistogram(hist);

  const notes = [];
  if (scene.meta && Array.isArray(scene.meta.notes)) notes.push(...scene.meta.notes);
  if (scene.meta && scene.meta.sourceName) notes.unshift('来源：' + scene.meta.sourceName);
  if (psf.brightest !== undefined && psf.faintest !== undefined) {
    notes.push('星等范围：' + fmtNum(psf.brightest, 2) + ' … ' + fmtNum(psf.faintest, 2));
  }
  const rec = state.recommended || scene.recommended;
  const SCENE_NAMES = {
    nebula: '弥漫星云',
    galaxy: '河外星系',
    cluster: '密集星团',
    widefield: '广角星野',
  };
  if (rec && rec.inferredScene) {
    const sceneName = SCENE_NAMES[rec.inferredScene] || rec.inferredScene;
    notes.push(`画面特征：${sceneName}（已匹配自适应基座：大小 ${rec.starScale}×，亮度 ${rec.starGain}×，色彩 ${pct(rec.starColor)}）`);
  }
  if (notes.length) {
    el.analysisNotes.hidden = false;
    el.analysisNotes.textContent = notes.join('\n');
  } else {
    el.analysisNotes.hidden = true;
  }
}

function setStat(node, text) {
  node.textContent = text;
  node.classList.toggle('is-null', text === '—');
}

/** 12-bucket depth histogram, used only when the server does not send one. */
function computeHistogram(stars, buckets = 12) {
  const out = new Array(buckets).fill(0);
  if (!Array.isArray(stars) || !stars.length) return out;
  for (const s of stars) {
    const z = Number.isFinite(s.z) ? Math.min(0.999999, Math.max(0, s.z)) : 0.5;
    out[Math.floor(z * buckets)]++;
  }
  const max = Math.max(1, ...out);
  return out.map((v) => v / max);
}

function drawHistogram(hist) {
  const c = el.histCanvas;
  const ctx = c.getContext('2d');
  const W = c.width;
  const H = c.height;
  const dpr = 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(4,9,16,0.5)';
  ctx.fillRect(0, 0, W, H);

  // baseline grid
  ctx.strokeStyle = 'rgba(148,190,205,0.10)';
  ctx.lineWidth = dpr;
  for (let i = 1; i < 4; i++) {
    const y = Math.round((H * i) / 4) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  if (!hist || !hist.length) {
    ctx.fillStyle = 'rgba(125,143,156,0.5)';
    ctx.font = (11 * dpr) + 'px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('尚无深度数据', W / 2, H / 2 + 4 * dpr);
    return;
  }

  const max = Math.max(1e-6, ...hist.map((v) => Number(v) || 0));
  const n = hist.length;
  const gap = 3 * dpr;
  const bw = (W - gap * (n + 1)) / n;
  const grad = ctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, 'rgba(53,184,166,0.45)');
  grad.addColorStop(1, 'rgba(94,234,212,0.95)');

  for (let i = 0; i < n; i++) {
    const v = Math.max(0, Number(hist[i]) || 0) / max;
    const h = Math.max(1.5 * dpr, v * (H - 10 * dpr));
    const x = gap + i * (bw + gap);
    ctx.fillStyle = grad;
    ctx.fillRect(x, H - h - 3 * dpr, bw, h);
  }

  // depth axis caption
  ctx.fillStyle = 'rgba(125,143,156,0.75)';
  ctx.font = (9.5 * dpr) + 'px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.fillText('近', 4 * dpr, H - 4 * dpr);
  ctx.textAlign = 'right';
  ctx.fillText('远', W - 4 * dpr, H - 4 * dpr);
}

/* ---------------------------------------------------------- param panel -- */

function buildParamPanel() {
  const frag = document.createDocumentFragment();
  let lastGroup = null;
  const controls = new Map();

  for (const spec of PARAM_SPEC) {
    if (spec.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'group-head';
      h.textContent = spec.group;
      frag.appendChild(h);
      lastGroup = spec.group;
    }

    const wrap = document.createElement('div');
    wrap.className = 'param';
    wrap.id = 'param-' + spec.key;

    const head = document.createElement('div');
    head.className = 'param-head';
    const label = document.createElement('label');
    label.htmlFor = 'in-' + spec.key;
    label.textContent = spec.label;
    head.appendChild(label);

    if (spec.type === 'segment') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', spec.label);
      const buttons = [];
      for (const [value, text] of spec.options) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.dataset.value = value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => {
          setParam(spec.key, value);
          markPresetCustom();
        });
        seg.appendChild(b);
        buttons.push(b);
      }
      wrap.appendChild(head);
      wrap.appendChild(seg);
      controls.set(spec.key, { kind: 'segment', buttons, spec });
    } else {
      const val = document.createElement('span');
      val.className = 'val';
      head.appendChild(val);
      wrap.appendChild(head);

      const input = document.createElement('input');
      input.type = 'range';
      input.id = 'in-' + spec.key;
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(state.params[spec.key]);
      input.setAttribute('aria-describedby', 'note-' + spec.key);
      input.addEventListener('input', () => {
        setParam(spec.key, Number(input.value));
        markPresetCustom();
      });
      wrap.appendChild(input);
      controls.set(spec.key, { kind: 'range', input, val, spec });
    }

    if (spec.note) {
      const note = document.createElement('p');
      note.className = 'param-note';
      note.id = 'note-' + spec.key;
      note.textContent = spec.note;
      wrap.appendChild(note);
    }
    frag.appendChild(wrap);
  }

  el.params.replaceChildren(frag);
  return controls;
}

let paramControls = new Map();

function updateDepthsLocal() {
  if (!state.scene || !Array.isArray(state.scene.stars) || !state.scene.stars.length) return;
  const stars = state.scene.stars;
  const spread = Math.max(0, Math.min(1, state.params.depthSpread ?? 0.6));
  const power = Math.max(0.3, Math.min(3, state.params.depthPower ?? 1.35));
  const zNebula = 0.3;
  const seed = (state.params.seed ?? 1337) >>> 0;

  // deterministic PRNG matching mulberry32
  let s = (seed ^ 0x5f3759df) >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let magBright = Infinity;
  let magFaint = -Infinity;
  for (let i = 0; i < stars.length; i++) {
    const m = stars[i].mag;
    if (m != null && Number.isFinite(m)) {
      if (m < magBright) magBright = m;
      if (m > magFaint) magFaint = m;
    }
  }
  if (!Number.isFinite(magBright)) { magBright = 0; magFaint = 10; }
  const range = Math.max(0.35, magFaint - magBright);

  const zNear = Math.max(0.02, zNebula - 0.3 * spread);
  const zFar = Math.min(1, zNebula + (1 - zNebula) * (0.55 + 0.45 * spread));

  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    const m = (st.mag != null && Number.isFinite(st.mag)) ? st.mag : (magBright + range * 0.5);
    const t = Math.max(0, Math.min(1, (m - magBright) / range));
    let z = zNear + (zFar - zNear) * Math.pow(t, power);
    if (rand() < 0.1) {
      z = 0.02 + Math.max(0.02, zNebula - 0.08) * rand();
    }
    st.z = Math.max(0, Math.min(1, z));
  }

  el.histRange.textContent = '近 ' + fmtNum(zNear, 2) + ' · 远 ' + fmtNum(zFar, 2);
  const hist = computeHistogram(stars);
  drawHistogram(hist);
}

let syncParamsTimer = 0;
function scheduleSyncParams() {
  if (!state.sourceId || !state.analyzed) return;
  if (syncParamsTimer) clearTimeout(syncParamsTimer);
  syncParamsTimer = setTimeout(async () => {
    syncParamsTimer = 0;
    try {
      const res = await fetchJson(API.params(state.sourceId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: state.params }),
      }, 10000);
      if (res && res.depthHistogram) {
        drawHistogram(res.depthHistogram);
      }
    } catch (_) {
      // transient local sync failure can be ignored
    }
  }, 350);
}

function setParam(key, value) {
  state.params[key] = value;
  state.userTouched[key] = value;
  if (preview) {
    if (preview.manifest) {
      preview.returnToDraft(true);
      if (state.prepared) state.prepared = null;
    }
    preview.setParams(state.params);
  }
  syncParamPanel();

  if (['depthSpread', 'depthPower', 'seed'].includes(key)) {
    updateDepthsLocal();
    scheduleSyncParams();
  }

  if (preview) preview.render();
  syncScrub(preview ? preview.progress : 0);
  invalidatePreview();
}

function syncParamPanel() {
  for (const [key, c] of paramControls) {
    const v = state.params[key];
    if (c.kind === 'range') {
      const pctVal = ((v - c.spec.min) / (c.spec.max - c.spec.min)) * 100;
      if (document.activeElement !== c.input) c.input.value = String(v);
      c.input.style.setProperty('--pct', pctVal.toFixed(2) + '%');
      c.val.textContent = c.spec.fmt ? c.spec.fmt(Number(v)) : String(v);
    } else {
      for (const b of c.buttons) {
        const on = b.dataset.value === String(v);
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
    }
  }
}

function applyParams(patch, presetName) {
  state.params = withDefaults({ ...state.params, ...patch });
  if (preview) {
    if (preview.manifest) {
      preview.returnToDraft(true);
      if (state.prepared) state.prepared = null;
    }
    preview.setParams(state.params);
  }
  syncParamPanel();

  const touchedDepth = Object.keys(patch).some((k) => ['depthSpread', 'depthPower', 'seed'].includes(k));
  if (touchedDepth) {
    updateDepthsLocal();
    scheduleSyncParams();
  }

  if (preview) preview.render();
  syncScrub(preview ? preview.progress : 0);
  invalidatePreview();
  if (presetName) {
    state.activePreset = presetName;
    for (const b of el.presets.querySelectorAll('.chip-btn')) {
      b.classList.toggle('is-active', b.dataset.preset === presetName);
    }
  }
}

function markPresetCustom() {
  state.activePreset = null;
  for (const b of el.presets.querySelectorAll('.chip-btn')) b.classList.remove('is-active');
}

function resetParams() {
  state.userTouched = {};
  const base = state.recommended ? { ...DEFAULT_PARAMS, ...state.recommended } : { ...DEFAULT_PARAMS };
  applyParams(base, 'natural');
  toast('info', '参数已重置', state.recommended ? '已恢复为当前画面的自适应推荐基座。' : '已恢复默认值。');
}

/* ------------------------------------------------------------- job flow -- */

/**
 * Job status -> Chinese label.
 *
 * The server sets `status` to an English enum (queued|running|done|error|
 * canceled) and `stage` to an already-localized Chinese string
 * ('排队中','渲染帧','编码视频','编码动图','生成实况图','完成'). We prefer
 * `stage` for display and fall back to these labels for the enum.
 */
const STAGE_LABELS = {
  queued: '排队中',
  analyzing: '分析中',
  running: '渲染中',
  rendering: '渲染中',
  encoding: '编码中',
  done: '完成',
  error: '失败',
  canceled: '已取消',
};

/** Statuses that mean the job has stopped. */
const TERMINAL = new Set(['done', 'error', 'canceled']);

/** Short label for a job snapshot: prefer the server's localized stage. */
function stageLabel(job) {
  if (!job) return '';
  if (job.status === 'error') return STAGE_LABELS.error;
  if (job.status === 'canceled') return STAGE_LABELS.canceled;
  if (job.status === 'done') return STAGE_LABELS.done;
  const stage = typeof job.stage === 'string' && job.stage.trim() ? job.stage.trim() : '';
  return stage || STAGE_LABELS[job.status] || job.status || '';
}

const FORMAT_NOTES = {
  mp4: '兼容性最好，适合社交平台与归档。',
  livephoto: 'Apple 实况照片（HEIC/JPEG + MOV），可在 iOS 相册中长按播放。',
  motionphoto: 'Google 动态照片（JPEG + 内嵌 MP4），Android 相册可直接播放。',
  webp: '动态 WebP，体积小，浏览器与聊天软件通用。',
  apng: '无损动态 PNG，体积较大但画质最忠实。',
  gif: '最通用的动图，颜色受限（256 色）。',
};

async function startRender(exportRequested = true) {
  if (!state.sourceId || !state.analyzed) return;
  const key = currentPreviewKey();
  if (state.jobActive) {
    if (state.jobKey === key && exportRequested) {
      state.exportRequested = true;
      finishRenderButton();
    } else {
      toast('info', '已有生成任务', '请等待当前任务完成或取消后重新生成。');
    }
    return;
  }
  if (state.prepared?.key === key) {
    if (exportRequested) renderArtifacts(state.prepared.job.artifacts);
    return;
  }
  const context = { key, sourceVersion: state.sourceVersion };
  const body = { id: state.sourceId, params: { ...state.params }, format: el.format.value, preview: true };
  state.jobActive = true;
  state.jobId = null;
  state.jobKey = key;
  state.exportRequested = exportRequested;
  state.cancelRequested = false;
  finishRenderButton();
  el.progressWrap.hidden = false;
  el.artifacts.hidden = true;
  el.artifactList.replaceChildren();
  el.artifactPreview.hidden = true;
  el.artifactPreview.replaceChildren();
  el.sceneHint.textContent = '正在生成最终文件与准确预览…';
  setProgress(0, STAGE_LABELS.queued, '正在提交任务…');
  setStatus('正在生成准确预览 …');

  try {
    const res = await fetchJson(API.render, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 60000);
    if (!res?.jobId) throw new Error('渲染响应缺少 jobId');
    state.jobId = res.jobId;
    if (state.cancelRequested || context.sourceVersion !== state.sourceVersion) await cancelRender();
    await onJobDone(await watchJob(res.jobId), context);
  } catch (err) {
    toast('error', '无法生成准确预览', err.message);
    setStatus('生成失败：' + err.message);
    el.sceneHint.textContent = '准确预览未更新，请重新生成';
  } finally {
    state.jobActive = false;
    state.jobKey = null;
    finishRenderButton();
  }
}

function setProgress(p, stageText, message) {
  const pct = Math.max(0, Math.min(100, Math.round((p || 0) * 100)));
  el.progressFill.style.width = pct + '%';
  el.progressbar.setAttribute('aria-valuenow', String(pct));
  el.progressbar.classList.remove('is-indeterminate');
  el.jobPct.textContent = pct + '%';
  if (stageText) el.jobStage.textContent = stageText;
  if (message !== undefined) el.jobMessage.textContent = message || '';
  el.jobStatus.textContent = (stageText || '') + ' ' + pct + '%' + (message ? '，' + message : '');
}

function finishRenderButton() {
  const current = state.prepared?.key === currentPreviewKey();
  setBtnBusy(el.btnRender, state.jobActive && state.exportRequested);
  el.renderLabel.textContent = state.jobActive ? (state.exportRequested ? '生成并导出中…' : '完成后导出') : (current ? '导出当前结果' : '生成并导出');
  el.btnRender.disabled = !(state.sourceId && state.analyzed) || (state.jobActive && (state.jobKey !== currentPreviewKey() || state.exportRequested));
  el.btnPreview.textContent = state.jobActive ? '生成准确预览中…' : '生成准确预览';
  el.btnCancel.hidden = !state.jobActive;
  updatePreviewControls();
}

/**
 * Watch a job to completion.
 *
 * Primary transport is SSE (GET /api/jobs/:id/events); a slow poll runs as a
 * safety net and takes over at 4 Hz the moment SSE drops, so a dead stream can
 * never freeze the progress bar.
 *
 * @param {string} jobId
 * @returns {Promise<object>} the terminal Job snapshot
 */
function watchJob(jobId) {
  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = 0;
    let pollMs = 1000;

    const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; } };

    const cleanup = () => {
      stopPolling();
      if (state.jobSSE) { try { state.jobSSE.close(); } catch (_) { /* already closed */ } state.jobSSE = null; }
    };

    const finish = (job) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(job);
    };

    const onSnapshot = (job) => {
      if (!job || settled) return;
      applyJobSnapshot(job);
      if (TERMINAL.has(job.status)) finish(job);
    };

    const pollOnce = async () => {
      if (settled) return;
      try {
        onSnapshot(await fetchJson(API.job(jobId), {}, 15000));
      } catch (_) {
        // Transient failures must not kill the watch; the next tick retries.
      }
    };

    const startPolling = (ms) => {
      if (settled) return;
      pollMs = ms;
      stopPolling();
      pollTimer = setInterval(pollOnce, pollMs);
      pollOnce();
    };

    if (typeof EventSource === 'function') {
      try {
        const es = new EventSource(API.jobEvents(jobId));
        state.jobSSE = es;
        es.onopen = () => { startPolling(1000); };
        es.onmessage = (ev) => {
          try { onSnapshot(JSON.parse(ev.data)); } catch (_) { /* ignore malformed frame */ }
        };
        es.onerror = () => {
          if (settled) return;
          try { es.close(); } catch (_) { /* ignore */ }
          state.jobSSE = null;
          startPolling(250);   // SSE died: fall back to the documented 4/s poll
        };
      } catch (_) {
        startPolling(250);
      }
    } else {
      startPolling(250);
    }
  });
}

function applyJobSnapshot(job) {
  const p = Number.isFinite(job.progress) ? job.progress : 0;
  const label = stageLabel(job);
  setProgress(p, label, job.status === 'error' ? (job.error || job.message || '未知错误') : (job.message || ''));
  const extra = job.status === 'error' ? (job.error || job.message || '') : (job.message || '');
  setStatus(label + ' · ' + Math.round(p * 100) + '%' + (extra ? ' · ' + extra : ''));
}

async function onJobDone(job, context) {
  const isCurrent = () => !state.cancelRequested && context.key === currentPreviewKey() && context.sourceVersion === state.sourceVersion;
  if (job.status === 'done' && job.preview && isCurrent()) {
    const previous = state.prepared;
    try {
      state.loadingPreview = true;
      await preview.setPreview(job.preview);
      state.loadingPreview = false;
      if (!isCurrent()) {
        preview.setScene(state.scene);
        if (state.prepared) state.prepared.key = null;
        fetchJson(API.clearPreview(job.id), { method: 'POST' }).catch(() => {});
        invalidatePreview();
        return;
      }
      state.prepared = { key: context.key, job };
      state.artifacts = job.artifacts;
      relayout();
      preview.setPlaying(!state.reducedMotion && !document.hidden);
      syncScrub(preview.progress);
      syncPlayButton();
      el.sceneHint.textContent = '准确预览与当前导出一致 · ' + job.preview.width + '×' + job.preview.height;
      if (state.exportRequested) renderArtifacts(job.artifacts);
      if (previous && previous.job.id !== job.id) fetchJson(API.clearPreview(previous.job.id), { method: 'POST' }).catch(() => {});
      setProgress(1, '完成', '准确预览已就绪');
      setStatus('准确预览已就绪 · 导出将复用同一份文件');
      toast('ok', '准确预览已就绪', '播放的是最终文件，可暂停或拖动查看。');
      if (job.warnings?.length) toast('warn', '产物提示', job.warnings.join('；'), 9000);
    } catch (err) {
      state.loadingPreview = false;
      fetchJson(API.clearPreview(job.id), { method: 'POST' }).catch(() => {});
      if (state.prepared) state.prepared.key = null;
      if (err.name === 'AbortError' || !isCurrent()) return;
      preview.setScene(state.scene);
      renderArtifacts(job.artifacts);
      throw err;
    }
  } else {
    if (job.artifacts?.length && isCurrent()) renderArtifacts(job.artifacts);
    fetchJson(API.clearPreview(job.id), { method: 'POST' }).catch(() => {});
    if (job.status === 'canceled' || state.cancelRequested) {
      el.sceneHint.textContent = '生成已取消，请重新生成准确预览';
      setStatus('准确预览生成已取消');
    } else if (!isCurrent()) {
      invalidatePreview('设置已更改，请重新生成准确预览');
      setStatus('旧任务已结束，当前预览未更新');
    } else {
      el.sceneHint.textContent = '准确预览生成失败，请重试';
      toast('error', '准确预览生成失败', job.error || '缺少可播放的产物', 9000);
      setStatus('生成失败：' + (job.error || '缺少可播放的产物'));
    }
  }
}

async function cancelRender() {
  // Only meaningful while the job is still running: the server answers 409 for
  // an already-finished job, which is not worth surfacing as an error.
  if (!state.jobActive) return;
  state.cancelRequested = true;
  if (state.loadingPreview) preview.setScene(state.scene);
  if (!state.jobId) return;
  try {
    await fetchJson(API.cancel(state.jobId), { method: 'POST' }, 10000);
    toast('info', '已请求取消', '正在停止任务 …');
  } catch (e) {
    if (e && e.status === 409) return;
    toast('error', '取消失败', e.message);
  }
}

const KIND_LABELS = {
  video: '视频', livephoto: '实况照片', motionphoto: '动态照片',
  webp: '动态 WebP', apng: '动态 PNG', gif: 'GIF',
};

function renderArtifacts(artifacts) {
  el.artifacts.hidden = false;
  el.artifactList.replaceChildren();
  el.artifactPreview.replaceChildren();
  el.artifactPreview.hidden = true;

  if (!artifacts.length) {
    const li = document.createElement('li');
    li.textContent = '任务完成但没有返回产出文件。';
    el.artifactList.appendChild(li);
    return;
  }

  // inline preview of the first playable/image artifact
  const first = artifacts[0];
  const mime = first.mime || '';
  if (mime.startsWith('video/')) {
    const v = document.createElement('video');
    v.src = first.url;
    v.controls = true;
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.autoplay = !state.reducedMotion;
    el.artifactPreview.appendChild(v);
    el.artifactPreview.hidden = false;
  } else if (mime.startsWith('image/')) {
    const i = document.createElement('img');
    i.src = first.url;
    i.alt = '产出预览';
    el.artifactPreview.appendChild(i);
    el.artifactPreview.hidden = false;
  }

  for (const a of artifacts) {
    const li = document.createElement('li');

    const info = document.createElement('div');
    info.className = 'artifact-info';
    const name = document.createElement('div');
    name.className = 'artifact-name';
    name.textContent = basename(a.path || a.url || 'artifact');
    const sub = document.createElement('div');
    sub.className = 'artifact-sub';
    sub.textContent = [fmtBytes(a.bytes), detailSummary(a.detail)].filter(Boolean).join(' · ');
    info.append(name, sub);

    const kind = document.createElement('span');
    kind.className = 'artifact-kind';
    kind.textContent = KIND_LABELS[a.kind] || a.kind || '文件';

    const dl = document.createElement('a');
    dl.className = 'artifact-dl';
    dl.href = a.url;
    dl.setAttribute('download', basename(a.path || a.url || 'artifact'));
    dl.textContent = '下载';

    li.append(info, kind, dl);
    el.artifactList.appendChild(li);
  }
}

/**
 * One-line, defensive summary of an Artifact `detail` object.
 * The contract calls `detail` free-form and its shape differs per kind
 * (video: fps/resolution; gif: frames/fps/width/height; livephoto: durationSec;
 * webp/apng: quality/frames). Never assume a key exists.
 */
function detailSummary(detail) {
  if (!detail || typeof detail !== 'object') return '';
  const bits = [];
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const frames = n(detail.frames);
  const fps = n(detail.fps);
  const w = n(detail.width);
  const h = n(detail.height);
  const dur = n(detail.durationSec);
  const res = n(detail.resolution);
  if (frames) bits.push(frames + ' 帧');
  if (fps) bits.push(fps + 'fps');
  if (w && h) bits.push(w + '×' + h);
  else if (res) bits.push(res + 'px');
  if (dur && !frames) bits.push(fmtNum(dur, 1) + 's');
  const q = n(detail.quality);
  if (q) bits.push('q' + Math.round(q));
  if (Array.isArray(detail.platforms) && detail.platforms.length) bits.push(detail.platforms.join('/'));
  if (!bits.length) {
    // unknown shape: show a couple of scalar fields rather than nothing
    for (const [k, v] of Object.entries(detail)) {
      if (typeof v === 'number' || typeof v === 'string') bits.push(k + '=' + v);
      if (bits.length >= 3) break;
    }
  }
  return bits.join(' · ');
}

function basename(p) {
  const s = String(p || '');
  const parts = s.split(/[\\/]/);
  return parts[parts.length - 1] || s;
}

/* ------------------------------------------------------------ health/init -- */

async function checkHealth() {
  try {
    const h = await fetchJson(API.health, {}, 6000);
    // The server publishes the authoritative RenderParams defaults; adopt them
    // so the preview starts from exactly what the export will use.
    if (h && h.defaults && typeof h.defaults === 'object') {
      const merged = withDefaults({ ...h.defaults, ...state.userTouched });
      state.serverDefaults = h.defaults;
      state.params = merged;
      if (preview) preview.setParams(state.params);
      syncParamPanel();
    }
    el.healthDot.className = 'dot ' + (h && h.ok ? 'is-ok' : 'is-warn');
    el.healthLabel.textContent = h && h.ok ? '服务正常' : '服务异常';
    if (h && h.version) el.statusVersion.textContent = h.version;
    if (h && h.ffmpeg === false) {
      toast('warn', '未检测到 ffmpeg', '视频与动态图导出将不可用，请安装 ffmpeg 后重启服务。', 9000);
    }
    if (h && h.sharp === false) {
      toast('warn', '未检测到 sharp', '部分图片格式可能无法解码。', 9000);
    }
    return h;
  } catch (e) {
    el.healthDot.className = 'dot is-bad';
    el.healthLabel.textContent = '服务离线';
    setStatus('无法连接本地服务 · 请确认已运行 pnpm start');
    toast('error', '无法连接本地服务', '请在仓库根目录运行 pnpm start 后刷新页面。', 0);
    return null;
  }
}

/* -------------------------------------------------------------- keyboard -- */

function onKeyDown(e) {
  const tag = (e.target && e.target.tagName) || '';
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
  if (typing) return;

  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (!preview) return;
    preview.setPlaying(!preview.playing);
    syncPlayButton();
    if (preview.playing) preview.start();
  } else if (e.key === 'r' || e.key === 'R') {
    if (!preview) return;
    preview.setProgress(0);
    preview.render();
    syncScrub(0);
  } else if (e.key === 'g' || e.key === 'G') {
    toggleThirds();
  } else if (e.key === 'ArrowLeft' && preview) {
    preview.setPlaying(false);
    syncPlayButton();
    preview.setProgress(Math.max(0, preview.progress - (e.shiftKey ? 0.1 : 0.02)));
    preview.render();
  } else if (e.key === 'ArrowRight' && preview) {
    preview.setPlaying(false);
    syncPlayButton();
    preview.setProgress(Math.min(1, preview.progress + (e.shiftKey ? 0.1 : 0.02)));
    preview.render();
  }
}

function toggleThirds() {
  const on = !el.thirds.classList.contains('is-on');
  el.thirds.classList.toggle('is-on', on);
  el.btnThirds.setAttribute('aria-pressed', on ? 'true' : 'false');
}

/* ------------------------------------------------------------------ wire -- */

function wireEvents() {
  // --- file pickers ---
  const pick = () => el.fileInput.click();
  el.dropzone.addEventListener('click', pick);
  el.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
  });
  el.btnEmptyPick.addEventListener('click', pick);
  el.fileInput.addEventListener('change', () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    el.fileInput.value = '';
    if (f) uploadFile(f);
  });

  // --- drag & drop (window-wide, so the whole app accepts a drop) ---
  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    el.dropzone.classList.add('is-drop');
    el.canvasWrap.classList.add('is-drop');
  });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      el.dropzone.classList.remove('is-drop');
      el.canvasWrap.classList.remove('is-drop');
    }
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropzone.classList.remove('is-drop');
    el.canvasWrap.classList.remove('is-drop');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) uploadFile(f);
  });

  // --- source actions ---
  el.btnSample.addEventListener('click', loadSample);
  el.btnEmptySample.addEventListener('click', loadSample);
  el.btnClear.addEventListener('click', () => {
    if (state.jobId) cancelRender();
    clearSource();
    toast('info', '已清空', '可以载入新的照片了。');
  });
  el.btnAnalyze.addEventListener('click', analyze);

  // --- preview controls ---
  el.btnPlay.addEventListener('click', () => {
    if (!preview) return;
    preview.setPlaying(!preview.playing);
    if (preview.playing) preview.start();
    syncPlayButton();
    el.stageViewport.focus({ preventScroll: true });
  });
  el.btnReplay.addEventListener('click', () => {
    if (!preview) return;
    preview.setProgress(0);
    preview.render();
    syncScrub(0);
  });
  el.btnThirds.addEventListener('click', toggleThirds);

  el.scrub.addEventListener('pointerdown', () => { scrubbing = true; });
  el.scrub.addEventListener('input', () => {
    scrubbing = true;
    const t = Number(el.scrub.value) / Math.max(1, Number(el.scrub.max));
    el.scrub.style.setProperty('--pct', (t * 100).toFixed(2) + '%');
    el.scrubOut.textContent = (t * 100).toFixed(1) + '%';
    const stats = preview?.getStats();
    el.timeOut.textContent = (stats?.timeSec || 0).toFixed(3) + ' / ' + (stats?.durationSec || 0).toFixed(3) + 's';
    if (preview) {
      preview.setPlaying(false);
      syncPlayButton();
      preview.setProgress(t);
      preview.render();
    }
  });
  const endScrub = () => { scrubbing = false; };
  el.scrub.addEventListener('pointerup', endScrub);
  el.scrub.addEventListener('pointercancel', endScrub);
  el.scrub.addEventListener('change', endScrub);
  el.scrub.addEventListener('blur', endScrub);

  // --- params ---
  el.btnReset.addEventListener('click', resetParams);
  el.presets.addEventListener('click', (e) => {
    const b = e.target.closest('.chip-btn');
    if (!b) return;
    const name = b.dataset.preset;
    if (PRESETS[name]) applyParams({ ...PRESETS[name] }, name);
  });

  // --- export ---
  el.format.addEventListener('change', () => {
    el.formatNote.textContent = FORMAT_NOTES[el.format.value] || '';
    invalidatePreview('格式已更改，请重新生成准确预览');
  });
  el.btnRender.addEventListener('click', () => startRender(true));
  el.btnPreview.addEventListener('click', () => startRender(false));
  el.btnCancel.addEventListener('click', cancelRender);

  // --- keyboard ---
  window.addEventListener('keydown', onKeyDown);

  // --- resize ---
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(relayout, 120);
  });
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => {
      clearTimeout(rt);
      rt = setTimeout(relayout, 120);
    });
    ro.observe(el.stageViewport);
  }

  // pause the loop when the tab is hidden (saves battery, avoids dt spikes)
  document.addEventListener('visibilitychange', () => {
    if (!preview) return;
    if (document.hidden) preview.stop();
    else { preview.start(); }
  });

  window.addEventListener('beforeunload', () => {
    if (state.jobSSE) { try { state.jobSSE.close(); } catch (_) {} }
    if (state.jobActive && state.jobId) {
      navigator.sendBeacon(API.cancel(state.jobId));
      navigator.sendBeacon(API.clearPreview(state.jobId));
    }
    if (state.prepared) navigator.sendBeacon(API.clearPreview(state.prepared.job.id));
    preview?.dispose();
  });
}

/* ------------------------------------------------------------------ boot -- */

function boot() {
  initRenderer();
  paramControls = buildParamPanel();
  syncParamPanel();
  applyParams({}, 'natural');
  wireEvents();
  el.formatNote.textContent = FORMAT_NOTES[el.format.value] || '';
  resetAnalysisPanel();
  el.canvasWrap.classList.add('is-empty');
  el.thirds.classList.add('is-on');
  syncPlayButton();
  syncScrub(0);
  relayout();
  checkHealth();
  // Keep the loop ticking before a scene exists: it is nearly free (an empty
  // draw) and it keeps the backdrop alive while the user picks a file.
  if (preview) {
    preview.setPlaying(false);
    syncPlayButton();
  }
  window.__deepskyMotion = { state, get preview() { return preview; }, API };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
