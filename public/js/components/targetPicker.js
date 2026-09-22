// 目标选择器：夜间行动、投票、开枪等场景共用。
import { el, esc } from '../ui.js';

/**
 * @param {Array} targets  [{ seat, name }]
 * @param {string} hint    说明文案
 * @param {(seat:number)=>void} onPick
 * @param {object} opts    { selected: number, allowEmpty: bool, emptyText: string, onEmpty: fn }
 */
export function targetPicker(targets, hint, onPick, opts = {}) {
  let selected = opts.selected || 0;
  const grid = el('div', { class: 'target-grid' });

  const paint = () => {
    for (const chip of grid.children) {
      chip.classList.toggle('selected', Number(chip.dataset.seat) === selected);
    }
  };

  for (const t of targets) {
    const chip = el('div', { class: 'target-chip', 'data-seat': t.seat }, [
      el('span', { class: 't-seat' }, `${t.seat}号`),
      el('span', { class: 't-name' }, esc(t.name)),
    ]);
    chip.addEventListener('click', () => {
      selected = t.seat;
      paint();
      onPick(t.seat);
    });
    grid.appendChild(chip);
  }
  paint();

  const wrap = el('div', { class: 'picker' }, [
    hint ? el('div', { class: 'hint' }, hint) : null,
    targets.length ? grid : el('div', { class: 'hint muted' }, '暂无可选目标'),
  ]);

  if (opts.allowEmpty) {
    const btn = el('button', {
      class: 'btn-ghost',
      type: 'button',
      click: () => { selected = 0; paint(); opts.onEmpty && opts.onEmpty(); },
    }, opts.emptyText || '弃票');
    wrap.appendChild(btn);
  }

  return wrap;
}
