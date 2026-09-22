// 角色/规则配置表单：首页（创建房间）与大厅（房主改设置）共用。
import { el } from '../ui.js';
import { ROLE_META, ROLE_KEYS, DEFAULT_BOARDS, PLAYER_COUNTS, RULES_LABELS } from '../constants.js';

/**
 * @param {object} initial  { playerCount, judgeMode, roles, rules }
 * @param {object} opts     { showCount, showJudge, onChange }
 * @returns {{ root: HTMLElement, getConfig: () => object, set onChange(fn) }}
 */
export function buildSettingsForm(initial, opts = {}) {
  const st = {
    playerCount: initial.playerCount,
    judgeMode: !!initial.judgeMode,
    roles: { ...(initial.roles || {}) },
    rules: { ...(initial.rules || {}) },
  };
  let root = null;

  // onChange 必须可变：调用方会在构造之后再挂回调（大厅的保存按钮就依赖它），
  // 若在闭包里固定成构造时的 opts.onChange，后续赋值永远不会生效。
  let onChange = opts.onChange || (() => {});

  function isValid() {
    const total = ROLE_KEYS.reduce((a, k) => a + (st.roles[k] || 0), 0);
    const wolves = (st.roles.wolf || 0) + (st.roles.whiteWolfKing || 0);
    return total === st.playerCount && wolves >= 1 && wolves * 2 < st.playerCount;
  }

  function render() {
    const total = ROLE_KEYS.reduce((a, k) => a + (st.roles[k] || 0), 0);
    const wolves = (st.roles.wolf || 0) + (st.roles.whiteWolfKing || 0);
    const ok = isValid();

    const parts = [];

    if (opts.showCount !== false) {
      const sel = el('select', {
        class: 'input',
        change: (e) => {
          st.playerCount = Number(e.target.value);
          st.roles = { ...(DEFAULT_BOARDS[st.playerCount] || {}) };
          render();
        },
      }, PLAYER_COUNTS.map((n) => el('option', { value: n, selected: n === st.playerCount }, `${n} 人`)));
      parts.push(el('div', { class: 'field' }, [el('label', {}, '游戏人数'), sel]));
    }

    if (opts.showJudge !== false) {
      parts.push(el('div', { class: 'toggle-row' }, [
        el('div', { class: 'toggle-text' }, [
          el('span', { class: 'toggle-label' }, '法官模式'),
          el('span', { class: 'hint' }, '法官掌握全场，手动推进阶段'),
        ]),
        el('button', {
          class: 'switch' + (st.judgeMode ? ' on' : ''),
          type: 'button',
          'aria-pressed': String(st.judgeMode),
          click: () => { st.judgeMode = !st.judgeMode; render(); },
        }),
      ]));
    }

    parts.push(el('div', { class: 'panel-title' }, '角色配置'));

    const steppers = el('div', { class: 'steppers' });
    for (const key of ROLE_KEYS) {
      const m = ROLE_META[key];
      const val = st.roles[key] || 0;
      steppers.appendChild(el('div', { class: 'stepper' + (val ? ' active' : '') + (m.camp === 'wolf' ? ' wolf' : '') }, [
        el('div', { class: 'stepper-label' }, [
          el('span', { class: 'stepper-name' }, m.name),
          el('small', {}, m.sub),
        ]),
        el('div', { class: 'stepper-ctrl' }, [
          el('button', {
            class: 'step-btn', type: 'button', 'aria-label': `减少${m.name}`,
            disabled: val === 0,
            click: () => { st.roles[key] = Math.max(0, (st.roles[key] || 0) - 1); render(); },
          }, '−'),
          el('span', { class: 'stepper-val' }, String(val)),
          el('button', {
            class: 'step-btn', type: 'button', 'aria-label': `增加${m.name}`,
            click: () => { st.roles[key] = (st.roles[key] || 0) + 1; render(); },
          }, '+'),
        ]),
      ]));
    }
    parts.push(steppers);

    parts.push(el('div', { class: 'board-summary' }, [
      el('span', { class: 'pill' + (ok ? ' good' : ' bad') }, `共 ${total}/${st.playerCount} 人`),
      el('span', { class: 'pill' + (wolves >= 1 ? ' wolf' : ' bad') }, `狼 ${wolves}`),
      ok ? null : el('span', { class: 'hint bad-text' }, '配置不合法'),
    ]));

    parts.push(el('div', { class: 'panel-title' }, '规则开关'));
    for (const [key, label] of RULES_LABELS) {
      parts.push(el('div', { class: 'toggle-row' }, [
        el('span', { class: 'toggle-label small' }, label),
        el('button', {
          class: 'switch' + (st.rules[key] ? ' on' : ''),
          type: 'button',
          'aria-pressed': String(st.rules[key]),
          click: () => { st.rules[key] = !st.rules[key]; render(); },
        }),
      ]));
    }

    const form = el('div', { class: 'col' }, parts);
    if (root) root.replaceWith(form);
    root = form;
    onChange({ ok });
  }

  render();

  return {
    get root() { return root; },
    getConfig: () => JSON.parse(JSON.stringify(st)),
    get valid() { return isValid(); },
    // 必须成对提供 getter/setter：只写 setter 的话读出来是 undefined，
    // 调用方 `form.onChange(...)` 会直接抛错。
    get onChange() { return onChange; },
    set onChange(fn) { onChange = fn || (() => {}); },
  };
}
