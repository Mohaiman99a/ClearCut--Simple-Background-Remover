import './style.css';
import { SelectionModel } from './selection.js';

const $ = (selector) => document.querySelector(selector);
const input = $('#file-input');
const dropArea = $('#drop-area');
const emptyState = $('#empty-state');
const canvasFrame = $('#canvas-frame');
const resultCanvas = $('#result-canvas');
const overlayCanvas = $('#selection-overlay');
const brushCursor = $('#brush-cursor');
const busyState = $('#busy-state');
const busyLabel = $('#busy-label');
const actionStatus = $('#action-status');
const editControls = $('#edit-controls');
const pendingActions = $('#pending-actions');
const toleranceControl = $('#tolerance-control');
const toleranceSlider = $('#tolerance-slider');
const toleranceValue = $('#tolerance-value');
const confirmButton = $('#selection-confirm');
const cancelButton = $('#selection-cancel');
const undoButton = $('#undo-button');
const startOverButton = $('#start-over-button');
const downloadButton = $('#download-button');
const historyList = $('#history-list');
const historyEmpty = $('#history-empty');
const toast = $('#toast');
const selection = new SelectionModel(resultCanvas, overlayCanvas);

const MAX_IMAGE_DIMENSION = 2048;
const BRUSH_SAMPLE_MS = 120;
const BRUSH_SAMPLE_DISTANCE = 10;
const BRUSH_RADIUS = 20;
let activeTool = 'auto';
let activeMode = 'add';
let activeImageUrl = null;
let activeImage = null;
let currentFilename = 'clearcut-image';
let colorSeed = null;
let history = [];
let undoStack = [];
let toastTimer;
let startOverTimer;
let imageVersion = 0;
let autoRemovalVersion = 0;
let historyItemId = 0;
let candidateVersion = 0;
let smartStroke = null;

function browse() { input.click(); }
function announce(message) { actionStatus.textContent = message; }
function setBusy(isBusy, message = 'Working on your image…') {
  busyState.hidden = !isBusy;
  busyLabel.textContent = message;
  dropArea.setAttribute('aria-busy', String(isBusy));
}
function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
}
function updateDownloadState() { downloadButton.disabled = !selection.hasMask; }
function updateUndoState() { undoButton.disabled = undoStack.length === 0; }
function updatePendingState() {
  const hasPending = Boolean(selection.candidate || smartStroke?.active || smartStroke?.processing || smartStroke?.queuedPoint);
  pendingActions.hidden = !hasPending;
  cancelButton.disabled = !hasPending;
  confirmButton.disabled = !selection.candidate || Boolean(smartStroke?.active || smartStroke?.processing || smartStroke?.queuedPoint);
}
function setMode(mode) {
  activeMode = mode;
  selection.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const selected = button.dataset.mode === mode;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  if (selection.candidate) selection.drawCandidate();
}
function setTool(tool) {
  activeTool = tool;
  document.querySelectorAll('[data-tool]').forEach((tab) => {
    const selected = tab.dataset.tool === tool;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
  dropArea.classList.toggle('tool-smart', tool === 'smart');
  dropArea.classList.toggle('tool-color', tool === 'color');
  editControls.hidden = !activeImage || tool === 'auto';
  toleranceControl.hidden = tool !== 'color';
  startOverButton.hidden = !activeImage;
  updateDownloadState();
  updatePendingState();
  if (tool === 'auto') announce(selection.hasMask ? 'Shared mask ready' : 'Ready when you are');
  if (tool === 'smart') {
    announce('Paint over objects to add or remove them from the shared mask');
    if (activeImage && !autoRemovalVersion) void prepareSmartEncoder(activeImage, imageVersion);
  }
  if (tool === 'color') announce('Pick a connected color region to preview it');
}
function snapshotAppState() {
  return {
    selection: selection.snapshot(),
    filename: currentFilename,
    history: history.slice(),
  };
}
function pushUndoState() {
  const state = snapshotAppState();
  if (!state.selection && !state.history.length) return;
  undoStack.push(state);
  if (undoStack.length > 40) undoStack.shift();
  updateUndoState();
}
function restoreAppState(state) {
  imageVersion++;
  autoRemovalVersion = 0;
  smartStroke = null;
  candidateVersion++;
  colorSeed = null;
  if (activeImageUrl) URL.revokeObjectURL(activeImageUrl);
  activeImageUrl = null;
  history = state.history.slice();
  currentFilename = state.filename;
  if (state.selection) {
    selection.restore(state.selection);
    activeImage = document.createElement('canvas');
    activeImage.width = state.selection.imageData.width;
    activeImage.height = state.selection.imageData.height;
    activeImage.getContext('2d').putImageData(state.selection.imageData, 0, 0);
    emptyState.hidden = true;
    canvasFrame.hidden = false;
    dropArea.classList.add('has-image');
  } else {
    selection.clear();
    activeImage = null;
    emptyState.hidden = false;
    canvasFrame.hidden = true;
    dropArea.classList.remove('has-image');
  }
  setBusy(false);
  renderHistory();
  setTool(activeTool);
  updateDownloadState();
  updateUndoState();
  updatePendingState();
  announce('Last change undone');
}
function undo() {
  const previous = undoStack.pop();
  if (!previous) return;
  restoreAppState(previous);
}

function prepareWorkingImage(image) {
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(sourceWidth, sourceHeight));
  const working = document.createElement('canvas');
  working.width = Math.max(1, Math.round(sourceWidth * scale));
  working.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = working.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, working.width, working.height);
  return working;
}

