import { ROLE_LIMITS } from '../gameRules.js';
import { roleArt } from './roleArt.js';
import { el } from '../ui.js';
import { ROLE_META, ROLE_KEYS, DEFAULT_BOARDS, PLAYER_COUNTS, RULES_LABELS } from '../constants.js';

export function buildSettingsForm(initial, opts = {}) {
  const st = { playerCount: initial.playerCount, judgeMode: !!initial.judgeMode,
    roles: { ...(initial.roles || {}) }, rules: { ...(initial.rules || {}) } };
  let root = null;
  let rolesOpen = false;
  let rulesOpen = false;
  let onChange = opts.onChange || (() => {});
  const valid = () => {
    const total = ROLE_KEYS.reduce((n, k) => n + (st.roles[k] || 0), 0);
    const wolves = (st.roles.wolf || 0) + (st.roles.whiteWolfKing || 0);
    return total === st.playerCount && wolves >= 1 && wolves * 2 < total
      && ROLE_KEYS.every(k => Number.isInteger(st.roles[k] || 0) && (st.roles[k] || 0) >= 0 && (st.roles[k] || 0) <= ROLE_LIMITS[k]);
  };
  function render() {
    const focusLabel = document.activeElement?.getAttribute('aria-label');
    const total = ROLE_KEYS.reduce((n, k) => n + (st.roles[k] || 0), 0);
    const wolves = (st.roles.wolf || 0) + (st.roles.whiteWolfKing || 0);
    const villagers = st.roles.villager || 0;
    const ok = valid();
    const parts = [];
    if (opts.showCount !== false) {
      parts.push(el('div', { class: 'field' }, [
        el('label', {}, '选一个常用板子'),
        el('div', { class: 'preset-row', 'aria-label': '常用板子' }, [9, 10, 12, 16].map(n => el('button', {
          class: 'preset-btn' + (st.playerCount === n ? ' active' : ''), type: 'button', 'aria-label': `${n} 人经典`, 'aria-pressed': String(st.playerCount === n),
          click: () => { st.playerCount = n; st.roles = { ...DEFAULT_BOARDS[n] }; render(); },
        }, [el('span', { class: 'preset-count' }, String(n)), el('span', { class: 'preset-caption' }, '人经典')]))),
      ]));
      parts.push(el('div', { class: 'setup-options' }, [
        el('div', { class: 'field' }, [el('label', { for: 'player-count' }, '游戏人数'), el('select', {
          class: 'input', id: 'player-count', change: e => { st.playerCount = Number(e.target.value); st.roles = { ...DEFAULT_BOARDS[st.playerCount] }; render(); },
        }, PLAYER_COUNTS.map(n => el('option', { value: n, selected: n === st.playerCount }, `${n} 人`)))]),
        opts.showJudge === false ? null : el('div', { class: 'mode-option' }, [
          el('div', { class: 'toggle-text' }, [el('span', { class: 'toggle-label' }, '法官模式'), el('span', { class: 'hint' }, st.judgeMode ? '法官手动推进' : '玩家操作后自动推进')]),
          el('button', { class: 'switch' + (st.judgeMode ? ' on' : ''), type: 'button', 'aria-pressed': String(st.judgeMode), 'aria-label': '法官模式', click: () => { st.judgeMode = !st.judgeMode; render(); } }),
        ]),
      ]));
    }
    const activeRoles = ROLE_KEYS.filter(k => st.roles[k] > 0);
    parts.push(el('section', { class: 'board-preview-wrap', 'aria-label': '当前角色板子' }, [
      el('div', { class: 'spread' }, [el('span', { class: 'panel-title' }, '今晚的角色'), el('span', { class: 'hint' }, `${wolves} 狼 · ${total - wolves - villagers} 神 · ${villagers} 民`)]),
      el('div', { class: 'board-preview' }, activeRoles.map(key => el('div', { class: 'role-preview', title: ROLE_META[key].name }, [
        roleArt(key, { className: 'role-preview-art' }),
        el('span', { class: 'role-preview-count' }, `×${st.roles[key]}`),
        el('span', { class: 'role-preview-name' }, ROLE_META[key].name),
      ]))),
    ]));
    const steppers = el('div', { class: 'steppers' }, ROLE_KEYS.map(key => {
      const m = ROLE_META[key]; const val = st.roles[key] || 0;
      return el('div', { class: 'stepper role-option' + (val ? ' active' : '') + (m.camp === 'wolf' ? ' wolf' : '') }, [
        roleArt(key, { className: 'role-option-art', full: true }),
        el('div', { class: 'stepper-label' }, [el('span', { class: 'stepper-name' }, m.name), el('small', {}, m.sub)]),
        el('div', { class: 'stepper-ctrl' }, [
          el('button', { class: 'step-btn', type: 'button', 'aria-label': `减少${m.name}`, disabled: val === 0, click: () => { st.roles[key] = Math.max(0, val - 1); render(); } }, '−'),
          el('span', { class: 'stepper-val' }, String(val)),
          el('button', { class: 'step-btn', type: 'button', 'aria-label': `增加${m.name}`, disabled: val >= ROLE_LIMITS[key], click: () => { st.roles[key] = val + 1; render(); } }, '+'),
        ]),
      ]);
    }));
    parts.push(el('details', { class: 'setup-disclosure roles-disclosure', open: rolesOpen, toggle: e => { rolesOpen = e.target.open; } }, [
      el('summary', {}, [el('span', { class: 'disclosure-icon' }, '◇'), el('span', { class: 'disclosure-title' }, '自定义角色配置'), el('span', { class: 'disclosure-meta' }, '按需调整'), el('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄')]),
      el('div', { class: 'disclosure-body col' }, [
        el('a', { class: 'role-catalog-link', href: '/roles.html', target: '_blank', rel: 'noopener' }, '查看完整角色图鉴 ↗'), steppers,
      ]),
    ]));
    parts.push(el('div', { class: 'board-summary' }, [el('span', { class: 'pill' + (ok ? ' good' : ' bad') }, `共 ${total}/${st.playerCount} 人`),
      ok ? el('span', { class: 'hint' }, '板子已就绪，可以创建房间') : el('span', { class: 'hint bad-text', role: 'status' }, '请使角色总数与人数一致，狼人需少于好人，特殊角色最多一名'),
    ]));
    parts.push(el('details', { class: 'setup-disclosure rules-disclosure', open: rulesOpen, toggle: e => { rulesOpen = e.target.open; } }, [
      el('summary', {}, [el('span', { class: 'disclosure-icon' }, '≋'), el('span', { class: 'disclosure-title' }, '进阶规则'), el('span', { class: 'disclosure-meta' }, `${RULES_LABELS.filter(([k]) => st.rules[k]).length} 项开启`), el('span', { class: 'disclosure-chevron', 'aria-hidden': 'true' }, '⌄')]),
      el('div', { class: 'disclosure-body col' }, RULES_LABELS.map(([key, label]) => el('div', { class: 'toggle-row' }, [
        el('span', { class: 'toggle-label small' }, label), el('button', { class: 'switch' + (st.rules[key] ? ' on' : ''), type: 'button', 'aria-pressed': String(st.rules[key]), 'aria-label': label, click: () => { st.rules[key] = !st.rules[key]; render(); } }),
      ]))),
    ]));
    const form = el('div', { class: 'col settings-form' }, parts);
    if (root) root.replaceWith(form);
    root = form;
    if (focusLabel) requestAnimationFrame(() => {
      const button = [...(form.querySelectorAll?.('[aria-label]') || [])].find(n => n.getAttribute('aria-label') === focusLabel);
      if (button && !button.disabled) button.focus?.({ preventScroll: true });
    });
    onChange({ ok, total, wolves, villagers, gods: total - wolves - villagers });
  }
  render();
  return { get root() { return root; }, getConfig: () => JSON.parse(JSON.stringify(st)), get valid() { return valid(); }, get onChange() { return onChange; }, set onChange(fn) { onChange = fn || (() => {}); } };
}
