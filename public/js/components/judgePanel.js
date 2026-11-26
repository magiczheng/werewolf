// 法官面板：全场身份、夜间操作汇总、投票明细、手动结算。
import { el } from '../ui.js';
import { PHASE_NAME } from '../constants.js';
import { playerLabel, seatLabel } from '../playerLabel.js';
import { seatGrid } from './seats.js';

// 选中的座位跨重建保留：法官每点一次「判死/复活」都会触发整页重渲染，
// 若存在组件内部状态里，选中的座位会每次跳回第一项。
let selectedSeat = '';

export function judgePanel(s, emit) {
  const j = s.judge;
  const label = seat => seatLabel(j.players, Number(seat));
  const roster = seatGrid(j.players.map(player => ({
    ...player, revealed: true, connected: s.players.find(p => p.seat === player.seat)?.connected,
  })), { showRole: true });
  roster.classList.add('felt-table', 'judge-roster');

  // ---------- 夜间/投票汇总 ----------
  const info = [];
  if (j.night) {
    const wolfVotes = Object.entries(j.night.wolfVotes || {}).map(([a, b]) => `${label(a)} → ${label(b)}`).join(' ');
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '狼人刀口'),
      el('span', { class: 'jl-v' }, j.night.wolfTarget ? `${label(j.night.wolfTarget)}` : (wolfVotes || '未确认')),
    ]));
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '守卫'),
      el('span', { class: 'jl-v' }, j.night.guardTarget ? `${label(j.night.guardTarget)}` : '未行动'),
    ]));
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '预言家'),
      el('span', { class: 'jl-v' }, j.night.seerTarget ? `${label(j.night.seerTarget)}` : '未行动'),
    ]));
    const witch = [j.night.witchHeal ? `救 ${label(j.night.witchHeal)}` : null,
      j.night.witchPoison ? `毒 ${label(j.night.witchPoison)}` : null].filter(Boolean).join(' · ');
    info.push(el('div', { class: 'judge-line' }, [
      el('span', { class: 'jl-k' }, '女巫'),
      el('span', { class: 'jl-v' }, witch || '未行动'),
    ]));
  }
  if (j.voteState) {
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '放逐票'),
      el('span', { class: 'jl-v' }, j.voteState.votes.map(([a, b]) => `${label(a)} → ${b ? label(b) : '弃票'}`).join('；') || '暂无'),
    ]));
  }
  if (j.sheriffState) {
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '警长票'),
      el('span', { class: 'jl-v' }, j.sheriffState.votes.map(([a, b]) => `${label(a)} → ${b ? label(b) : '弃票'}`).join('；') || '暂无'),
    ]));
    info.push(el('div', { class: 'judge-line wrap' }, [
      el('span', { class: 'jl-k' }, '警上'),
      el('span', { class: 'jl-v' }, j.sheriffState.onPodium.map((x) => `${label(x)}`).join('、') || '无'),
    ]));
  }

  // ---------- 操作区 ----------
  const seatSel = el('select', {
    class: 'input',
    change: (e) => { selectedSeat = e.target.value; },
  }, [
    el('option', { value: '' }, '选择座位'),
    ...j.players.filter((p) => p.name).map((p) => el('option', { value: String(p.seat) }, playerLabel(p))),
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
    s.gameStarted && !s.gameOver ? el('div', { class: 'card glass col' }, [
      el('div', { class: 'panel-title' }, '法官掌控本局节奏'),
      el('p', { class: 'hint' }, '确认本阶段的操作与播报已完成，再进入下一阶段。'),
      el('button', { class: 'btn-primary btn-big', type: 'button', click: () => emit('judge', { cmd: 'advance' }) }, '确认并进入下一阶段'),
    ]) : null,
    el('div', { class: 'card glass judge-panel col' }, [
      el('div', { class: 'panel-title' }, [
        '👨‍⚖️ 法官面板',
        el('span', { class: 'pill gold', style: 'margin-left:8px' }, PHASE_NAME[j.phase] || j.phase),
      ]),
      el('p', { class: 'hint' }, '仅法官可见'),
      roster,
      info.length ? el('div', { class: 'judge-info' }, info) : null,
    ]),
    el('div', { class: 'card glass col' }, [
      el('div', { class: 'panel-title' }, '手动干预'),
      seatSel,
      el('div', { class: 'judge-actions' }, controls),
    ]),
  ]);
}
