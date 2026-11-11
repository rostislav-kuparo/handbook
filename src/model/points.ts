// The points of a drawing, as the user draws them: each kind of point is a
// sign of the handwriting with its variants, written like a letter.

/** The signs by GeoGebra's point style: 0 filled, 1 cross ×, 2 open circle, 3 plus +. */
export const POINT_SIGNS = ['●', '✕', '○', '✛'] as const;

export const isPointSign = (key: string) => (POINT_SIGNS as readonly string[]).includes(key);

/** The exact place of the point on the studio's sheet, font units: what is drawn around it keeps its offset. */
export const POINT_CENTER = { x: 750, y: 225 };

/** Radius of a filled point at the usual letter size, font units (an open one is 1.7 times wider, a cross 1.6). */
export const pointRadiusUnits = (weight: number) => weight * 1.1 + 50;
