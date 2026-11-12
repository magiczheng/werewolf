import { el, confirmDialog } from '../ui.js';

export function targetPicker(targets, hint, onPick, opts = {}) {
  let selected = opts.selected || 0;
  let submitting = false;
  const grid = el('div', { class: 'target-grid' + (targets.length <= 9 ? ' compact' : '') });
  let listener = () => {};
  const paint = () => {
    for (const chip of grid.children) {
      const active = Number(chip.dataset.seat) === selected;
      chip.classList.toggle('selected', active);
      chip.setAttribute('aria-pressed', String(active));
    }
    listener({ selected, submitting });
  };
  let emptyButton;
  async function submit(seat, action, returnFocus) {
    if (submitting) return;
    submitting = true;
    const previous = selected; selected = seat; paint();
    grid.setAttribute('aria-busy', 'true');
    for (const chip of grid.children) { chip.disabled = true; chip.classList.toggle('is-submitting', Number(chip.dataset.seat) === seat); }
    if (emptyButton) emptyButton.disabled = true;
    listener({ selected, submitting });
    try {
      if (opts.confirm && !await confirmDialog('确认投票？', seat ? `投给 ${seat}号，提交后不可修改。` : '本轮弃票，提交后不可修改。', { danger: false, confirmText: '确认投票', returnFocus })) {
        selected = previous; return { cancelled: true };
      }
      const result = await action();
      if (result?.error || result?.cancelled) selected = previous;
      return result;
    }
    catch (_) { selected = previous; }
    finally {
      submitting = false; grid.setAttribute('aria-busy', 'false');
      for (const chip of grid.children) { chip.disabled = false; chip.classList.remove('is-submitting'); }
      if (emptyButton) emptyButton.disabled = false;
      paint();
    }
  }
  for (const t of targets) grid.appendChild(el('button', {
    class: 'target-chip', type: 'button', 'data-seat': t.seat, 'aria-label': `${t.seat}号 ${t.name}`, title: `${t.seat}号 ${t.name}`,
    click: () => submit(t.seat, () => onPick(t.seat)),
  }, [el('span', { class: 'target-avatar', 'aria-hidden': 'true' }, [...String(t.name || '')][0] || '·'), el('span', { class: 't-seat' }, `${t.seat}号`), el('span', { class: 't-name' }, t.name)]));
  paint();
  const wrap = el('div', { class: 'picker' }, [hint ? el('div', { class: 'hint picker-hint' }, hint) : null,
    targets.length ? grid : el('div', { class: 'hint muted' }, '暂无可选目标')]);
  if (opts.allowEmpty) {
    emptyButton = el('button', { class: 'btn-ghost picker-abstain', type: 'button', click: () => submit(0, () => opts.onEmpty?.()) }, opts.emptyText || '弃票');
    wrap.appendChild(emptyButton);
  }
  wrap._boardSelection = {
    targets, hint, selected,
    choose: (seat, returnFocus) => submit(seat, () => onPick(seat), returnFocus),
    subscribe(fn) { listener = fn; fn({ selected, submitting }); },
    useBoard() { grid.hidden = true; },
  };
  return wrap;
}
