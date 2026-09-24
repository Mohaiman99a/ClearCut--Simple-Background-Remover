const COLORS = {
  smart: [124, 92, 252],
  color: [255, 107, 74],
  keep: [76, 154, 106],
  remove: [217, 83, 79],
};

export class SelectionModel {
  constructor(resultCanvas, overlayCanvas) {
    this.resultCanvas = resultCanvas;
    this.overlayCanvas = overlayCanvas;
    this.imageData = null;
    this.mask = null;
    this.maskReady = false;
    this.candidate = null;
    this.candidateKind = 'smart';
    this.mode = 'add';
  }

  setImage(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const source = document.createElement('canvas');
    source.width = width;
    source.height = height;
    const context = source.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    this.imageData = context.getImageData(0, 0, width, height);
    this.resultCanvas.width = this.overlayCanvas.width = width;
    this.resultCanvas.height = this.overlayCanvas.height = height;
    this.mask = new Uint8ClampedArray(width * height).fill(255);
    this.maskReady = false;
    this.clearCandidate();
    this.render();
  }

  get width() { return this.resultCanvas.width; }
  get height() { return this.resultCanvas.height; }
  get hasImage() { return Boolean(this.imageData); }
  get hasMask() { return this.maskReady; }

  setMask(mask) {
    if (!this.imageData || mask.length !== this.width * this.height) throw new Error('Mask dimensions do not match the current image.');
    this.mask = new Uint8ClampedArray(mask);
    this.maskReady = true;
    this.render();
  }

  render() {
    if (!this.imageData || !this.mask) return;
    const context = this.resultCanvas.getContext('2d');
    const output = context.createImageData(this.width, this.height);
    const src = this.imageData.data;
    const dst = output.data;
    for (let pixel = 0, offset = 0; pixel < this.mask.length; pixel++, offset += 4) {
      dst[offset] = src[offset];
      dst[offset + 1] = src[offset + 1];
      dst[offset + 2] = src[offset + 2];
      dst[offset + 3] = Math.round(src[offset + 3] * this.mask[pixel] / 255);
    }
    context.putImageData(output, 0, 0);
    this.drawCandidate();
  }

  getMask() { return this.mask ? new Uint8ClampedArray(this.mask) : null; }
  getImageData() { return this.imageData; }

  snapshot() {
    return this.imageData && this.mask ? { imageData: this.imageData, mask: this.getMask(), maskReady: this.maskReady } : null;
  }

  clear() {
    this.imageData = null;
    this.mask = null;
    this.maskReady = false;
    this.resultCanvas.width = this.overlayCanvas.width = 0;
    this.resultCanvas.height = this.overlayCanvas.height = 0;
    this.clearCandidate();
  }

  restore(snapshot) {
    this.imageData = snapshot.imageData;
    this.mask = new Uint8ClampedArray(snapshot.mask);
    this.maskReady = snapshot.maskReady ?? true;
    this.resultCanvas.width = this.overlayCanvas.width = this.imageData.width;
    this.resultCanvas.height = this.overlayCanvas.height = this.imageData.height;
    this.clearCandidate();
    this.render();
  }

  setCandidate(candidate, kind, mode = this.mode, accumulate = false) {
    if (!this.imageData || candidate.length !== this.width * this.height) return;
    if (accumulate && this.candidate?.length === candidate.length) {
      for (let i = 0; i < candidate.length; i++) this.candidate[i] = Math.max(this.candidate[i], candidate[i]);
    } else {
      this.candidate = new Uint8ClampedArray(candidate);
    }
    this.candidateKind = kind;
    this.mode = mode;
    this.drawCandidate();
  }

  clearCandidate() {
    this.candidate = null;
    const context = this.overlayCanvas.getContext('2d');
    context.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  drawCandidate() {
    const context = this.overlayCanvas.getContext('2d');
    if (!this.candidate) {
      context.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      return;
    }
    const overlay = context.createImageData(this.width, this.height);
    const tint = COLORS[this.candidateKind] || COLORS.smart;
    const outline = COLORS[this.mode === 'add' ? 'keep' : 'remove'];
    for (let i = 0, offset = 0; i < this.candidate.length; i++, offset += 4) {
      if (!this.candidate[i]) continue;
      const x = i % this.width;
      const y = (i / this.width) | 0;
      const edge = x === 0 || y === 0 || x === this.width - 1 || y === this.height - 1 ||
        !this.candidate[i - 1] || !this.candidate[i + 1] || !this.candidate[i - this.width] || !this.candidate[i + this.width];
      const color = edge ? outline : tint;
      overlay.data[offset] = color[0];
      overlay.data[offset + 1] = color[1];
      overlay.data[offset + 2] = color[2];
      overlay.data[offset + 3] = edge ? 235 : 82;
    }
    context.putImageData(overlay, 0, 0);
  }

  mergeCandidate(mode = this.mode) {
    if (!this.candidate || !this.mask) return false;
    if (mode === 'add') {
      for (let i = 0; i < this.mask.length; i++) this.mask[i] = Math.max(this.mask[i], this.candidate[i]);
    } else {
      for (let i = 0; i < this.mask.length; i++) this.mask[i] = Math.round(this.mask[i] * (255 - this.candidate[i]) / 255);
    }
    this.maskReady = true;
    this.clearCandidate();
    this.render();
    return true;
  }

  floodFill(x, y, tolerance) {
    if (!this.imageData) return null;
    const width = this.width;
    const height = this.height;
    const startX = Math.min(width - 1, Math.max(0, Math.floor(x)));
    const startY = Math.min(height - 1, Math.max(0, Math.floor(y)));
    const start = startY * width + startX;
    const pixels = this.imageData.data;
    const seedOffset = start * 4;
    const seed = [pixels[seedOffset], pixels[seedOffset + 1], pixels[seedOffset + 2]];
    const threshold = Number(tolerance);
    const candidate = new Uint8ClampedArray(width * height);
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head++];
      const offset = index * 4;
      if (Math.max(Math.abs(pixels[offset] - seed[0]), Math.abs(pixels[offset + 1] - seed[1]), Math.abs(pixels[offset + 2] - seed[2])) > threshold) continue;
      candidate[index] = 255;
      const col = index % width;
      if (col > 0 && !visited[index - 1]) { visited[index - 1] = 1; queue[tail++] = index - 1; }
      if (col + 1 < width && !visited[index + 1]) { visited[index + 1] = 1; queue[tail++] = index + 1; }
      if (index >= width && !visited[index - width]) { visited[index - width] = 1; queue[tail++] = index - width; }
      const below = index + width;
      if (below < width * height && !visited[below]) { visited[below] = 1; queue[tail++] = below; }
    }
    return candidate;
  }
}




