// 游戏页：顶部阶段条 + 底部 Tab（操作 / 板子 / 播报 / 法官）
import { el, toast, confirmDialog } from '../ui.js';
import { net, store } from '../net.js';
import { PHASE_NAME, isNightPhase } from '../constants.js';
import { seatGrid } from '../components/seats.js';
import { targetPicker } from '../components/targetPicker.js';
import { roleCard } from '../components/roleCard.js';
import { peekButton, hidePeek } from '../components/rolePeek.js';
import { newsPanel } from '../components/news.js';
import { judgePanel } from '../components/judgePanel.js';
import {
  speakNew, resetVoice, isNarrator,
  enabled as voiceOn, setEnabled as setVoice,
  supported as voiceSupported, voiceName,
} from '../speech.js';

// 模块作用域：跨重渲染保留。
// net.on 会在每次服务端推送时重跑 renderGame()，这些状态若放在函数内会被重置。
let activeTab = 'actions';
let lastPhase = '';

const emit = (event, payload) => net.emit(event, payload).catch((e) => toast(e.message, true));

// 注：本应用没有阶段倒计时，因此没有计时器心跳。
// 阶段何时结束由「当前操作人点结束」决定（见 endPhase / canEndPhase）。

// ---------- 当前玩家是否有可执行动作 ----------
// 用于「阶段切换时自动跳回操作页」：夜里狼人若正停在播报页，会错过刀人。
function hasAction(s) {
  const me = s.me;
  const priv = s.private || {};
  const p = s.phase;
  const ps = s.phaseState || {};

  if (!me.alive && !['hunterShoot', 'sheriffHandoff', 'lastWords'].includes(p)) return false;

  switch (p) {
    case 'roleReveal': return true;
    case 'nightGuard': return me.role === 'guard' && me.alive;
    case 'nightWolves': return me.isWolf && me.alive;
    case 'nightWitch': return me.role === 'witch' && me.alive;
    case 'nightSeer': return me.role === 'seer' && me.alive;
    case 'sheriffDeclare': return true;
    case 'sheriffSpeech': return !!priv.onPodium;
    case 'sheriffVote':
    case 'sheriffPk': return !!priv.sheriffCanVote;
    case 'dayTalk': return me.alive;
    case 'dayVote':
    case 'votePk': return !!priv.canVote;
    case 'lastWords':
    case 'sheriffHandoff': return ps.seat === me.seat;
    // 猎人阶段不公开座位号，只能靠私有字段判断（见 engine 的 _publicPhaseState）
    case 'hunterShoot': return !!priv.canShoot;
    default: return false;
  }
}

export function resetGameView() {
  activeTab = 'actions';
  lastPhase = '';
  // 浮层挂在 body 上，不随 #app 重建而消失，离开游戏页时必须主动收起
  hidePeek();
}

// ---------- 阶段相关的操作面板 ----------

function waitScreen(text, s) {
  return el('div', { class: 'wait-screen' }, [
    el('div', { class: 'wait-icon' }, isNightPhase(s.phase) ? '🌙' : '☀️'),
    el('div', { class: 'wait-text' }, text),
  ]);
}

