import api from '@/services/api';
import { speciesName } from '@/utils/species';

// Box color of the detection overlay (drawn on photos, not part of the page theme)
const BOX_COLOR = '#2563eb';

/**
 * Draw the AI detections of a snapshot: a box around each insect with its species and confidence.
 * `scale` maps the model's pixel coordinates to the canvas.
 */
export function drawDetections(ctx, detections, { t, scale = 1, imageWidth }) {
  const width = imageWidth || ctx.canvas.width;
  const fontSize = Math.max(11, Math.round(width / 55));
  ctx.lineWidth = Math.max(2, width / 400);
  ctx.font = `bold ${fontSize}px Quicksand, sans-serif`;
  for (const det of detections || []) {
    const box = det.bbox;
    if (!box || box.length < 4) continue;
    const x = box[0] * scale;
    const y = box[1] * scale;
    const w = (box[2] - box[0]) * scale;
    const h = (box[3] - box[1]) * scale;
    ctx.strokeStyle = BOX_COLOR;
    ctx.strokeRect(x, y, w, h);

    const conf = det.confidence ? Math.round(det.confidence * 100) : 100;
    const label = `${speciesName(det.name, t)} (${conf}%)`;
    const textWidth = ctx.measureText(label).width;
    ctx.fillStyle = BOX_COLOR;
    ctx.fillRect(x, Math.max(0, y - fontSize - 6), textWidth + 10, fontSize + 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + 5, Math.max(fontSize, y - 4));
  }
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

/**
 * The snapshot photo with its detection boxes, scaled to at most `maxWidth` pixels, as a JPEG.
 * Returns { dataUrl, blob, width, height } or null when the photo cannot be loaded.
 */
export async function annotatedImage(item, { t, maxWidth = 640, quality = 0.72 } = {}) {
  const src = api.getImageUrl(item?.imageUrl || item?.s3Key);
  if (!src) return null;
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, maxWidth / img.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    drawDetections(ctx, item.aiResults?.insects, { t, scale, imageWidth: canvas.width });
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
    return { dataUrl, blob, width: canvas.width, height: canvas.height };
  } catch {
    return null;
  }
}

/**
 * Run `task` over `items` with a few at a time, keeping the order of the results.
 */
export async function mapLimit(items, limit, task, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i], i);
      done++;
      onProgress?.(done, items.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