function pointFromEvent(event) {
  const rect = resultCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return {
    x: Math.min(selection.width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * selection.width / rect.width))),
    y: Math.min(selection.height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * selection.height / rect.height))),
  };
}
function moveBrushCursor(event) {
  if (!activeImage || activeTool !== 'smart') { brushCursor.hidden = true; return; }
  const frame = canvasFrame.getBoundingClientRect();
  brushCursor.hidden = false;
  brushCursor.style.left = `${event.clientX - frame.left}px`;
  brushCursor.style.top = `${event.clientY - frame.top}px`;
  brushCursor.style.width = `${BRUSH_RADIUS * 2}px`;
  brushCursor.style.height = `${BRUSH_RADIUS * 2}px`;
}
function previewColorRegion(x, y) {
  const candidate = selection.floodFill(x, y, toleranceSlider.value);
  if (!candidate) return;
  let pixels = 0;
  for (let i = 0; i < candidate.length; i++) pixels += candidate[i] ? 1 : 0;
  if (!pixels) {
    selection.clearCandidate();
    updatePendingState();
    announce('No connected pixels matched that color');
    return;
  }
  selection.setCandidate(candidate, 'color', activeMode);
  updatePendingState();
  announce(`${pixels.toLocaleString()} connected pixels · ${activeMode === 'add' ? 'keep' : 'remove'} preview`);
}

