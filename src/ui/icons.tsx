import type { ReactNode } from 'react';

/** A 20×20 line icon in the text colour, like the rest of the app's icons. */
function Icon({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** «Вставить блок». */
export const BlockIcon = () => (
  <Icon>
    <rect x="3" y="3" width="14" height="14" rx="3.5" />
    <path d="M10 6.8v6.4M6.8 10h6.4" />
  </Icon>
);

/** «Лист». */
export const SheetIcon = () => (
  <Icon>
    <rect x="4.5" y="2.5" width="11" height="15" rx="1.8" />
    <path d="M7.3 7h5.4M7.3 10h5.4M7.3 13h3.4" />
  </Icon>
);

/** «Формулы». */
export const SigmaIcon = () => (
  <Icon>
    <path d="M14.5 4.5h-9l4.8 5.5-4.8 5.5h9" />
  </Icon>
);

/** «Чертежи»: a set square. */
export const DrawingIcon = () => (
  <Icon>
    <path d="M4 16.5V3.5l13 13z" />
    <path d="M7 13.5V10.7l2.8 2.8z" />
  </Icon>
);

/** «Отрендерить»: a pen nib. */
export const NibIcon = () => (
  <Icon>
    <path d="M6 3.5h8l-.9 6.2L10 17l-3.1-7.3z" />
    <path d="M10 10.4V17" />
    <circle cx="10" cy="9.2" r="1.2" />
  </Icon>
);

/** «Редактировать»: a pencil. */
export const PencilIcon = () => (
  <Icon>
    <path d="M4 16l.9-3.9 8.4-8.4a2 2 0 0 1 2.9 2.9l-8.4 8.4z" />
    <path d="M12.1 4.9l2.9 2.9" />
  </Icon>
);

/** Render settings. */
export const SlidersIcon = () => (
  <Icon>
    <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    <circle cx="7.5" cy="6" r="1.7" fill="var(--panel)" />
    <circle cx="12.5" cy="10" r="1.7" fill="var(--panel)" />
    <circle cx="6.5" cy="14" r="1.7" fill="var(--panel)" />
  </Icon>
);

/** «Экспорт». */
export const ExportIcon = () => (
  <Icon>
    <path d="M10 12.5V3.5M6.6 6.9 10 3.5l3.4 3.4" />
    <path d="M4 11v3.6A1.9 1.9 0 0 0 5.9 16.5h8.2a1.9 1.9 0 0 0 1.9-1.9V11" />
  </Icon>
);

/** Export history (like a browser's downloads button). */
export const DownloadIcon = () => (
  <Icon>
    <path d="M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4 16h12" />
  </Icon>
);

/* ---------- export onto a photo («На столе») ---------- */

/** «↻ Верх листа»: the sheet's top goes to the next side. */
export const TurnIcon = () => (
  <Icon>
    <path d="M15.5 9.5a5.5 5.5 0 1 1-1.8-4.1" />
    <path d="M14.2 2.6v3.2H11" />
  </Icon>
);

/** «Повернуть снимок»: a picture with an arrow round its corner. */
export const RotatePhotoIcon = () => (
  <Icon>
    <rect x="3" y="7" width="9" height="10" rx="1" />
    <path d="M9 3.5a7 7 0 0 1 7.5 6.5" />
    <path d="M18.3 7.6 16.5 10l-2.4-1.7" />
  </Icon>
);

/** «Найти лист»: a frame of corners round a sheet. */
export const FindSheetIcon = () => (
  <Icon>
    <path d="M3 6.5V3h3.5M13.5 3H17v3.5M17 13.5V17h-3.5M6.5 17H3v-3.5" />
    <rect x="6.5" y="6" width="7" height="8" rx="1" />
  </Icon>
);

/** «Скан»: the sheet fills the frame. */
export const ScanIcon = () => (
  <Icon>
    <rect x="3.5" y="2.5" width="13" height="15" rx="1.5" />
    <path d="M3.5 10h13" />
  </Icon>
);

/** «Изогнутый лист»: a sheet with bowed sides. */
export const CurveIcon = () => (
  <Icon>
    <path d="M5 3.5c1.6 1 3.4 1.4 5 1.4s3.4-.4 5-1.4c-.6 2-.9 4.3-.9 6.5s.3 4.5.9 6.5c-1.6-1-3.4-1.4-5-1.4s-3.4.4-5 1.4c.6-2 .9-4.3.9-6.5S5.6 5.5 5 3.5z" />
  </Icon>
);

/** «Стереть»: no text here. */
export const EraseIcon = () => (
  <Icon>
    <path d="M11.5 3.8 16.2 8.5 9 15.7H5.6L3.8 13.9a1.5 1.5 0 0 1 0-2.1z" />
    <path d="M7.4 8 12 12.6M9 15.7h7" />
  </Icon>
);

/** «Вернуть»: paper back under the brush. */
export const BrushIcon = () => (
  <Icon>
    <path d="M16.5 3.5 9.6 10.4" />
    <path d="M8.6 11.2c-1.7-.3-3.3 1-3.3 2.8 0 1.2-.7 2-1.8 2.5 2.6.6 6.4-.2 6.8-3.4z" />
  </Icon>
);

/** «Поля»: a sheet with its margin line. */
export const MarginsIcon = () => (
  <Icon>
    <rect x="3.5" y="2.5" width="13" height="15" rx="1.5" />
    <path d="M7.5 2.5v15" />
    <circle cx="7.5" cy="2.8" r="0.9" />
  </Icon>
);

/** Brush size. */
export const DotIcon = () => (
  <Icon>
    <circle cx="10" cy="10" r="6.5" />
    <circle cx="10" cy="10" r="2.2" />
  </Icon>
);

/** «Найти заново». */
export const AgainIcon = () => (
  <Icon>
    <path d="M4 8.5A6.2 6.2 0 0 1 15.4 6.8M16 11.5A6.2 6.2 0 0 1 4.6 13.2" />
    <path d="M15.8 3.3v3.6h-3.6M4.2 16.7v-3.6h3.6" />
  </Icon>
);

/** «Очистить». */
export const ClearIcon = () => (
  <Icon>
    <path d="M4 5.5h12M8 5.5V3.8h4v1.7M5.5 5.5l.8 10.7h7.4l.8-10.7" />
  </Icon>
);

/** «Взять цвет с настоящей ручки»: a pipette. */
export const PipetteIcon = () => (
  <Icon>
    <path d="m12.2 4.6 3.2 3.2M13.8 3a2.2 2.2 0 0 1 3.2 3.2l-2 2-3.2-3.2z" />
    <path d="M11.8 6.2 4.5 13.5 4 16l2.5-.5 7.3-7.3" />
  </Icon>
);

/** «Масштаб 1:1». */
export const ActualIcon = () => (
  <Icon>
    <path d="M5 6.5 6.8 5v10M14 6.5 15.8 5v10" />
    <circle cx="10.4" cy="8" r="0.5" />
    <circle cx="10.4" cy="12" r="0.5" />
  </Icon>
);

/** A crop frame: two corners crossing. */
export const CropIcon = () => (
  <Icon>
    <path d="M6 2.5V14h11.5M2.5 6H14v11.5" />
  </Icon>
);

/** A close cross. */
export const CloseIcon = () => (
  <Icon>
    <path d="m5 5 10 10M15 5 5 15" />
  </Icon>
);
