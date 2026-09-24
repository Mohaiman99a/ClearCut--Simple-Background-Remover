import * as ort from 'onnxruntime-web/webgpu';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
ort.env.wasm.numThreads = 1;
const MODEL_CACHE = 'clearcut-model-weights-v1';
const SAM_ROOT = 'https://huggingface.co/Acly/MobileSAM/resolve/main';
const ENCODER_URL = `${SAM_ROOT}/mobile_sam_image_encoder.onnx`;
const DECODER_URL = `${SAM_ROOT}/sam_mask_decoder_single.onnx`;
const EDGE = 1024;
let encoderSession;
let decoderSession;
let encoderBackend;
let decoderBackend;
let embeddings;
let imageSize;

function progress(id, message) { self.postMessage({ id, progress: message }); }
async function getWeights(url, name, id) {
  let cache;
  let response;
  try {
    cache = await caches.open(MODEL_CACHE);
    response = await cache.match(url);
  } catch (error) { console.warn('MobileSAM persistent cache unavailable.', error); }
  if (response) progress(id, `${name} loaded from this browser's model cache…`);
  else {
    progress(id, `Downloading ${name}…`);
    response = await fetch(url);
    if (!response.ok) throw new Error(`${name} download failed (${response.status})`);
    if (cache) {
      try { await cache.put(url, response.clone()); }
      catch (error) { console.warn(`Could not cache ${name}.`, error); }
    }
  }
  return new Uint8Array(await response.arrayBuffer());
}
async function bestBackend() {
  if (!navigator.gpu) return 'wasm';
  try { return await navigator.gpu.requestAdapter() ? 'webgpu' : 'wasm'; }
  catch { return 'wasm'; }
}
async function createModel(url, name, id, forcedBackend) {
  const bytes = await getWeights(url, name, id);
  const backend = forcedBackend || await bestBackend();
  try {
    const session = await ort.InferenceSession.create(bytes, { executionProviders: [backend], graphOptimizationLevel: 'all' });
    console.info(`ClearCut AI ${name} backend: ${backend === 'webgpu' ? 'WebGPU' : 'WASM'}`);
    if (backend === 'wasm' && navigator.gpu) progress(id, `WebGPU could not initialize · ${name} is using WASM…`);
    return { session, backend };
  } catch (error) {
    if (backend !== 'webgpu') throw error;
    console.warn(`${name} WebGPU session failed; retrying on WASM.`, error);
    progress(id, `WebGPU initialization failed · switching ${name} to WASM…`);
    return createModel(url, name, id, 'wasm');
  }
}
function prepareEncoder(bitmap) {
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  const scale = EDGE / Math.max(sourceWidth, sourceHeight);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const tensorData = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const rgbOffset = i * 3;
    tensorData[rgbOffset] = pixels[offset];
    tensorData[rgbOffset + 1] = pixels[offset + 1];
    tensorData[rgbOffset + 2] = pixels[offset + 2];
  }
  return { tensor: new ort.Tensor('float32', tensorData, [height, width, 3]), width, height, scale };
}
async function runEncoder(input, id) {
  try { return await encoderSession.run({ [encoderSession.inputNames[0]]: input }); }
  catch (error) {
    if (encoderBackend !== 'webgpu') throw error;
    console.warn('MobileSAM encoder WebGPU inference failed; retrying on WASM.', error);
    const fallback = await createModel(ENCODER_URL, 'MobileSAM image encoder', id, 'wasm');
    encoderSession = fallback.session;
    encoderBackend = fallback.backend;
    return encoderSession.run({ [encoderSession.inputNames[0]]: input });
  }
}
async function runDecoder(feeds, id) {
  try { return await decoderSession.run(feeds); }
  catch (error) {
    if (decoderBackend !== 'webgpu') throw error;
    console.warn('MobileSAM decoder WebGPU inference failed; retrying on WASM.', error);
    progress(id, 'WebGPU inference failed · retrying selection on WASM…');
    const fallback = await createModel(DECODER_URL, 'MobileSAM mask decoder', id, 'wasm');
    decoderSession = fallback.session;
    decoderBackend = fallback.backend;
    return decoderSession.run(feeds);
  }
}
function decoderMask(output, nativeWidth, nativeHeight) {
  const width = output.dims.at(-1);
  const height = output.dims.at(-2);
  let max = -Infinity;
  let min = Infinity;
  for (let i = 0; i < output.data.length; i++) {
    max = Math.max(max, output.data[i]);
    min = Math.min(min, output.data[i]);
  }
  const normalized = min >= 0 && max <= 1;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4 + 3] = (normalized ? output.data[i] > .5 : output.data[i] > 0) ? 255 : 0;
  }
  const from = new OffscreenCanvas(width, height);
  from.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const to = new OffscreenCanvas(nativeWidth, nativeHeight);
  const ctx = to.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(from, 0, 0, nativeWidth, nativeHeight);
  const alpha = ctx.getImageData(0, 0, nativeWidth, nativeHeight).data;
  const mask = new Uint8ClampedArray(nativeWidth * nativeHeight);
  for (let i = 0; i < mask.length; i++) mask[i] = alpha[i * 4 + 3];
  return mask;
}
async function handle(message) {
  const { id, type } = message;
  try {
    if (type === 'encode') {
      const { bitmap } = message;
      if (!encoderSession) {
        progress(id, 'Loading MobileSAM image encoder…');
        const model = await createModel(ENCODER_URL, 'MobileSAM image encoder (~28 MB)', id);
        encoderSession = model.session;
        encoderBackend = model.backend;
      }
      progress(id, 'Encoding image in a background worker…');
      const prepared = prepareEncoder(bitmap);
      imageSize = { width: bitmap.width, height: bitmap.height, scaledWidth: prepared.width, scaledHeight: prepared.height, scale: prepared.scale };
      const outputs = await runEncoder(prepared.tensor, id);
      embeddings = outputs[encoderSession.outputNames[0]];
      bitmap.close();
      self.postMessage({ id, result: { ready: true } });
      return;
    }
    if (type === 'select') {
      if (!embeddings || !imageSize) throw new Error('Encode the image before selecting an object.');
      if (!decoderSession) {
        progress(id, 'Loading MobileSAM mask decoder…');
        const model = await createModel(DECODER_URL, 'MobileSAM mask decoder (~17 MB)', id);
        decoderSession = model.session;
        decoderBackend = model.backend;
      }
      progress(id, 'Predicting a brush point in the background worker…');
      const px = Math.max(0, Math.min(imageSize.scaledWidth - 1, Math.round(message.x * imageSize.scale)));
      const py = Math.max(0, Math.min(imageSize.scaledHeight - 1, Math.round(message.y * imageSize.scale)));
      const feeds = {
        image_embeddings: embeddings,
        point_coords: new ort.Tensor('float32', new Float32Array([px, py, 0, 0]), [1, 2, 2]),
        point_labels: new ort.Tensor('float32', new Float32Array([1, -1]), [1, 2]),
        mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
        has_mask_input: new ort.Tensor('float32', new Float32Array([0]), [1]),
        orig_im_size: new ort.Tensor('float32', new Float32Array([imageSize.scaledHeight, imageSize.scaledWidth]), [2]),
      };
      const outputs = await runDecoder(feeds, id);
      const maskTensor = outputs.masks || outputs[decoderSession.outputNames[0]];
      if (!maskTensor?.data || !maskTensor?.dims) throw new Error('MobileSAM returned an unsupported selection mask.');
      const mask = decoderMask(maskTensor, imageSize.width, imageSize.height);
      self.postMessage({ id, result: { mask: mask.buffer } }, [mask.buffer]);
      return;
    }
    throw new Error(`Unknown MobileSAM task: ${type}`);
  } catch (error) {
    self.postMessage({ id, error: error?.message || String(error) });
  }
}
self.addEventListener('message', (event) => { void handle(event.data); });