/** 返回节点数组（由调用方铺进面板），避免依赖已挂载元素的子节点搬运。 */
function actionsPanel(s) {
  const me = s.me;
  const priv = s.private || {};
  const phase = s.phase;
  const aliveTargets = s.players.filter((p) => p.name && p.alive);
  const out = [];

  const section = (title, body) => {
    out.push(el('div', { class: 'card glass col action-card' }, [
      el('div', { class: 'panel-title' }, title),
      body || null,
    ]));
  };

  const waiting = (text) => out.push(el('div', { class: 'card glass' }, waitScreen(text, s)));

  // 「结束本阶段」按钮：只有当前操作人看得到（引擎判定，见 canEndPhase）。
  // 没有倒计时之后，这是主要的推进方式，所以做得显眼且始终在操作区底部。
  const endButton = (label) => out.push(el('button', {
    class: 'btn-primary btn-big end-phase-btn', type: 'button',
    click: () => emit('endPhase'),
  }, label));

  // 预言家：本夜的查验结果常驻显示。
  // 验完会自动进入下一阶段，操作面板整块重建——不常驻的话结果一闪就没了，
  // 白天讨论时根本想不起来验了谁。
  if (priv.seerResult && phase !== 'nightSeer') {
    out.push(el('div', { class: 'card glass col' }, [
      el('div', { class: 'panel-title' }, '本夜查验'),
      el('div', { class: 'seer-result ' + priv.seerResult.camp }, [
        el('span', { class: 'sr-seat' }, `${priv.seerResult.seat}号`),
        el('span', { class: 'sr-camp' }, priv.seerResult.camp === 'wolf' ? '狼人' : '好人'),
      ]),
    ]));
  }

  // 自爆：狼人在白天各阶段都能用（含投票阶段——此时投票会作废）。
  // 不可逆，所以一律走二次确认，避免白天手滑点掉。
  if (priv.canBlast) {
    const body = el('div', { class: 'col' }, [
      el('div', { class: 'hint' }, priv.blastTakesVictim
        ? '白狼王自爆：亮明身份出局，并带走一名玩家；当天白天立刻结束'
        : '自爆后你立即出局（亮明身份、没有遗言），当天白天立刻结束进入黑夜，也不能参与当晚刀人'),
    ]);

    if (priv.blastTakesVictim) {
      body.appendChild(targetPicker(
        aliveTargets.filter((t) => t.seat !== me.seat),
        '选择要带走的人',
        async (seat) => {
          const yes = await confirmDialog('确认自爆？',
            `自爆并带走 ${seat}号，当天白天立刻结束。此操作不可撤销。`, { confirmText: '自爆' });
          if (yes) emit('blast', { target: seat });
        },
      ));
    } else {
      body.appendChild(el('button', {
        class: 'btn-danger btn-big', type: 'button',
        click: async () => {
          const yes = await confirmDialog('确认自爆？',
            '自爆后你立即出局（亮明身份、没有遗言），当天白天立刻结束进入黑夜，且不能参与当晚刀人。此操作不可撤销。',
            { confirmText: '自爆' });
          if (yes) emit('blast', {});
        },
      }, '💣 自爆'));
    }

    out.push(el('div', { class: 'card glass col blast-box' }, [
      el('div', { class: 'panel-title' }, '💣 狼人自爆'),
      body,
    ]));
  }

  // 出局玩家通常只剩观战，但**房主出局后仍要能主持天亮播报与白天发言**——
  // 那两个阶段没有别的操作人，拦掉的话房主就彻底失去推进手段了。
  if (!me.alive && !priv.canEndPhase
      && !['hunterShoot', 'sheriffHandoff', 'lastWords'].includes(phase)) {
    waiting('你已出局，观战中…');
    return out;
  }

  switch (phase) {
    case 'roleReveal': {
      // 进度取自服务端的 roleConfirm（真实确认人数）。
      // 注意不要用「已入座人数」冒充——满员时会立刻显示全员已确认，是假的。
      const rc = s.roleConfirm || { ready: 0, total: s.players.filter((p) => p.name).length };
      const pct = rc.total ? Math.round((rc.ready / rc.total) * 100) : 0;
      const allReady = rc.ready >= rc.total;

      section('确认身份', el('div', { class: 'col' }, [
        el('div', { class: 'hint' }, '记住你的身份，别让旁边的人看到这块屏幕'),
        el('div', { class: 'confirm-bar' }, [
          el('div', { class: 'confirm-bar-fill', style: `width:${pct}%` }),
        ]),
        el('div', { class: 'hint' + (allReady ? ' good-text' : '') }, allReady
          ? '所有人都已确认，即将进入夜晚'
          : `${rc.ready}/${rc.total} 人已确认，等待其他人…`),
      ]));

      out.push(el('button', {
        class: 'btn-primary btn-big' + (me.roleReady ? ' done' : ''), type: 'button',
        disabled: !!me.roleReady, click: () => emit('confirmRole'),
      }, me.roleReady ? '已确认身份 ✓' : '我已记住身份'));
      break;
    }

    case 'nightGuard':
      if (me.role === 'guard' && me.alive) {
        section('选择今晚守护的目标', targetPicker(
          aliveTargets.filter((t) => t.seat !== priv.guardLastTarget),
          priv.guardLastTarget ? `不能连续两晚守护同一人（昨晚守了 ${priv.guardLastTarget}号）` : '守护可挡下狼刀',
          (seat) => emit('nightAction', { type: 'guardProtect', target: seat }),
        ));
        if (priv.canEndPhase) endButton('结束本阶段');
      } else waiting('等待守卫结束…');
      break;

    case 'nightWolves': {
      if (me.isWolf && me.alive) {
        const tally = priv.wolfTally || [];
        const body = el('div', { class: 'col' });

        // 票型：只有狼队自己看得到
        if (tally.length) {
          body.appendChild(el('div', { class: 'wolf-tally' }, tally.map(([seat, n]) => el('span', {
            class: 'wolf-tally-item'
              + (n >= (priv.wolfNeed || 99) ? ' passed' : '')
              + (priv.wolfVote === seat ? ' mine' : ''),
          }, `${seat}号 ${n}票`))));
        }

        if (priv.wolfRevote) {
          body.appendChild(el('div', { class: 'hint bad-text' }, '上一轮没有多数票，已清空，请重新选择'));
        }

        // 狼人阶段是自动推进的：全员投完且有人过半就直接进入下一阶段
        body.appendChild(el('div', { class: 'hint' }, `已选择 ${priv.wolfConfirmed || '0/0'} · 过半需 ${priv.wolfNeed || '?'} 票，全员投完即自动进入下一阶段`));

        body.appendChild(targetPicker(
          aliveTargets.filter((t) => t.seat !== me.seat && !me.wolfTeammates.includes(t.seat)),
          '',
          (seat) => emit('nightAction', { type: 'wolfKill', target: seat }),
          { selected: priv.wolfVote || 0 },
        ));

        section('狼人投票 · 选择今晚杀害的目标', body);
        if (priv.canEndPhase) endButton('结束本阶段');
      } else waiting('等待狼人结束…');
      break;
    }

    case 'nightWitch': {
      if (me.role === 'witch' && me.alive) {
        const w = priv.witch || {};
        const body = el('div', { class: 'col' });
        body.appendChild(el('div', { class: 'hint ' + (w.killTarget ? 'bad-text' : '') },
          w.killTarget ? `今夜 ${w.killTarget}号 被狼人杀害` : '今夜无人被刀'));

        if (w.healLeft && w.killTarget) {
          body.appendChild(el('button', {
            class: 'btn-primary', type: 'button',
            click: () => emit('nightAction', { type: 'witchAct', kind: 'heal', target: w.killTarget }),
          }, `使用解药救 ${w.killTarget}号`));
        } else if (w.healLeft) {
          body.appendChild(el('div', { class: 'hint muted' }, '解药今夜无法使用'));
        } else {
          body.appendChild(el('div', { class: 'hint muted' }, '解药已用完'));
        }

        if (w.poisonLeft) {
          body.appendChild(el('div', { class: 'panel-title', style: 'margin-top:6px' }, '使用毒药（与解药只能二选一）'));
          body.appendChild(targetPicker(
            aliveTargets.filter((t) => t.seat !== me.seat), '',
            (seat) => emit('nightAction', { type: 'witchAct', kind: 'poison', target: seat }),
          ));
        } else {
          body.appendChild(el('div', { class: 'hint muted' }, '毒药已用完'));
        }
        section('女巫行动', body);
        if (priv.canEndPhase) endButton('结束本阶段');
      } else waiting('等待女巫结束…');
      break;
    }

    case 'nightSeer': {
      if (me.role === 'seer' && me.alive) {
        const history = priv.seerHistory || [];
        const checked = new Set(history.map((h) => h.seat));
        const body = el('div', { class: 'col' });

        if (priv.seerResult) {
          // 今夜的结果直接摊在卡片上。不用 toast：toast 两秒就没了，
          // 玩家还得再按住「身份」去翻记录，夜里摸黑操作很容易看漏。
          const r = priv.seerResult;
          // 只靠左侧那条细边区分阵营，不做大面积配色
          body.appendChild(el('div', { class: 'seer-result ' + r.camp }, [
            el('span', { class: 'sr-seat' }, `${r.seat}号`),
            el('span', { class: 'sr-camp' }, r.camp === 'wolf' ? '狼人' : '好人'),
          ]));
          body.appendChild(el('div', { class: 'hint' }, '今晚已查验，可以点「结束本阶段」'));
        } else {
          body.appendChild(targetPicker(
            aliveTargets.filter((t) => t.seat !== me.seat && !checked.has(t.seat)),
            checked.size ? '已查验过的人不会再出现在这里（同一人不能重复查验）' : '每晚只能查验一人',
            (seat) => emit('nightAction', { type: 'seerCheck', target: seat }),
          ));
        }

        // 历次查验记录：身份是翻开的，一屏看完不用回忆
        if (history.length) {
          body.appendChild(el('div', { class: 'panel-title', style: 'margin-top:10px' }, '已查验'));
          body.appendChild(el('div', { class: 'seer-history' }, history.map((h) => el('span', {
            class: 'seer-chip',
          }, [
            el('span', { class: 'sc-seat' }, `${h.seat}号`),
            el('span', { class: 'sc-camp' }, h.camp === 'wolf' ? '狼人' : '好人'),
          ]))));
        }

        section('预言家查验', body);
        if (priv.canEndPhase) endButton('结束本阶段');
      } else waiting('等待预言家查验…');
      break;
    }

    case 'dayStart':
      waiting('天亮了，请查看播报');
      if (priv.canEndPhase) endButton('进入下一步');
      break;

    case 'sheriffDeclare':
      section('是否参加警长竞选', el('div', { class: 'col' }, [
        el('div', { class: 'hint' }, priv.onPodium ? '你已上警' : (priv.withdrawn ? '你已在警下' : '上警后需要发言，警下玩家投票选你')),
        el('button', {
          class: 'btn-primary', type: 'button',
          click: () => emit('declare', { onPodium: true }),
        }, priv.onPodium ? '保持上警' : '上警（参加竞选）'),
        el('button', {
          class: 'btn-ghost', type: 'button',
          click: () => emit('declare', { onPodium: false }),
        }, '警下（不竞选）'),
      ]));
      break;

    case 'sheriffSpeech': {
      const candidates = s.phaseState.candidates || [];
      section('警长竞选 · 发言', el('div', { class: 'col' }, [
        el('div', { class: 'speaker-line' }, [
          el('span', { class: 'speaker-seat' }, `${s.phaseState.speakerSeat}号`),
          el('span', {}, '正在发言'),
        ]),
        el('div', { class: 'hint' }, `警上候选人：${candidates.map((c) => `${c}号`).join('、')}`),
        priv.onPodium
          ? el('button', { class: 'btn-danger', type: 'button', click: () => emit('declare', { onPodium: false }) }, '退水（放弃竞选）')
          : el('div', { class: 'hint muted' }, '等待候选人发言…'),
      ]));
      if (priv.canEndPhase) endButton('结束发言');
      break;
    }

    case 'sheriffVote':
    case 'sheriffPk': {
      const isPk = phase === 'sheriffPk';
      const cands = isPk ? (s.phaseState.pkCandidates || []) : (s.phaseState.candidates || []);
      const candPlayers = s.players.filter((p) => cands.includes(p.seat) && p.name);
      if (priv.sheriffCanVote) {
        if (priv.sheriffHasVoted) {
          // 一经投出不可修改：只回显结果，不再给选择器
          section(isPk ? '平票PK · 已投票' : '已投票', el('div', { class: 'col' }, [
            el('div', { class: 'voted-lock' }, priv.sheriffMyVote
              ? `你已投给 ${priv.sheriffMyVote}号`
              : '你已弃票'),
            el('div', { class: 'hint muted' }, '投票不可修改，等待其他人…'),
          ]));
        } else {
          section(isPk ? '平票PK · 重新投票' : '投票选警长', targetPicker(
            candPlayers.filter((c) => c.seat !== me.seat),  // 不能投给自己
            isPk ? '仍平票则警徽流失' : '警长拥有 1.5 票 · 投出后不可修改',
            (seat) => emit('sheriffVote', { target: seat }),
            { allowEmpty: true, emptyText: '弃票', onEmpty: () => emit('sheriffVote', { target: 0 }) },
          ));
        }
      } else {
        waiting('等待警下玩家投票…');
      }
      break;
    }

    case 'dayTalk':
      section('白天发言', el('div', { class: 'col' }, [
        el('div', { class: 'hint' }, '在场内自由讨论，讨论完由房主点「进入放逐投票」'),
      ]));
      if (priv.canEndPhase) endButton('进入放逐投票');
      break;

    case 'dayVote':
    case 'votePk': {
      const isPk = phase === 'votePk';
      const pkCands = isPk ? (s.phaseState.pkCandidates || []) : [];
      const targets = isPk
        ? s.players.filter((p) => pkCands.includes(p.seat) && p.name)
        : aliveTargets;
      if (priv.canVote) {
        if (priv.hasVoted) {
          // 一经投出不可修改：只回显结果，不再给选择器
          section(isPk ? '放逐PK · 已投票' : '已投票', el('div', { class: 'col' }, [
            el('div', { class: 'voted-lock' }, priv.myVote ? `你已投给 ${priv.myVote}号` : '你已弃票'),
            el('div', { class: 'hint muted' }, '投票不可修改，等待其他人…'),
          ]));
        } else {
          section(isPk ? '放逐PK · 重新投票' : '放逐投票', targetPicker(
            // 不能投给自己（服务端也会拒绝，这里不给出这个选项）
            targets.filter((p) => p.seat !== me.seat),
            isPk
              ? `平票候选人：${pkCands.map((c) => `${c}号`).join('、')}（仍平票则平安日）`
              : '票数最高者被放逐，平票会进入 PK · 投出后不可修改',
            (seat) => emit('exileVote', { target: seat }),
            {
              allowEmpty: true,
              emptyText: '弃票',
              onEmpty: () => emit('exileVote', { target: 0 }),
            },
          ));
        }
      } else {
        waiting(me.idiotFlipped ? '你已翻牌，失去投票权' : '等待投票…');
      }
      break;
    }

    case 'lastWords':
      // 线下游戏：遗言是当场说出来的，App 只负责控制节奏。
      // 说完了点「结束发言」，流程自动推进到下一位 / 下一阶段。
      if (s.phaseState.seat === me.seat) {
        section('发表遗言', el('div', { class: 'col' }, [
          el('div', { class: 'lastwords-icon' }, '🕯'),
          el('div', { class: 'hint' }, '请在场内说出你的遗言，说完点下面的按钮'),
        ]));
        endButton('结束发言');
      } else {
        waiting(`${s.phaseState.seat}号 正在发表遗言…`);
      }
      break;

    case 'hunterShoot':
      // 用私有的 canShoot 判断，而不是 phaseState.seat ——
      // 后者对全场公开，等于告诉大家「刚才死的那个人是猎人」
      if (priv.canShoot) {
        section('猎人开枪', targetPicker(
          aliveTargets.filter((t) => t.seat !== me.seat), '带走一个人，或放弃开枪',
          (seat) => emit('shoot', { target: seat }),
          { allowEmpty: true, emptyText: '放弃开枪', onEmpty: () => emit('shoot', { target: 0 }) },
        ));
      } else {
        waiting('猎人正在抉择…');
      }
      break;

    case 'sheriffHandoff':
      if (s.phaseState.seat === me.seat) {
        section('警徽移交', el('div', { class: 'col' }, [
          targetPicker(aliveTargets, '把警徽交给谁？', (seat) => emit('handoff', { mode: 'pass', target: seat })),
          el('button', { class: 'btn-danger', type: 'button', click: () => emit('handoff', { mode: 'tear' }) }, '撕警徽（无人继承）'),
        ]));
      } else {
        out.push(el('div', { class: 'card glass' }, waitScreen('正在处理警徽…', s)));
      }
      break;

    case 'gameOver':
      out.push(el('div', { class: 'card glass' }, waitScreen('本局已结束', s)));
      break;

    default:
      out.push(el('div', { class: 'card glass' }, waitScreen('…', s)));
  }

  if (out.length === 0) out.push(el('div', { class: 'card glass' }, waitScreen('…', s)));
  return out;
}

