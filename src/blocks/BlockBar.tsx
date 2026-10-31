// What can be done with the selected block — in a pill at the bottom of the
// window, never on the sheet over the writing. A block not selected does
// nothing but get selected; a selected floating block is moved by its blue
// square and stretched by its edges and corners.
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Side } from './drag';

/** The selected block's actions, in the pill at the bottom of the window. */
export function BlockBar({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="block-bar float no-print" role="toolbar" aria-label="Действия с блоком">
      {children}
    </div>,
    document.body,
  );
}

/** Over a block that is not selected: a click selects it, nothing in it is touched yet. */
export function BlockShield({ onSelect }: { onSelect: () => void }) {
  return (
    <div
      className="block-shield"
      contentEditable={false}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect();
      }}
      title="Щёлкните, чтобы выбрать блок"
    />
  );
}

const SIDE_NAMES: Record<Side, string> = {
  n: 'верхний край',
  s: 'нижний край',
  e: 'правый край',
  w: 'левый край',
  ne: 'правый верхний угол',
  nw: 'левый верхний угол',
  se: 'правый нижний угол',
  sw: 'левый нижний угол',
};

/**
 * The handles of a block: the blue square moves it — a floating one freely
 * (`onMove`), one in the text to another place in it; the edges and corners
 * (`sides`) stretch a floating one.
 */
export function BlockHandles({ onMove, onStretch, sides = [] }: { onMove?: (e: React.PointerEvent) => void; onStretch?: (e: React.PointerEvent, side: Side) => void; sides?: Side[] }) {
  return (
    <>
      {onStretch &&
        sides.map((side) => (
          <span
            key={side}
            className={`block-edge ${side}`}
            contentEditable={false}
            onPointerDown={(e) => e.button === 0 && onStretch(e, side)}
            title={`Растянуть за ${SIDE_NAMES[side]}`}
          />
        ))}
      <span
        className="block-move"
        contentEditable={false}
        {...(onMove ? { onPointerDown: (e: React.PointerEvent) => e.button === 0 && onMove(e) } : { 'data-drag-handle': '', draggable: true })}
        title={onMove ? 'Перетащить по листу (или стрелками, с Shift — быстрее)' : 'Перетащить в другое место текста'}
      >
        ✥
      </span>
    </>
  );
}
