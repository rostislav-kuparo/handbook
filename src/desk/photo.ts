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
  /** The lens's focal length as on a full-frame camera, mm (from EXIF; phones' main lens: about 26). */
  focal35?: number;
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
  const focal35 = (await focalOf(file).catch(() => null)) ?? undefined;
  if (k === 1) return { bitmap: full, width: full.width, height: full.height, name, focal35 };
  const width = Math.max(1, Math.round(full.width * k));
  const height = Math.max(1, Math.round(full.height * k));
  try {
    const bitmap = await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' });
    return { bitmap, width, height, name, focal35 };
  } finally {
    full.close();
  }
}

/**
 * The lens's 35 mm equivalent focal length from a JPEG's EXIF
 * (FocalLengthIn35mmFilm), or null when the file does not say.
 */
async function focalOf(file: Blob): Promise<number | null> {
  const buf = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
  if (buf.byteLength < 4 || buf.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  // The markers up to the APP1 holding «Exif».
  while (at + 4 <= buf.byteLength && buf.getUint8(at) === 0xff) {
    const marker = buf.getUint8(at + 1);
    const size = buf.getUint16(at + 2);
    if (marker === 0xe1 && at + 10 <= buf.byteLength && buf.getUint32(at + 4) === 0x45786966) return exifFocal(buf, at + 10);
    if (marker === 0xda) break;
    at += 2 + size;
  }
  return null;
}

/** FocalLengthIn35mmFilm (0xA405) in the Exif sub-IFD of the TIFF block at `tiff`. */
function exifFocal(buf: DataView, tiff: number): number | null {
  const le = buf.getUint16(tiff) === 0x4949;
  const u16 = (o: number) => buf.getUint16(tiff + o, le);
  const u32 = (o: number) => buf.getUint32(tiff + o, le);
  /** The value field of `tag` in the IFD at `ifd`, or null. */
  const find = (ifd: number, tag: number): number | null => {
    if (tiff + ifd + 2 > buf.byteLength) return null;
    const n = u16(ifd);
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      if (tiff + e + 12 > buf.byteLength) return null;
      if (u16(e) === tag) return e + 8;
    }
    return null;
  };
  const sub = find(u32(4), 0x8769);
  if (sub === null) return null;
  const v = find(u32(sub), 0xa405);
  if (v === null) return null;
  const mm = u16(v);
  return mm >= 8 && mm <= 300 ? mm : null;
}
