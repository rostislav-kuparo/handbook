import { useHandwriting } from '../engine/handwriting';
import { CHAR_GROUPS } from '../model/alphabet';
import { TARGET_VARIANTS } from './phrasePicker';

/** Russian lowercase + capitals: the alphabet the progress bar tracks. */
const TRACKED = CHAR_GROUPS.filter((g) => g.id === 'cyr-lower' || g.id === 'cyr-upper').flatMap((g) => g.chars);

/**
 * Fills to 100% when every letter has at least three written variants.
 * Each letter contributes up to three steps, so every new variant moves it.
 */
export function Progress() {
  const { byChar } = useHandwriting();
  const counts = TRACKED.map((ch) => Math.min(byChar.get(ch)?.length ?? 0, TARGET_VARIANTS));
  const done = counts.filter((c) => c >= TARGET_VARIANTS).length;
  const percent = Math.floor((counts.reduce((a, c) => a + c, 0) / (TRACKED.length * TARGET_VARIANTS)) * 100);
  const missing = TRACKED.filter((_, i) => counts[i] < TARGET_VARIANTS);
  return (
    <div
      className="progress"
      title={missing.length ? `Ещё нужны: ${missing.join(' ')}` : 'У каждой буквы есть минимум 3 варианта'}
    >
      <div className="progress-head">
        <span>
          Почерк: <b>{percent}%</b>
        </span>
        <span className="muted small">
          {done} из {TRACKED.length} букв по {TARGET_VARIANTS} варианта
        </span>
      </div>
      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <div className={`progress-fill ${percent === 100 ? 'full' : ''}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
