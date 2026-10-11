// Profile pictures: the browser crops the chosen photo to a centered square and shrinks it before
// upload, so a phone photo of several MB becomes a small JPEG (the server checks it again).
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_TYPES = ['image/jpeg', 'image/png'];
const AVATAR_SIZE = 256;
const AVATAR_QUALITY = 0.9;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image could not be read'));
    };
    img.src = url;
  });
}

/** The chosen file as a square JPEG Blob. */
export async function toAvatarBlob(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error('Image could not be read');
  const size = Math.min(AVATAR_SIZE, side);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency: a transparent PNG gets a white background, not black
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Image could not be read'))), 'image/jpeg', AVATAR_QUALITY);
  });
}
