// Playback of final export media. No scene rendering or visual approximation.
export const DEFAULT_PARAMS = Object.freeze({
  durationSec: 6, fps: 30, resolution: 1280, dolly: 0.45, dollyEase: 'inOut',
  parallax: 1, depthSpread: 0.6, depthPower: 1.35, twinkle: 0.25,
  starScale: 1, bloom: 0.16, starGain: 1, nebulaGain: 1.05, background: 0,
  vignette: 0.15, occlusion: 0.55, focus: 0.5, coc: 0.06, seed: 1337,
  drift: 0.012, roll: 0, starColor: 0.85, loopMode: 'forward',
});

export function withDefaults(params = {}) {
  const out = { ...DEFAULT_PARAMS };
  for (const [key, value] of Object.entries(params)) if (value != null) out[key] = value;
  return out;
}

export function previewKey(sourceId, params, format) {
  return JSON.stringify([sourceId, Object.entries(params).sort(([a], [b]) => a.localeCompare(b)), format]);
}

/** Find the actual encoded frame at a playback timestamp. */
export function frameAtTime(starts, timeMs) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= timeMs) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class PreviewRenderer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ctx = canvas.getContext('2d');
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
    }
    this.params = withDefaults();
    this.scene = null;
    this.manifest = null;
    this.playing = false;
    this.disposed = false;
    this._plate = null;
    this._frameIndex = 0;
    this._draftProgress = 0;
    this._requestedIndex = -1;
    this._cache = new Map();
    this._generation = 0;
    this._request = 0;
    this._raf = 0;
    this._anchor = 0;
    this._ready = false;
    this.video = document.createElement('video');
    this.video.className = 'stage-video';
    this.video.hidden = true;
    this.video.muted = true;
    this.video.loop = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.video.setAttribute('aria-label', '最终导出视频预览');
    canvas.after(this.video);
    this.video.addEventListener('seeked', () => this._videoStats());
    this.video.addEventListener('timeupdate', () => this._videoStats());
    this.video.addEventListener('error', () => {
      if (this.manifest?.type === 'video' && this._ready) {
        this.setPlaying(false);
        this.opts.onError?.(new Error('视频无法播放，请重新生成准确预览'));
      }
    });
  }

  get backend() {
    if (!this.ctx) return 'none';
    return this.manifest ? 'media' : 'draft';
  }

  get progress() {
    if (this.manifest?.frameCount > 1) {
      return this._frameIndex / (this.manifest.frameCount - 1);
    }
    return this._draftProgress || 0;
  }
  get frameCount() { return this.manifest?.frameCount || 1; }

  _clearMedia() {
    this.setPlaying(false);
    this._loadController?.abort();
    this._generation++;
    this._request++;
    this._ready = false;
    this.manifest = null;
    this._frameIndex = 0;
    this._draftProgress = 0;
    this._requestedIndex = -1;
    this.video.removeAttribute('src');
    this.video.load();
    this.video.hidden = true;
    this.canvas.hidden = false;
    for (const { image } of this._cache.values()) image.src = '';
    this._cache.clear();
  }

  returnToDraft(keepProgress = true) {
    if (this.manifest) {
      const curProg = keepProgress ? this.progress : 0;
      this._clearMedia();
      this._draftProgress = curProg;
      this.render();
      this._emit();
    }
    return this;
  }

  setScene(scene, extra = {}) {
    this._clearMedia();
    this.scene = scene;
    if (extra.plate !== undefined) this._plate = extra.plate;
    this.render();
    this._emit();
    return this;
  }

  setPlate(image) { this._plate = image; this.render(); this._emit(); return this; }
  setParams(params) { this.params = withDefaults(params); return this; }

  async setPreview(manifest) {
    if (!manifest?.frames?.length || manifest.frames.length !== manifest.frameCount ||
        !['video', 'frames'].includes(manifest.type) || !(manifest.width > 0) || !(manifest.height > 0) ||
        manifest.frames.some((f) => !(f.durationMs > 0) || (manifest.type === 'frames' && !f.url))) {
      throw new Error('准确预览缺少有效的帧数据');
    }
    this._clearMedia();
    const generation = this._generation;
    this.manifest = manifest;
    let elapsed = 0;
    this._starts = manifest.frames.map((frame) => {
      const start = elapsed;
      elapsed += frame.durationMs;
      return start;
    });
    if (manifest.type === 'video') {
      this._loadController = new AbortController();
      const signal = this._loadController.signal;
      const ready = new Promise((resolve, reject) => {
        const cleanup = () => {
          this.video.removeEventListener('loadeddata', done);
          this.video.removeEventListener('error', fail);
          signal.removeEventListener('abort', abort);
        };
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error('浏览器无法解码该导出视频')); };
        const abort = () => { cleanup(); reject(new DOMException('Preview replaced', 'AbortError')); };
        this.video.addEventListener('loadeddata', done, { once: true });
        this.video.addEventListener('error', fail, { once: true });
        signal.addEventListener('abort', abort, { once: true });
      });
      this.video.src = manifest.videoUrl;
      this.video.load();
      await ready;
      if (generation !== this._generation) return;
      this.canvas.hidden = true;
      this.video.hidden = false;
    } else {
      this.canvas.width = manifest.width;
      this.canvas.height = manifest.height;
      await this._seekFrame(0);
      if (generation !== this._generation) return;
    }
    this._ready = true;
    this._emit();
  }

  _image(index) {
    if (this._cache.has(index)) return this._cache.get(index).promise;
    const image = new Image();
    const promise = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('预览帧加载失败，请重新生成准确预览'));
    });
    this._cache.set(index, { image, promise });
    image.src = this.manifest.frames[index].url;
    return promise;
  }

  async _seekFrame(index) {
    if (!this.manifest || this._requestedIndex === index) return;
    this._requestedIndex = index;
    const generation = this._generation;
    const request = ++this._request;
    for (const [i, entry] of this._cache) {
      if (Math.abs(i - index) > 1) { this._cache.delete(i); entry.image.src = ''; }
    }
    try {
      const image = await this._image(index);
      if (generation !== this._generation || request !== this._request) return;
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.ctx.drawImage(image, 0, 0);
      this._frameIndex = index;
      this._emit();
      for (const i of [index - 1, index + 1]) {
        if (i >= 0 && i < this.frameCount) this._image(i).catch(() => {});
      }
    } catch (err) {
      if (generation !== this._generation || request !== this._request) return;
      this._requestedIndex = -1;
      this.setPlaying(false);
      if (!this._ready) throw err;
      this.opts.onError?.(err);
    }
  }

  setProgress(progress) {
    this._draftProgress = Math.max(0, Math.min(1, progress));
    if (!this.manifest) {
      this.render();
      this._emit();
      return this;
    }
    const index = Math.round(this._draftProgress * (this.frameCount - 1));
    if (this.manifest.type === 'video') {
      this.video.currentTime = (this._starts[index] + this.manifest.frames[index].durationMs / 2) / 1000;
    } else {
      this._anchor = performance.now() - this._starts[index];
      this._seekFrame(index).catch((err) => this.opts.onError?.(err));
    }
    return this;
  }

  setPlaying(on) {
    this.playing = !!on && this._ready && !!this.manifest;
    if (this.playing) this.start();
    else this.stop();
    this._emit();
    return this;
  }

  _videoStats() {
    if (this.manifest?.type !== 'video') return;
    this._frameIndex = frameAtTime(this._starts, this.video.currentTime * 1000);
    this._emit();
  }

  _emit() { this.opts.onStats?.(this.getStats(), this.progress); }

  getStats() {
    const isDraft = !this.manifest;
    const fps = this.manifest?.fps || (isDraft ? (this.params?.fps || 30) : 0);
    const durationSec = this.manifest ? (this.manifest.durationMs / 1000) : (isDraft ? (this.params?.durationSec || 6) : 0);
    const timeSec = this.manifest ? ((this._starts?.[this._frameIndex] || 0) / 1000) : (this.progress * durationSec);
    return {
      backend: isDraft ? (this.ctx ? 'draft' : 'none') : this.backend,
      fps,
      stars: this.scene?.stars?.length || 0,
      frameCount: this.frameCount,
      frameIndex: this._frameIndex,
      timeSec,
      durationSec,
    };
  }

  start() {
    if (this.disposed || !this.playing || this._raf) return;
    if (this.manifest.type === 'video') {
      this.video.play().catch(() => { this.playing = false; this.stop(); this._emit(); });
      return;
    }
    this._anchor = performance.now() - this._starts[this._frameIndex];
    const tick = (now) => {
      if (!this.playing || this.disposed || !this.manifest) return;
      const elapsed = Math.max(0, now - this._anchor) % this.manifest.durationMs;
      this._seekFrame(frameAtTime(this._starts, elapsed)).catch((err) => this.opts.onError?.(err));
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.video.pause();
  }

  _renderDraft(width, height, progress) {
    if (!this.ctx) return;
    const params = this.params || DEFAULT_PARAMS;
    let p = Math.max(0, Math.min(1, progress || 0));
    if (params.loopMode === 'pingpong') {
      p = p <= 0.5 ? p * 2 : (1 - p) * 2;
    }
    let eased = p;
    if (params.dollyEase === 'inOut') {
      eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
    } else if (params.dollyEase === 'in') {
      eased = p * p;
    } else if (params.dollyEase === 'out') {
      eased = p * (2 - p);
    }

    const dolly = params.dolly ?? 0.45;
    const drift = params.drift ?? 0.012;
    const rollDeg = params.roll ?? 0;
    const zoom = 1 + dolly * eased;
    const driftX = drift * (p - 0.5);
    const driftY = drift * 0.5 * Math.sin(p * Math.PI);
    const roll = rollDeg * (p - 0.5) * (Math.PI / 180);

    const cx = width / 2;
    const cy = height / 2;

    // 1. 底图绘制 (Plate / Nebula)
    if (this._plate) {
      this.ctx.save();
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      const nebGain = params.nebulaGain ?? 1.05;
      const bgFloor = params.background ?? 0;
      if (nebGain !== 1 || bgFloor > 0) {
        const brightness = Math.max(0, (nebGain + bgFloor * 0.4) * 100).toFixed(1);
        const contrast = Math.max(0, 100 + (nebGain - 1) * 20).toFixed(1);
        try {
          this.ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`;
        } catch (_) {}
      }
      this.ctx.translate(cx, cy);
      if (roll) this.ctx.rotate(roll);
      this.ctx.scale(zoom, zoom);
      this.ctx.translate(-cx + driftX * width, -cy + driftY * height);
      this.ctx.drawImage(this._plate, 0, 0, width, height);
      this.ctx.restore();
      if (this.ctx.filter && this.ctx.filter !== 'none') {
        try { this.ctx.filter = 'none'; } catch (_) {}
      }
    }

    // 2. 恒星绘制 (Stars)
    const stars = this.scene?.stars;
    if (stars && stars.length) {
      const parallax = params.parallax ?? 1;
      const starScale = params.starScale ?? 1;
      const twinkleParam = params.twinkle ?? 0.25;
      const starGain = params.starGain ?? 1;
      const starColorParam = params.starColor ?? 0.85;
      const focus = params.focus ?? 0.5;
      const coc = params.coc ?? 0.06;

      const count = Math.min(stars.length, 1500);
      const bloomParam = params.bloom ?? 0.18;
      for (let i = 0; i < count; i++) {
        const s = stars[i];
        const z = s.z ?? 0.5;
        const starZoom = 1 + dolly * parallax * (1 - z) * eased;
        const sx = cx + (s.x - cx + driftX * width) * starZoom;
        const sy = cy + (s.y - cy + driftY * height) * starZoom;

        if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) continue;

        const defocus = Math.abs(z - focus);
        const defocusMult = 1 + coc * Math.pow(defocus, 1.3) * 3.0;

        const r = Math.max(0.55, (s.r || 1.1) * starScale * 0.75 * Math.pow(Math.max(1, starZoom), 0.3) * defocusMult);
        const twinkle = 1 + twinkleParam * Math.sin((s.phase || 0) + p * 20 * (s.twinkleRate || 1));
        const alpha = Math.min(1, Math.max(0, (s.flux || 0.8) * starGain * twinkle / (defocusMult * 0.7 + 0.3)));

        let cr = 255, cg = 255, cb = 255;
        if (s.cr != null && s.cg != null && s.cb != null && starColorParam > 0) {
          cr = Math.round(255 * (1 - starColorParam) + s.cr * starColorParam);
          cg = Math.round(255 * (1 - starColorParam) + s.cg * starColorParam);
          cb = Math.round(255 * (1 - starColorParam) + s.cb * starColorParam);
        }

        // Subtle soft halo only for top bright stars
        const isBright = (s.fluxNorm ?? s.flux ?? 0) > 0.35;
        if (isBright && bloomParam > 0.01) {
          const haloR = r * (2.2 + bloomParam * 2.8);
          const haloAlpha = alpha * bloomParam * 0.12;
          this.ctx.fillStyle = `rgba(${cr},${cg},${cb},${haloAlpha.toFixed(3)})`;
          this.ctx.beginPath();
          this.ctx.arc(sx, sy, haloR, 0, 2 * Math.PI);
          this.ctx.fill();
        }

        this.ctx.fillStyle = `rgba(${cr},${cg},${cb},${alpha.toFixed(2)})`;
        this.ctx.beginPath();
        this.ctx.arc(sx, sy, r, 0, 2 * Math.PI);
        this.ctx.fill();
      }
    }

    // 3. 边缘暗角遮罩 (Vignette)
    const vignette = params.vignette ?? 0.15;
    if (vignette > 0.005 && typeof this.ctx.createRadialGradient === 'function') {
      this.ctx.save();
      const maxR = Math.hypot(cx, cy);
      const grad = this.ctx.createRadialGradient(cx, cy, Math.min(cx, cy) * 0.45, cx, cy, maxR);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, `rgba(0, 0, 0, ${(Math.min(1, vignette * 0.9)).toFixed(3)})`);
      this.ctx.fillStyle = grad;
      this.ctx.fillRect(0, 0, width, height);
      this.ctx.restore();
    }
  }

  render() {
    if (this.disposed || this.manifest || !this.ctx) return;
    const width = this._plate?.naturalWidth || this.scene?.width || 3;
    const height = this._plate?.naturalHeight || this.scene?.height || 2;
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.clearRect(0, 0, width, height);
    this._renderDraft(width, height, this._draftProgress);
  }

  layout(availW, availH) {
    const aspect = (this.manifest?.width || this.scene?.width || this._plate?.naturalWidth || 3) /
      (this.manifest?.height || this.scene?.height || this._plate?.naturalHeight || 2);
    let width = Math.max(80, availW);
    let height = width / aspect;
    if (height > availH) { height = Math.max(60, availH); width = height * aspect; }
    const wrap = this.canvas.parentElement;
    wrap.style.width = `${Math.round(width)}px`;
    wrap.style.height = `${Math.round(height)}px`;
    this.canvas.style.width = this.video.style.width = '100%';
    this.canvas.style.height = this.video.style.height = '100%';
    return { width, height };
  }

  dispose() {
    this._clearMedia();
    this.disposed = true;
    this.video.remove();
  }
}

export function createPreview(canvas, opts = {}) { return new PreviewRenderer(canvas, opts); }
export function backendLabel(backend) {
  if (backend === 'draft') return '实时草稿';
  return backend === 'media' ? '准确预览' : '不可用';
}