// ---------- 结算 ----------
function gameOverCard(s) {
  const isWolf = s.gameOver.winners === 'wolf';

  // 退出房间：清掉本机记录并回主界面。大厅里也有同样的入口，这里是结算页的出口。
  const leaveRoom = async () => {
    const yes = await confirmDialog('退出房间？',
      '退出后需要重新输入房间号才能回来。',
      { confirmText: '退出' });
    if (!yes) return;
    try {
      await net.emit('leaveRoom');
      store.remove('ww_last_room');
      net.clear();
    } catch (e) { toast(e.message, true); }
  };

  return el('div', { class: 'card glass gameover ' + (isWolf ? 'wolf' : 'good') }, [
    el('div', { class: 'go-icon' }, isWolf ? '🐺' : '🎉'),
    el('div', { class: 'go-camp' }, isWolf ? '狼人阵营获胜' : '好人阵营获胜'),
    el('div', { class: 'hint' }, '下方座位已揭示所有身份'),
    s.me.isHost
      ? el('button', {
        class: 'btn-primary btn-big', type: 'button',
        click: () => net.emit('restart').catch((e) => toast(e.message, true)),
      }, '回到房间，再来一局')
      : el('div', { class: 'hint' }, '等待房主回到房间开启下一局'),
    el('div', { class: 'hint' }, '回到房间后座位会清空，大家重新选座'),
    el('button', { class: 'btn-ghost btn-big', type: 'button', click: leaveRoom }, '退出房间'),
  ]);
}

