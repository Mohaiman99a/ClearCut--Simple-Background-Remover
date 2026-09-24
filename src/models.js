import { RawImage } from '@huggingface/transformers';
import * as ort from 'onnxruntime-web/webgpu';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = 1;

const MODEL_CACHE = 'clearcut-model-weights-v1';
const RMBG_MODEL_URL = 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx';
const RMBG_EDGE = 1024;
const weightPromises = new Map();
let rmbgSessionPromise;
let rmbgBackend = null;
let samWorker;
let samRequestId = 0;
let samQueue = Promise.resolve();
let encodedImage;
const encodingPromises = new WeakMap();

function report(onProgress, message) { onProgress?.(message); }

async function getModelWeights(url, label, onProgress) {
  if (!weightPromises.has(url)) {
    weightPromises.set(url, (async () => {
      let response;
      let cache;
      try {
        cache = await caches.open(MODEL_CACHE);
        response = await cache.match(url);
      } catch (error) {
        console.warn('Persistent model cache is unavailable; fetching weights normally.', error);
      }
      if (response) {
        report(onProgress, `${label} loaded from this browser's model cache…`);
      } else {
        report(onProgress, `Downloading ${label}…`);
        response = await fetch(url);
        if (!response.ok) throw new Error(`Model download failed (${response.status})`);
        if (cache) {
          try { await cache.put(url, response.clone()); }
          catch (error) { console.warn('Could not persist the model weights in Cache Storage.', error); }
        }
      }
      return new Uint8Array(await response.arrayBuffer());
    })().catch((error) => {
      weightPromises.delete(url);
      throw error;
    }));
  }
  return weightPromises.get(url);
}

async function preferredBackend() {
  if (!navigator.gpu) return 'wasm';
  try { return await navigator.gpu.requestAdapter() ? 'webgpu' : 'wasm'; }
  catch { return 'wasm'; }
}

async function createRmbgSession(onProgress, forcedBackend) {
  const model = await getModelWeights(RMBG_MODEL_URL, 'RMBG-1.4 (~44 MB)', onProgress);
  const backend = forcedBackend || await preferredBackend();
  try {
    const session = await ort.InferenceSession.create(model, {
      executionProviders: [backend], graphOptimizationLevel: 'all',
    });
    rmbgBackend = backend;
    console.info(`ClearCut AI RMBG-1.4 backend: ${backend === 'webgpu' ? 'WebGPU' : 'WASM'}`);
    if (backend === 'wasm' && navigator.gpu) report(onProgress, 'WebGPU could not initialize · using WASM fallback…');
    return session;
  } catch (error) {
    if (backend !== 'webgpu') throw error;
    console.warn('RMBG-1.4 WebGPU session failed; retrying on WASM.', error);
    report(onProgress, 'WebGPU initialization failed · switching to WASM…');
    return createRmbgSession(onProgress, 'wasm');
  }
}

function getRmbgSession(onProgress) {
  if (!rmbgSessionPromise) {
    rmbgSessionPromise = createRmbgSession(onProgress).catch((error) => {
      rmbgSessionPromise = null;
      throw error;
    });
  }
  return rmbgSessionPromise;
}

function prepareRmbgInput(image) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = RMBG_EDGE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, RMBG_EDGE, RMBG_EDGE);
  const raw = RawImage.fromCanvas(canvas);
  const plane = RMBG_EDGE * RMBG_EDGE;
  const tensorData = new Float32Array(plane * 3);
  for (let i = 0; i < plane; i++) {
    const offset = i * raw.channels;
    tensorData[i] = raw.data[offset] / 255 - 0.5;
    tensorData[plane + i] = raw.data[offset + 1] / 255 - 0.5;
    tensorData[plane * 2 + i] = raw.data[offset + 2] / 255 - 0.5;
  }
  return new ort.Tensor('float32', tensorData, [1, 3, RMBG_EDGE, RMBG_EDGE]);
}

function outputToNativeMask(output, nativeWidth, nativeHeight) {
  const width = output.dims.at(-1);
  const height = output.dims.at(-2);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < width * height; i++) {
    min = Math.min(min, output.data[i]);
    max = Math.max(max, output.data[i]);
  }
  const span = max - min || 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const value = Math.round((output.data[i] - min) * 255 / span);
    const offset = i * 4;
    rgba[offset] = rgba[offset + 1] = rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  source.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const result = document.createElement('canvas');
  result.width = nativeWidth;
  result.height = nativeHeight;
  const context = result.getContext('2d', { willReadFrequently: true });
  context.drawImage(source, 0, 0, nativeWidth, nativeHeight);
  const pixels = context.getImageData(0, 0, nativeWidth, nativeHeight).data;
  const mask = new Uint8ClampedArray(nativeWidth * nativeHeight);
  for (let i = 0, offset = 0; i < mask.length; i++, offset += 4) mask[i] = pixels[offset];
  return mask;
}

async function runRmbg(session, image) {
  const outputs = await session.run({ [session.inputNames[0]]: prepareRmbgInput(image) });
  const output = outputs[session.outputNames[0]];
  if (!output?.data || !output?.dims) throw new Error('RMBG-1.4 returned an unsupported mask format.');
  return outputToNativeMask(output, image.width, image.height);
}

export async function removeBackground(image, onProgress) {
  let session = await getRmbgSession(onProgress);
  report(onProgress, `RMBG-1.4 ready · running on ${rmbgBackend === 'webgpu' ? 'WebGPU' : 'WASM'}…`);
  try { return await runRmbg(session, image); }
  catch (error) {
    if (rmbgBackend !== 'webgpu') throw error;
    console.warn('RMBG-1.4 WebGPU inference failed; retrying on WASM.', error);
    report(onProgress, 'WebGPU inference failed · retrying on WASM…');
    session = await createRmbgSession(onProgress, 'wasm');
    rmbgSessionPromise = Promise.resolve(session);
    return runRmbg(session, image);
  }
}

function getSamWorker() {
  if (!samWorker) {
    samWorker = new Worker(new URL('./sam.worker.js', import.meta.url), { type: 'module' });
    samWorker.addEventListener('error', (event) => console.error('MobileSAM worker error', event.message));
  }
  return samWorker;
}

function workerRequest(type, payload, transfer = [], onProgress) {
  const run = () => new Promise((resolve, reject) => {
    const worker = getSamWorker();
    const id = ++samRequestId;
    const onMessage = (event) => {
      const message = event.data;
      if (message.id !== id) return;
      if (message.progress) { report(onProgress, message.progress); return; }
      worker.removeEventListener('message', onMessage);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ id, type, ...payload }, transfer);
  });
  const result = samQueue.then(run, run);
  samQueue = result.catch(() => {});
  return result;
}

async function ensureSamImage(image, onProgress) {
  if (encodedImage === image) return;
  if (encodingPromises.has(image)) return encodingPromises.get(image);
  const encoding = (async () => {
    const bitmap = await createImageBitmap(image);
    await workerRequest('encode', { bitmap }, [bitmap], onProgress);
    encodedImage = image;
  })();
  encodingPromises.set(image, encoding);
  try { await encoding; }
  catch (error) { encodingPromises.delete(image); throw error; }
}

export async function encodeForSmartSelect(image, onProgress) {
  await ensureSamImage(image, onProgress);
}

export async function predictSmartSelection(image, x, y, onProgress) {
  await ensureSamImage(image, onProgress);
  const result = await workerRequest('select', { x, y }, [], onProgress);
  return new Uint8ClampedArray(result.mask);
}
