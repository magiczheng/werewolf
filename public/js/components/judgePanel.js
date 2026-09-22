// 法官面板：全场身份、夜间操作汇总、投票明细、手动结算。
import { el, esc } from '../ui.js';
import { PHASE_NAME } from '../constants.js';

// 选中的座位跨重建保留：法官每点一次「判死/复活」都会触发整页重渲染，
// 若存在组件内部状态里，选中的座位会每次跳回第一项。
let selectedSeat = '';

export function judgePanel(s, emit) {
  const j = s.judge;
  const table = el('table', { class: 'judge-table' }, [
    el('thead', {}, el('tr', {}, ['号', '昵称', '身份', '状态', '徽'].map((h) => el('th', {}, h)))),
    el('tbody', {}, j.players.filter((p) => p.name).map((p) => {
      const isWolf = p.role === 'wolf' || p.role === 'whiteWolfKing';
      return el('tr', { class: p.alive ? '' : 'dead' }, [
        el('td', { class: 'jt-seat' }, p.seat ? `${p.seat}` : '—'),
        el('td', {}, p.name ? esc(p.name) : '—'),
        el('td', {}, p.roleName ? el('span', { class: 'role-tag ' + (isWolf ? 'wolf' : 'good') }, p.roleName) : '—'),
        el('td', {}, p.alive ? el('span', { class: 'alive-tag' }, '存活') : el('span', { class: 'dead-tag' }, '出局')),
        el('td', {}, p.isSheriff ? '🛡' : ''),
      ]);
    })),
  ]);

  // ---------- 夜间/投票汇总 ----------
  const info = [];
  if (j.night) {
    const wolfVotes = Object.entries(j.night.wolfVotes || {}).map(([a, b]) => `${a}→${b}`).join(' ');
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '狼人刀口'),
      el('span', { class: 'jl-v' }, j.night.wolfTarget ? `${j.night.wolfTarget}号` : (wolfVotes || '未确认')),
    ]));
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '守卫'),
      el('span', { class: 'jl-v' }, j.night.guardTarget ? `${j.night.guardTarget}号` : '未行动'),
    ]));
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '预言家'),
      el('span', { class: 'jl-v' }, j.night.seerTarget ? `${j.night.seerTarget}号` : '未行动'),
    ]));
    const witch = [j.night.witchHeal ? `救 ${j.night.witchHeal}号` : null,
      j.night.witchPoison ? `毒 ${j.night.witchPoison}号` : null].filter(Boolean).join(' · ');
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '女巫'),
      el('span', { class: 'jl-v' }, witch || '未行动'),
    ]));
  }
  if (j.voteState) {
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '放逐票'),
      el('span', { class: 'jl-v' }, j.voteState.votes.map(([a, b]) => `${a}→${b || '弃'}`).join('  ') || '暂无'),
    ]));
  }
  if (j.sheriffState) {
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '警长票'),
      el('span', { class: 'jl-v' }, j.sheriffState.votes.map(([a, b]) => `${a}→${b || '弃'}`).join('  ') || '暂无'),
    ]));
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '警上'),
      el('span', { class: 'jl-v' }, j.sheriffState.onPodium.map((x) => `${x}号`).join('、') || '无'),
    ]));
  }

  // ---------- 操作区 ----------
  const seatSel = el('select', {
    class: 'input',
    change: (e) => { selectedSeat = e.target.value; },
  }, [
    el('option', { value: '' }, '选择座位'),
    ...j.players.filter((p) => p.name).map((p) => el('option', { value: String(p.seat) }, `${p.seat}号 ${p.name || ''}`)),
  ]);
  seatSel.value = selectedSeat; // option 已就绪，此时赋值有效

  const pick = () => Number(seatSel.value);
  const needSeat = (fn) => () => { const n = pick(); if (!n) return; fn(n); };

  const controls = [
    el('button', { class: 'btn-small', click: needSeat((seat) => emit('judge', { cmd: 'setDeath', seat, alive: true })) }, '复活'),
    el('button', { class: 'btn-small', click: needSeat((seat) => emit('judge', { cmd: 'setDeath', seat, alive: false })) }, '判死'),
    el('button', { class: 'btn-small', click: () => emit('judge', { cmd: 'endGame', camp: 'wolf' }) }, '判狼胜'),
    el('button', { class: 'btn-small', click: () => emit('judge', { cmd: 'endGame', camp: 'good' }) }, '判好人胜'),
    el('button', { class: 'btn-small', click: () => emit('restart') }, '重开一局'),
  ];

  return el('div', { class: 'col judge-wrap' }, [
    el('div', { class: 'card glass judge-panel col' }, [
      el('div', { class: 'panel-title' }, [
        '👨‍⚖️ 法官面板',
        el('span', { class: 'pill gold', style: 'margin-left:8px' }, PHASE_NAME[j.phase] || j.phase),
      ]),
      table,
      info.length ? el('div', { class: 'judge-info' }, info) : null,
    ]),
    el('div', { class: 'card glass col' }, [
      el('div', { class: 'panel-title' }, '手动干预'),
      seatSel,
      el('div', { class: 'judge-actions' }, controls),
    ]),
  ]);
}