// ---------- 主渲染 ----------

export function renderGame(root) {
  const s = net.state;
  const me = s.me;
  const phase = s.phase;

  const phaseChanged = phase !== lastPhase;
  if (phaseChanged) {
    lastPhase = phase;
    window.scrollTo(0, 0);
    // 阶段变了、且当前玩家有事可做（要操作，或该由他点结束）→ 拉回操作页。
    // 否则夜里轮到他行动时，人还停在播报页，整局就卡住了。
    if (hasAction(s) || (s.private && s.private.canEndPhase)) activeTab = 'actions';
    // 阶段变了，手上可能还按着身份牌浮层——收起，避免上面的信息已经过期
    hidePeek();
  }

  const tabs = [
    { id: 'actions', label: '操作', icon: '🎯', badge: hasAction(s) },
    { id: 'board', label: '板子', icon: '🪑' },
    { id: 'news', label: '播报', icon: '📢', badge: !!(s.news && s.news.length) },
  ];
  // 必须用 me.isJudge 判断，不能用 s.judge：
  // 法官模式下非法官玩家的 s.judge 是 {name, connected}（没有 players），
  // 拿它当开关会把普通玩家送进法官面板并因 j.players 未定义而整页崩掉。
  const isJudge = !!(me.isJudge && s.judge && s.judge.players);
  if (isJudge) tabs.push({ id: 'judge', label: '法官', icon: '👨‍⚖️' });
  if (!tabs.some((t) => t.id === activeTab)) activeTab = 'actions'; // 法官模式关闭时回落到操作页

  // ---------- 顶栏 ----------
  // 没有倒计时，右侧改为显示「本阶段在等谁」：确认进度 / 等待法官 / 等待某人结束。
  const priv = s.private || {};
  let gtRight;
  if (s.roleConfirm) {
    const { ready, total } = s.roleConfirm;
    gtRight = el('div', { class: 'confirm-progress' }, [
      el('span', { class: 'cp-count' }, `${ready}/${total}`),
      el('span', { class: 'cp-label' }, ready >= total ? '已就绪' : '已确认'),
    ]);
  } else if (s.gameOver) {
    gtRight = el('span', { class: 'gt-waiting' }, '已结束');
  } else if (s.judgeMode) {
    gtRight = el('span', { class: 'gt-waiting' }, '等待法官推进');
  } else if (!priv.canEndPhase && !hasAction(s)) {
    // 既不能结束、也没有动作可做 —— 说明在等别人
    gtRight = el('span', { class: 'gt-waiting' }, '等待中');
  } else {
    gtRight = null;
  }

  const topbar = el('div', { class: 'game-topbar glass' }, [
    el('div', { class: 'gt-left' }, [
      el('span', { class: 'gt-phase' }, `${isNightPhase(phase) ? '🌙' : '☀️'} ${PHASE_NAME[phase] || phase}`),
      el('span', { class: 'gt-day' }, `第 ${s.day} 天${s.sheriff ? ` · 警长 ${s.sheriff}号` : ''}`),
    ]),
    el('div', { class: 'gt-right' }, [
      // 开局确认身份时身份牌就在正文里，这里不必再放按钮
      phase === 'roleReveal' ? null : peekButton(s),
      gtRight,
    ]),
  ]);

  // ---------- 各 Tab 面板（全部保留在 DOM 中，非激活的隐藏） ----------
  // 各 Tab 面板全部保留在 DOM 中，非激活的用 hidden 隐藏而非卸载，
  // 这样切回来时不需要重新请求数据，滚动位置也更容易保持。
  const panels = {
    actions: el('div', { class: 'col' }, [
      s.gameOver ? gameOverCard(s) : null,
      // 身份牌只在确认身份阶段内联展示。开局后一律收起，改用顶栏的「按住查看」——
      // 桌上一直摊着一张写着「狼人」的卡片，隔桌就能看见。
      phase === 'roleReveal' ? roleCard(s) : null,
      // 房主专属的「跳过本阶段」已移除：每个阶段都由它自己的操作人来推进，
      // 房主的权力体现在「天亮播报 / 白天发言」这两个由他结束的阶段上。
      ...actionsPanel(s),
    ]),
    board: el('div', { class: 'col' }, [
      el('div', { class: 'card glass col' }, [
        el('div', { class: 'panel-title' }, [
          '座位状态',
          el('span', { class: 'pill', style: 'margin-left:8px' },
            `${s.players.filter((p) => p.name && p.alive).length} 存活 / ${s.players.filter((p) => p.name).length} 人`),
        ]),
        seatGrid(s.players, { me, showRole: true }),
      ]),
    ]),
    news: el('div', { class: 'col' }, [
      el('div', { class: 'card glass col' }, [
        el('div', { class: 'panel-title' }, [
          '战况播报',
          // 语音开关只在解说员设备（房主 / 法官）上出现——别的设备根本不朗读，给了也是误导
          (voiceSupported() && isNarrator(s)) ? voiceToggle(s) : null,
        ]),
        newsPanel(s),
      ]),
    ]),
  };
  if (isJudge) panels.judge = judgePanel(s, emit);

  const panelWrap = el('div', { class: 'tab-panels' }, tabs.map((t) => {
    const node = panels[t.id];
    node.classList.add('tab-panel');
    node.dataset.panel = t.id;
    if (t.id !== activeTab) node.hidden = true;
    return node;
  }));

  // ---------- 底部 Tab 栏 ----------
  const tabbar = el('nav', { class: 'tabbar glass' }, tabs.map((t) => el('button', {
    class: 'tabbar-item' + (t.id === activeTab ? ' active' : ''),
    type: 'button',
    click: () => {
      activeTab = t.id;
      for (const p of panelWrap.children) p.hidden = p.dataset.panel !== t.id;
      for (const b of tabbar.children) b.classList.toggle('active', b.dataset.tab === t.id);
    },
    'data-tab': t.id,
  }, [
    el('span', { class: 'tb-icon' }, t.icon),
    el('span', { class: 'tb-label' }, t.label),
    t.badge ? el('span', { class: 'tb-badge' }) : null,
  ])));

  root.appendChild(el('div', { class: 'view game-view' }, [topbar, panelWrap, tabbar]));

  // 念出新播报。只有解说员设备会真的出声，其余设备只静默推进游标
  // （否则它们之后万一成了解说员，会把攒下的播报一股脑念出来）。
  speakNew(s, s.news);
}

/** 语音播报开关（只在解说员设备上渲染）。 */
function voiceToggle(s) {
  const paint = (btn) => {
    const on = voiceOn();
    btn.textContent = on ? '🔊 朗读中' : '🔇 已静音';
    btn.classList.toggle('on', on);
    btn.title = on
      ? `本机正在朗读播报（音色：${voiceName()}）· 点击静音`
      : '本机已静音 · 点击开启朗读';
  };
  const btn = el('button', {
    class: 'voice-toggle', type: 'button',
    click: () => {
      setVoice(!voiceOn());   // 立即生效，不需要等服务端
      paint(btn);
    },
  });
  paint(btn);
  return btn;
}
