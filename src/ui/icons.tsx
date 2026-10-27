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
