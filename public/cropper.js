const OUTPUT_LONG_SIDE = 1280;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 4;

const modal = document.getElementById('cropperModal');
const canvas = document.getElementById('cropperCanvas');
const zoomRange = document.getElementById('cropperZoom');
const btnZoomIn = document.getElementById('cropperZoomIn');
const btnZoomOut = document.getElementById('cropperZoomOut');
const btnRotate = document.getElementById('cropperRotate');
const btnReset = document.getElementById('cropperReset');
const btnConfirm = document.getElementById('cropperConfirm');
const btnCancel = document.getElementById('cropperCancel');

let state = null;

function ratioSize(ratio, longSide) {
  const [w, h] = ratio.split(':').map(Number);
  const scale = longSide / Math.max(w, h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// Draws the image into `target` using the current pan/zoom/rotation; offsets are expressed relative to the preview size.
function draw(target, previewWidth) {
  const context = target.getContext('2d');
  const k = target.width / previewWidth;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, target.width, target.height);
  const { image, rotation, zoom, offsetX, offsetY } = state;
  const rotated = rotation % 180 !== 0;
  const imageWidth = rotated ? image.naturalHeight : image.naturalWidth;
  const imageHeight = rotated ? image.naturalWidth : image.naturalHeight;
  const base = Math.min(target.width / imageWidth, target.height / imageHeight);
  context.save();
  context.translate(target.width / 2 + offsetX * k, target.height / 2 + offsetY * k);
  context.rotate((rotation * Math.PI) / 180);
  context.scale(base * zoom, base * zoom);
  context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
  context.restore();
}

function render() {
  draw(canvas, canvas.width);
  zoomRange.value = String(state.zoom);
}

function setZoom(value) {
  state.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
  render();
}

function resetTransform() {
  Object.assign(state, { rotation: 0, zoom: 1, offsetX: 0, offsetY: 0 });
  render();
}

function close(result) {
  modal.classList.add('hidden');
  document.body.classList.remove('cropper-open');
  const { resolve } = state;
  state = null;
  resolve(result);
}

function onPointerDown(event) {
  if (!state) return;
  canvas.setPointerCapture(event.pointerId);
  state.drag = { x: event.clientX, y: event.clientY, offsetX: state.offsetX, offsetY: state.offsetY };
}

function onPointerMove(event) {
  if (!state?.drag) return;
  const scale = canvas.width / canvas.getBoundingClientRect().width;
  state.offsetX = state.drag.offsetX + (event.clientX - state.drag.x) * scale;
  state.offsetY = state.drag.offsetY + (event.clientY - state.drag.y) * scale;
  render();
}

function onPointerUp() {
  if (state) state.drag = null;
}

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);
canvas.addEventListener('wheel', (event) => {
  if (!state) return;
  event.preventDefault();
  setZoom(state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
}, { passive: false });
zoomRange.addEventListener('input', () => state && setZoom(Number(zoomRange.value)));
btnZoomIn.addEventListener('click', () => state && setZoom(state.zoom * 1.15));
btnZoomOut.addEventListener('click', () => state && setZoom(state.zoom / 1.15));
btnRotate.addEventListener('click', () => {
  if (!state) return;
  state.rotation = (state.rotation + 90) % 360;
  render();
});
btnReset.addEventListener('click', () => state && resetTransform());
btnCancel.addEventListener('click', () => state && close(null));
modal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state) close(null);
});
btnConfirm.addEventListener('click', () => {
  if (!state) return;
  const { width, height } = ratioSize(state.ratio, OUTPUT_LONG_SIDE);
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  draw(output, canvas.width);
  close(output.toDataURL('image/jpeg', 0.85));
});

// Opens the crop/center dialog for a loaded image and resolves with a JPEG data URL (or null if cancelled).
export function openCropper(image, ratio = '9:16') {
  if (state) close(null);
  return new Promise((resolve) => {
    const preview = ratioSize(ratio, 640);
    canvas.width = preview.width;
    canvas.height = preview.height;
    state = { image, ratio, resolve, rotation: 0, zoom: 1, offsetX: 0, offsetY: 0, drag: null };
    zoomRange.min = String(MIN_ZOOM);
    zoomRange.max = String(MAX_ZOOM);
    modal.classList.remove('hidden');
    document.body.classList.add('cropper-open');
    render();
    btnConfirm.focus();
  });
}
