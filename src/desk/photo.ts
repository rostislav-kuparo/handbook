// A photo of a desk, brought to a working size: phones take 12–48 Mp, the
// editor needs at most a few thousand pixels across (and a GPU texture).

/** Longest side of the working copy, in pixels. */
export const WORK_SIDE = 4096;

export interface Photo {
  /** Upright (EXIF orientation applied), sRGB, at most `WORK_SIDE` across. */
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** File name without the extension. */
  name: string;
}

const HEIC = /\.(heic|heif)$/i;

/**
 * Opens an image file. The browser decodes it, turns it upright by its EXIF
 * orientation and converts wide-gamut colour (Display P3) to sRGB; large
 * photos are scaled down to `maxSide`.
 */
export async function loadPhoto(file: File, maxSide = WORK_SIDE): Promise<Photo> {
  if (HEIC.test(file.name) || /hei[cf]/i.test(file.type)) {
    throw new Error('Фото в формате HEIC открыть нельзя. Сохраните его как JPEG (на iPhone: «Настройки → Камера → Форматы → Наиболее совместимый») и откройте снова.');
  }
  let full: ImageBitmap;
  try {
    full = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Не удалось открыть «${file.name}» как картинку. Подойдут JPG, PNG и WebP.`);
  }
  const k = Math.min(1, maxSide / Math.max(full.width, full.height));
  const name = file.name.replace(/\.[^.]+$/, '');
  if (k === 1) return { bitmap: full, width: full.width, height: full.height, name };
  const width = Math.max(1, Math.round(full.width * k));
  const height = Math.max(1, Math.round(full.height * k));
  try {
    const bitmap = await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    return { bitmap, width, height, name };
  } finally {
    full.close();
  }
}