function enqueueSmartPoint(point, force = false) {
  const stroke = smartStroke;
  if (!stroke || stroke.cancelled) return;
  const prior = stroke.queuedPoint || stroke.lastPoint;
  if (!force && prior && Math.hypot(point.x - prior.x, point.y - prior.y) < BRUSH_SAMPLE_DISTANCE) return;
  stroke.queuedPoint = point;
  updatePendingState();
  if (!stroke.processing) void drainSmartPoints(stroke);
}
async function drainSmartPoints(stroke) {
  if (stroke.processing) return;
  stroke.processing = true;
  updatePendingState();
  while (stroke.queuedPoint && !stroke.cancelled && smartStroke === stroke) {
    const remaining = BRUSH_SAMPLE_MS - (performance.now() - stroke.lastSampleAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    const point = stroke.queuedPoint;
    stroke.queuedPoint = null;
    if (!point || stroke.cancelled || smartStroke !== stroke) break;
    try {
      const { predictSmartSelection } = await import('./models.js');
      const candidate = await predictSmartSelection(activeImage, point.x, point.y, (message) => {
        if (!stroke.cancelled) announce(message);
      });
      if (stroke.cancelled || stroke !== smartStroke || stroke.imageVersion !== imageVersion) break;
      selection.setCandidate(candidate, 'smart', activeMode, true);
      stroke.lastPoint = point;
      stroke.lastSampleAt = performance.now();
      announce('Smart Select stroke preview · continue painting or apply');
    } catch (error) {
      if (!stroke.cancelled) {
        console.error('MobileSAM brush point failed', error);
        showToast('Smart Select could not segment this brush point.');
      }
    }
    updatePendingState();
  }
  stroke.processing = false;
  if (smartStroke === stroke && !stroke.active) smartStroke = null;
  updatePendingState();
  if (!smartStroke && selection.candidate) announce('Smart Select stroke ready · Apply or Cancel');
}
function cancelPendingSelection() {
  candidateVersion++;
  if (smartStroke) {
    smartStroke.cancelled = true;
    smartStroke.active = false;
    smartStroke.queuedPoint = null;
    smartStroke = null;
  }
  selection.clearCandidate();
  colorSeed = null;
  setBusy(false);
  updatePendingState();
  updateDownloadState();
  announce(activeTool === 'color' ? 'Pick a connected color region to preview it' : 'Click or drag over an object to select it');
}
function commitCandidate() {
  if (!selection.candidate || confirmButton.disabled) return;
  pushUndoState();
  if (!selection.mergeCandidate(activeMode)) return;
  colorSeed = null;
  const label = activeTool === 'smart' ? 'Smart Select edit' : 'Color Select edit';
  addHistorySnapshot(label);
  updatePendingState();
  updateDownloadState();
  announce('Selection committed to the shared mask');
}

function addHistorySnapshot(reason) {
  const snapshot = selection.snapshot();
  if (!snapshot) return;
  const scale = Math.min(1, 128 / Math.max(snapshot.imageData.width, snapshot.imageData.height));
  const thumbnail = document.createElement('canvas');
  thumbnail.width = Math.max(1, Math.round(snapshot.imageData.width * scale));
  thumbnail.height = Math.max(1, Math.round(snapshot.imageData.height * scale));
  const source = document.createElement('canvas');
  source.width = snapshot.imageData.width;
  source.height = snapshot.imageData.height;
  source.getContext('2d').putImageData(snapshot.imageData, 0, 0);
  const context = thumbnail.getContext('2d');
  context.drawImage(source, 0, 0, thumbnail.width, thumbnail.height);
  const thumbPixels = context.getImageData(0, 0, thumbnail.width, thumbnail.height);
  for (let i = 0, pixel = 0; i < thumbPixels.data.length; i += 4, pixel++) {
    const sx = Math.min(snapshot.imageData.width - 1, Math.floor((pixel % thumbnail.width) / scale));
    const sy = Math.min(snapshot.imageData.height - 1, Math.floor(Math.floor(pixel / thumbnail.width) / scale));
    thumbPixels.data[i + 3] = Math.round(thumbPixels.data[i + 3] * snapshot.mask[sy * snapshot.imageData.width + sx] / 255);
  }
  context.putImageData(thumbPixels, 0, 0);
  history.unshift({
    id: ++historyItemId,
    snapshot: { imageData: snapshot.imageData, mask: new Uint8ClampedArray(snapshot.mask), maskReady: snapshot.maskReady },
    url: thumbnail.toDataURL('image/png'), reason, filename: currentFilename,
  });
  if (history.length > 12) history.pop();
  renderHistory();
}
function restoreHistoryItem(item) {
  if (activeImageUrl) URL.revokeObjectURL(activeImageUrl);
  activeImageUrl = null;
  imageVersion++;
  autoRemovalVersion = 0;
  selection.restore(item.snapshot);
  activeImage = document.createElement('canvas');
  activeImage.width = item.snapshot.imageData.width;
  activeImage.height = item.snapshot.imageData.height;
  activeImage.getContext('2d').putImageData(item.snapshot.imageData, 0, 0);
  currentFilename = item.filename;
  emptyState.hidden = true;
  canvasFrame.hidden = false;
  dropArea.classList.add('has-image');
  setTool(activeTool);
  updateDownloadState();
  announce('Restored from session history');
}
function deleteHistoryItem(itemId) {
  if (!history.some((item) => item.id === itemId)) return;
  pushUndoState();
  history = history.filter((item) => item.id !== itemId);
  renderHistory();
  announce('History item deleted · Undo to restore it');
}
function renderHistory() {
  historyEmpty.hidden = history.length > 0;
  historyList.querySelectorAll('.history-entry').forEach((entry) => entry.remove());
  history.forEach((item, index) => {
    const entry = document.createElement('div');
    entry.className = 'history-entry';
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'history-thumb';
    restore.title = `${item.reason} · restore image`;
    restore.setAttribute('aria-label', `Restore ${item.reason.toLowerCase()} ${index + 1}`);
    const image = document.createElement('img');
    image.src = item.url;
    image.alt = '';
    restore.append(image);
    restore.addEventListener('click', () => restoreHistoryItem(item));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-delete';
    remove.setAttribute('aria-label', `Delete history item ${index + 1}`);
    remove.title = 'Delete from session history';
    remove.textContent = '×';
    remove.addEventListener('click', () => deleteHistoryItem(item.id));
    entry.append(restore, remove);
    historyList.insertBefore(entry, historyEmpty);
  });
}

function clearCurrentImage() {
  if (activeImageUrl) URL.revokeObjectURL(activeImageUrl);
  activeImageUrl = null;
  activeImage = null;
  imageVersion++;
  autoRemovalVersion = 0;
  smartStroke = null;
  candidateVersion++;
  colorSeed = null;
  selection.clear();
  emptyState.hidden = false;
  canvasFrame.hidden = true;
  dropArea.classList.remove('has-image', 'tool-smart', 'tool-color');
  brushCursor.hidden = true;
  setBusy(false);
  currentFilename = 'clearcut-image';
  confirmStartOver(false);
  setTool('auto');
  updatePendingState();
  updateDownloadState();
}
function confirmStartOver(confirming) {
  clearTimeout(startOverTimer);
  startOverButton.dataset.confirming = String(confirming);
  startOverButton.textContent = confirming ? 'Confirm Start Over' : 'Start Over';
  startOverButton.setAttribute('aria-label', confirming ? 'Confirm start over' : 'Start over and clear current image');
  if (confirming) startOverTimer = setTimeout(() => confirmStartOver(false), 3500);
}

function startSmartStroke(event) {
  if (activeTool !== 'smart' || !activeImage || event.button !== 0) return;
  const point = pointFromEvent(event);
  if (!point) return;
  event.preventDefault();
  dropArea.setPointerCapture(event.pointerId);
  smartStroke = { pointerId: event.pointerId, imageVersion, active: true, processing: false, queuedPoint: null, lastPoint: null, lastSampleAt: 0, cancelled: false };
  enqueueSmartPoint(point, true);
  updatePendingState();
}
function continueSmartStroke(event) {
  moveBrushCursor(event);
  if (!smartStroke?.active || event.pointerId !== smartStroke.pointerId) return;
  const point = pointFromEvent(event);
  if (point) enqueueSmartPoint(point);
}
function finishSmartStroke(event) {
  const stroke = smartStroke;
  if (!stroke?.active || event.pointerId !== stroke.pointerId) return;
  stroke.active = false;
  if (stroke.queuedPoint && !stroke.processing) void drainSmartPoints(stroke);
  updatePendingState();
  if (!stroke.processing && !stroke.queuedPoint) {
    smartStroke = null;
    updatePendingState();
    if (selection.candidate) announce('Smart Select stroke ready · Apply or Cancel');
  }
}

undoButton.addEventListener('click', undo);
document.querySelectorAll('[data-browse]').forEach((button) => button.addEventListener('click', browse));
document.querySelectorAll('[data-tool]').forEach((tab) => tab.addEventListener('click', () => setTool(tab.dataset.tool)));
document.querySelectorAll('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
cancelButton.addEventListener('click', cancelPendingSelection);
confirmButton.addEventListener('click', commitCandidate);
startOverButton.addEventListener('click', () => {
  if (startOverButton.dataset.confirming === 'true') {
    pushUndoState();
    clearCurrentImage();
    announce('Image cleared · Undo to restore it');
  } else confirmStartOver(true);
});
toleranceSlider.addEventListener('input', () => {
  toleranceValue.value = toleranceSlider.value;
  if (activeTool === 'color' && colorSeed) previewColorRegion(colorSeed.x, colorSeed.y);
});
input.addEventListener('change', () => { if (input.files?.[0]) void loadImage(input.files[0]); });
dropArea.addEventListener('pointerdown', startSmartStroke);
dropArea.addEventListener('pointermove', continueSmartStroke);
dropArea.addEventListener('pointerup', finishSmartStroke);
dropArea.addEventListener('pointercancel', (event) => {
  if (smartStroke?.active && event.pointerId === smartStroke.pointerId) cancelPendingSelection();
});
dropArea.addEventListener('pointerleave', () => { if (activeTool !== 'smart') brushCursor.hidden = true; });
dropArea.addEventListener('click', (event) => {
  if (event.target.closest('button')) return;
  if (activeTool !== 'color' || !activeImage) return;
  const point = pointFromEvent(event);
  if (!point) return;
  colorSeed = point;
  previewColorRegion(point.x, point.y);
});

async function loadImage(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Choose a supported image file to continue.');
    return;
  }
  if (activeImageUrl) URL.revokeObjectURL(activeImageUrl);
  activeImageUrl = URL.createObjectURL(file);
  const version = ++imageVersion;
  currentFilename = file.name.replace(/\.[^.]+$/, '') || 'clearcut-image';
  const image = new Image();
  setBusy(true, 'Preparing image…');
  announce('Preparing your image');
  try {
    image.src = activeImageUrl;
    await image.decode();
    if (version !== imageVersion) return;
    activeImage = prepareWorkingImage(image);
    selection.setImage(activeImage);
    emptyState.hidden = true;
    canvasFrame.hidden = false;
    dropArea.classList.add('has-image');
    setTool('auto');
    updateDownloadState();
    await runAutoRemoval(activeImage, version);
  } catch (error) {
    console.error('Could not open the selected image', error);
    showToast('This image could not be opened. Try another file.');
    announce('Unable to open image');
    if (version === imageVersion) setBusy(false);
  } finally {
    input.value = '';
  }
}
async function runAutoRemoval(image, version) {
  autoRemovalVersion = version;
  setBusy(true, 'Loading RMBG-1.4 for the first time…');
  announce('Loading background removal model…');
  try {
    const { removeBackground } = await import('./models.js');
    const mask = await removeBackground(image, (message) => {
      if (version !== imageVersion) return;
      busyLabel.textContent = message;
      announce(message);
    });
    if (version !== imageVersion) return;
    pushUndoState();
    selection.setMask(mask);
    updateDownloadState();
    addHistorySnapshot('Background removed');
    announce('Background removed · shared mask ready');
  } catch (error) {
    if (version !== imageVersion) return;
    console.error('RMBG-1.4 background removal failed', error);
    showToast('Background removal could not run. Your image is still available for manual selections.');
    addHistorySnapshot('Image ready');
    announce(import.meta.env.DEV ? `Background removal failed · ${error.message}` : 'Background removal failed · original image remains editable');
  } finally {
    if (autoRemovalVersion === version) autoRemovalVersion = 0;
    if (version === imageVersion) {
      setBusy(false);
      if (activeTool === 'smart' && !selection.candidate) void prepareSmartEncoder(image, version);
    }
  }
}
async function prepareSmartEncoder(image, version) {
  setBusy(true, 'Loading MobileSAM image encoder…');
  try {
    const { encodeForSmartSelect } = await import('./models.js');
    await encodeForSmartSelect(image, (message) => {
      if (version !== imageVersion) return;
      busyLabel.textContent = message;
      announce(message);
    });
    if (version === imageVersion && activeTool === 'smart') announce('Image encoded · paint over a subject to select it');
  } catch (error) {
    if (version === imageVersion) {
      console.error('MobileSAM image encoder failed', error);
      showToast('Smart Select could not prepare this image. Check your connection and try again.');
      announce(import.meta.env.DEV ? `Smart Select setup failed · ${error.message}` : 'Smart Select could not prepare the image');
    }
  } finally {
    if (version === imageVersion) setBusy(false);
  }
}
for (const eventName of ['dragenter', 'dragover']) {
  dropArea.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropArea.classList.add('is-dragging');
  });
}
for (const eventName of ['dragleave', 'drop']) {
  dropArea.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (eventName === 'drop') {
      const file = event.dataTransfer?.files?.[0];
      if (file) void loadImage(file);
    }
    dropArea.classList.remove('is-dragging');
  });
}
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  if (!dropArea.contains(event.target)) {
    event.preventDefault();
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadImage(file);
  }
});

downloadButton.addEventListener('click', () => {
  if (downloadButton.disabled) return;
  resultCanvas.toBlob((blob) => {
    if (!blob) { showToast('The transparent PNG could not be exported.'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${currentFilename}-clearcut.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    addHistorySnapshot('Downloaded result');
    announce('Transparent PNG downloaded');
  }, 'image/png');
});
startOverButton.hidden = true;
updateUndoState();
updatePendingState();
