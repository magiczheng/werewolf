// 前端渲染回归：在极简 DOM 垫片上真实执行全部视图与阶段分支。
//
// 目的不是检查样式，而是保证「页面能渲染出来而不抛错」——
// 前端一旦抛错，用户看到的是整片白屏，且没有任何提示。
// 覆盖：登录 / 首页 / 大厅 / 游戏页全部 18 个阶段 × 多种角色视角 / 法官面板。
//
// 注意：本文件必须在设置好全局 DOM 之后才能 import 前端模块，故全部用动态 import。

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

const { installDom } = await import('./helpers/dom.js');

let env, net, app, constants;

before(async () => {
  env = installDom();
  net = (await import('../public/js/net.js')).net;
  app = (await import('../public/js/app.js')).app;
  constants = await import('../public/js/constants.js');
  net.connect();
  // 与 main.js 保持一致：状态推送 → 重新渲染
  net.on(() => app.render());
});

// ---------- 伪造引擎快照 ----------

const PLAYER_COUNT = 8;

// 阶段清单在这里内联：describe 的函数体在「收集阶段」就会执行，
// 早于 before() 里的异步 import，届时 constants 还是 undefined。
// 下面有一个测试专门断言这份清单与 constants.PHASE_NAME 保持一致。
const ALL_PHASES = [
  'roleReveal',
  'nightGuard', 'nightWolves', 'nightWitch', 'nightSeer',
  'dayStart',
  'sheriffDeclare', 'sheriffSpeech', 'sheriffVote', 'sheriffPk',
  'dayTalk', 'dayVote', 'votePk',
  'lastWords', 'hunterShoot', 'sheriffHandoff',
  'gameOver',
];

function players(overrides = {}) {
  const roles = ['wolf', 'wolf', 'seer', 'witch', 'hunter', 'villager', 'villager', 'villager'];
  return Array.from({ length: PLAYER_COUNT }, (_, i) => {
    const seat = i + 1;
    const o = overrides[seat] || {};
    return {
      seat,
      name: `玩家${seat}`,
      alive: true,
      connected: true,
      isSheriff: false,
      revealed: false,
      role: null,
      roleName: null,
      idiotFlipped: false,
      _role: roles[i],
      ...o,
    };
  });
}

function meFor(roleKey, extra = {}) {
  const ROLE_NAMES = { wolf: '狼人', seer: '预言家', witch: '女巫', hunter: '猎人', guard: '守卫', villager: '村民', idiot: '白痴', whiteWolfKing: '白狼王' };
  return {
    playerId: 'p1', name: '玩家1', seat: 1, alive: true,
    role: roleKey, roleName: ROLE_NAMES[roleKey] || roleKey, roleDesc: '角色说明',
    isWolf: roleKey === 'wolf' || roleKey === 'whiteWolfKing',
    wolfTeammates: roleKey === 'wolf' ? [2] : [],
    isJudge: false, isHost: true, idiotFlipped: false, connected: true,
    roleReady: false,
    ...extra,
  };
}

function privateFor(extra = {}) {
  return {
    roleReady: false, canBlast: false, blastTakesVictim: false,
    seerHistory: [], seerResult: null, guardLastTarget: null,
    canShoot: false,
    witch: null, onPodium: false, withdrawn: false, canDeclare: true,
    sheriffCanVote: false, hasVoted: false, myVote: 0, canVote: false,
    lastWordsWritten: false, nightPhase: null, wolfConfirmed: '0/2', wolfUnanimous: false,
    ...extra,
  };
}

function makeState(o = {}) {
  const pls = o.players || players();
  return {
    roomCode: 'ABC123',
    judgeMode: false,
    gameStarted: true,
    gameOver: null,
    phase: 'roleReveal',
    phaseState: {},
    day: 0,
    news: [],
    lastWords: {},
    sheriff: null,
    players: pls,
    settings: { playerCount: PLAYER_COUNT, judgeMode: false, roles: {}, rules: {}, timers: {} },
    canStart: { error: '还没有坐满' },
    // 确认身份阶段的进度；引擎只在该阶段返回它，其余阶段为 null
    roleConfirm: (o.phase || 'roleReveal') === 'roleReveal'
      ? { ready: 3, total: PLAYER_COUNT }
      : null,
    waiting: [],
    judge: null,
    me: o.me !== undefined ? o.me : meFor('villager'),
    private: o.private !== undefined ? o.private : privateFor(),
    ...o,
  };
}

/** 渲染一次并断言没有抛错、且 #app 确实产出了内容。 */
function renderAndAssert(label, snap) {
  const root = env.roots.app;
  root.innerHTML = '';
  const sock = env.lastSocket();
  try {
    sock.fire('state', snap);  // 注入 net.state 并触发 app.render()
  } catch (e) {
    assert.fail(`[${label}] 渲染抛错: ${e.message}\n${e.stack}`);
  }
  const produced = root.childNodes.length > 0 || root.innerHTML !== '';
  assert.ok(produced, `[${label}] #app 渲染后为空（白屏）`);
  return root;
}

/** 收集子树里的全部文本，便于断言内容 */
function textOf(node) {
  let out = node.textContent || '';
  for (const c of node.childNodes) out += ' ' + textOf(c);
  return out;
}

// ---------- 登录 / 首页 ----------

describe('未登录与首页', () => {
  test('未登录时渲染登录卡片（不是白屏）', () => {
    const root = renderAndAssert('auth', null);
    const t = textOf(root);
    assert.match(t, /狼人杀/, '应出现品牌名');
    assert.match(t, /登录|注册/, '应出现登录/注册入口');
  });

  test('已登录但不在房间时渲染首页', async () => {
    const { setPlayerName } = await import('../public/js/net.js');
    globalThis.localStorage.setItem('ww_email', 'a@b.c');
    globalThis.localStorage.setItem('ww_user_email', 'a@b.c');
    globalThis.localStorage.setItem('ww_user_name', '测试');
    setPlayerName('测试');
    const root = renderAndAssert('home', null);
    const t = textOf(root);
    assert.match(t, /创建房间/);
    assert.match(t, /加入房间/);
  });
});

// ---------- 大厅 ----------

describe('创建房间的默认值', () => {
  test('默认预选 9 人局，且板子与人数一致', async () => {
    globalThis.localStorage.setItem('ww_user_email', 'a@b.c');
    const root = renderAndAssert('home-defaults', null);

    const selects = findByClass(root, 'input').filter((n) => n.tagName === 'SELECT');
    assert.equal(selects.length, 1, '应有一个人数下拉框');
    assert.equal(selects[0].value, '9', '默认应预选 9 人（主流配置）');

    const constants = await import('../public/js/constants.js');
    assert.equal(constants.DEFAULT_PLAYER_COUNT, 9);
    const board = constants.DEFAULT_BOARDS[9];
    const total = Object.values(board).reduce((a, b) => a + b, 0);
    assert.equal(total, 9, '默认板子的角色总数必须等于人数，否则创建按钮会一直是禁用态');
  });
});

describe('换座与离开座位', () => {
  const lobbyState = (meExtra) => makeState({
    gameStarted: false, phase: 'lobby',
    me: meFor('villager', { seat: 1, ...meExtra }),
    players: players({ 3: { name: null }, 5: { name: null } }),   // 3、5 号空着
    canStart: { error: '还有 2 个座位未坐满' },
  });

  test('已入座的人点空位是「换到这里」，不是「点击入座」', () => {
    const root = renderAndAssert('swap-sitting', lobbyState({ seat: 1 }));
    const ctas = findByClass(root, 'seat-cta').map(textOf).join(' | ');
    assert.match(ctas, /换到这里/, '已入座的人看到的应是换座提示');
    assert.ok(!/点击入座/.test(ctas), '已入座的人不该看到「点击入座」');
  });

  test('没入座的人点空位是「点击入座」', () => {
    const root = renderAndAssert('swap-none', lobbyState({ seat: null }));
    assert.match(findByClass(root, 'seat-cta').map(textOf).join(' | '), /点击入座/);
  });

  test('已入座的人能看到「离开座位」按钮', () => {
    const root = renderAndAssert('swap-standup', lobbyState({ seat: 1 }));
    const labels = findByClass(root, 'btn-ghost').map(textOf).join(' | ');
    assert.match(labels, /离开座位/, '应有离开座位的入口');
  });

  test('没入座的人看不到「离开座位」（没有座位可离开）', () => {
    const root = renderAndAssert('swap-nostand', lobbyState({ seat: null }));
    assert.ok(!/离开座位/.test(textOf(root)), '没入座不该出现离开座位按钮');
  });

  test('游戏页的座位表不可点击（开局后不能换座）', () => {
    const root = renderAndAssert('swap-ingame', makeState({
      phase: 'dayTalk', me: meFor('villager'), private: privateFor({ canEndPhase: true }),
    }));
    assert.equal(findByClass(root, 'seat-cta').length, 0, '游戏内座位表不该有入座/换座提示');
    assert.equal(findByClass(root, 'seat').filter((n) => n.classList.contains('tappable')).length, 0);
  });
});

describe('大厅', () => {
  test('大厅渲染房间号、座位与开始按钮', () => {
    const snap = makeState({
      gameStarted: false,
      phase: 'lobby',
      me: meFor('villager', { seat: 0 }),
      canStart: { error: '人数不足（1/8）' },
    });
    const root = renderAndAssert('lobby', snap);
    const t = textOf(root);
    assert.match(t, /ABC123/, '应显示房间号');
    assert.match(t, /座位/, '应显示座位区');
  });

  test('法官模式下大厅不崩溃，且法官名有兜底', () => {
    const snap = makeState({
      gameStarted: false,
      phase: 'lobby',
      judgeMode: true,
      me: meFor('villager', { seat: 1, isJudge: true }),
      // 法官本人拿到的 s.judge 是完整状态对象，没有 name 字段
      judge: { players: [], phase: 'lobby', phaseState: {}, sheriff: null, night: null, sheriffState: null, voteState: null },
    });
    const root = renderAndAssert('lobby-judge', snap);
    assert.match(textOf(root), /法官/);
  });
});

// ---------- 游戏页：全部阶段 ----------

describe('游戏页 · 全部阶段', () => {
  test('内联阶段清单与 constants.PHASE_NAME 一致（防止新增阶段后测试漏覆盖）', () => {
    const fromSource = Object.keys(constants.PHASE_NAME).sort();
    const listed = [...ALL_PHASES].sort();
    assert.deepEqual(listed, fromSource,
      `阶段清单与源码不一致。源码有 ${fromSource.length} 个，测试列了 ${listed.length} 个`);
  });

  for (const phase of ALL_PHASES) {
    test(`阶段 ${phase} 可渲染`, () => {
      renderAndAssert(`phase:${phase}`, makeState({ phase, phaseState: {}, day: 1 }));
    });
  }

  test('每个阶段：狼人视角可渲染', () => {
    for (const phase of ALL_PHASES) {
      renderAndAssert(`wolf@${phase}`, makeState({
        phase, day: 1, me: meFor('wolf'), private: privateFor(),
      }));
    }
  });

  test('每个阶段：出局玩家视角可渲染', () => {
    for (const phase of ALL_PHASES) {
      renderAndAssert(`dead@${phase}`, makeState({
        phase, day: 1,
        me: meFor('villager', { alive: false }),
        players: players({ 1: { alive: false } }),
        private: privateFor(),
      }));
    }
  });

  test('每个阶段：法官视角可渲染（且普通玩家不会进入法官面板）', () => {
    for (const phase of ALL_PHASES) {
      const judgeState = {
        players: players().map((p) => ({ ...p, role: p._role, roleName: p._role })),
        phase, phaseState: {}, sheriff: null,
        night: null, sheriffState: null, voteState: null,
      };
      // 法官本人
      renderAndAssert(`judge@${phase}`, makeState({
        phase, day: 1, judgeMode: true, judge: judgeState,
        me: meFor('villager', { isJudge: true }),
        private: privateFor(),
      }));
      // 普通玩家：s.judge 是 {name, connected}，绝不能进法官面板
      renderAndAssert(`nonjudge@${phase}`, makeState({
        phase, day: 1, judgeMode: true, judge: { name: '法官', connected: true },
        me: meFor('villager'),
        private: privateFor(),
      }));
    }
  });
});

// ---------- 各角色在对应阶段的专属操作面板 ----------

describe('角色专属操作面板', () => {
  const cases = [
    ['nightGuard', 'guard', {}],
    ['nightWolves', 'wolf', {}],
    ['nightWitch', 'witch', { private: privateFor({ witch: { healLeft: true, poisonLeft: true, killTarget: 3 } }) }],
    ['nightWitch', 'witch', { private: privateFor({ witch: { healLeft: false, poisonLeft: false, killTarget: 0 } }) }],
    ['nightSeer', 'seer', { private: privateFor({ seerHistory: [{ seat: 3, camp: 'wolf' }, { seat: 4, camp: 'good' }] }) }],
    ['hunterShoot', 'hunter', { private: privateFor({ canShoot: true }) }],
    ['sheriffHandoff', 'villager', { phaseState: { seat: 1 } }],
    ['lastWords', 'villager', { phaseState: { seat: 1 } }],
    ['sheriffDeclare', 'villager', { private: privateFor({ onPodium: true }) }],
    ['sheriffDeclare', 'villager', { private: privateFor({ withdrawn: true }) }],
    ['sheriffSpeech', 'villager', { phaseState: { speakerSeat: 2, candidates: [1, 2, 3] }, private: privateFor({ onPodium: true }) }],
    ['sheriffVote', 'villager', { phaseState: { candidates: [2, 3] }, private: privateFor({ sheriffCanVote: true }) }],
    ['sheriffPk', 'villager', { phaseState: { pkCandidates: [2, 3] }, private: privateFor({ sheriffCanVote: true }) }],
    ['dayVote', 'villager', { private: privateFor({ canVote: true }) }],
    ['votePk', 'villager', { phaseState: { pkCandidates: [2, 3] }, private: privateFor({ canVote: true }) }],
    ['dayTalk', 'wolf', { private: privateFor({ canBlast: true }) }],
  ];

  for (const [phase, role, extra] of cases) {
    const label = `${phase}/${role}${extra.phaseState ? '/' + JSON.stringify(extra.phaseState) : ''}`;
    test(`操作面板可渲染：${label}`, () => {
      const snap = makeState({
        phase, day: 1,
        me: meFor(role),
        private: privateFor(extra.private || {}),
        phaseState: extra.phaseState || {},
      });
      renderAndAssert(label, snap);
    });
  }
});

// ---------- 结算 / 边界 ----------

describe('结算与边界情况', () => {
  for (const winners of ['wolf', 'good']) {
    test(`结算页可渲染（${winners} 胜）`, () => {
      const snap = makeState({
        phase: 'gameOver',
        gameOver: { winners },
        players: players().map((p) => ({ ...p, role: p._role, roleName: p._role, revealed: true })),
      });
      const root = renderAndAssert(`gameover:${winners}`, snap);
      assert.match(textOf(root), winners === 'wolf' ? /狼人阵营获胜/ : /好人阵营获胜/);
    });
  }

  test('房间码与警长标记可渲染', () => {
    const snap = makeState({
      phase: 'dayVote',
      day: 2,
      sheriff: 3,
      players: players({ 3: { isSheriff: true } }),
      news: [{ text: '天亮了' }, { text: '3号 死亡' }, { text: '好人阵营获胜' }],
      lastWords: { 5: '我先走了' },
      me: meFor('villager'),
      private: privateFor({ canVote: true }),
    });
    const root = renderAndAssert('sheriff+news', snap);
    const t = textOf(root);
    assert.match(t, /警长/, '应显示警长信息');
  });

  test('翻牌白痴与已揭示身份可渲染', () => {
    const snap = makeState({
      phase: 'dayVote', day: 3,
      players: players({
        2: { alive: false, revealed: true, role: 'wolf', roleName: '狼人' },
        6: { idiotFlipped: true, revealed: true, role: 'idiot', roleName: '白痴' },
      }),
      me: meFor('villager'),
      private: privateFor({ canVote: true }),
    });
    const root = renderAndAssert('revealed', snap);
    assert.match(textOf(root), /狼人|白痴/);
  });
});

// ---------- 确认身份阶段（无倒计时，显示真实进度）----------

describe('确认身份阶段', () => {
  test('显示真实的确认进度，而不是已入座人数', () => {
    // 满员 8 人但只有 3 人确认 —— 界面必须显示 3/8，不能显示 8/8
    const root = renderAndAssert('roleReveal-progress', makeState({
      phase: 'roleReveal',
      roleConfirm: { ready: 3, total: PLAYER_COUNT },
    }));
    const t = textOf(root);
    assert.match(t, /3\/8/, `应显示真实确认人数 3/8，实际渲染文本: ${t.slice(0, 120)}`);
    assert.doesNotMatch(t, /8\/8/, '不应把已入座人数当成确认人数');
  });

  test('全员确认后给出明确提示', () => {
    const root = renderAndAssert('roleReveal-done', makeState({
      phase: 'roleReveal',
      roleConfirm: { ready: PLAYER_COUNT, total: PLAYER_COUNT },
      me: meFor('villager', { roleReady: true }),
    }));
    assert.match(textOf(root), /8\/8|所有人都已确认|已就绪/);
  });

  test('该阶段不渲染倒计时元素（没有 deadline）', () => {
    const root = renderAndAssert('roleReveal-no-timer', makeState({
      phase: 'roleReveal', phaseState: { deadline: 0 },
    }));
    const timers = root.querySelectorAll('[data-deadline]');
    assert.equal(timers.length, 0, '确认身份阶段不应出现倒计时节点');
  });

  test('任何阶段都不再渲染倒计时（已全部去掉）', () => {
    for (const phase of ALL_PHASES) {
      const root = renderAndAssert(`no-timer@${phase}`, makeState({
        phase, day: 1, me: meFor('wolf'), private: privateFor(),
      }));
      assert.equal(root.querySelectorAll('[data-deadline]').length, 0,
        `${phase} 不应出现倒计时节点`);
    }
  });

  test('该我结束时渲染「结束」按钮，不该我结束时没有', () => {
    // canEndPhase 由引擎判定：夜间阶段只有对应角色看得到
    const mine = renderAndAssert('end-mine', makeState({
      phase: 'nightWolves', me: meFor('wolf'),
      private: privateFor({ canEndPhase: true }),
    }));
    assert.equal(findByClass(mine, 'end-phase-btn').length, 1, '操作人应看到结束按钮');

    const others = renderAndAssert('end-others', makeState({
      phase: 'nightWolves', me: meFor('villager'),
      private: privateFor({ canEndPhase: false }),
    }));
    assert.equal(findByClass(others, 'end-phase-btn').length, 0, '其他人不应看到结束按钮');
    assert.match(textOf(others), /等待狼人结束/, '其他人应看到在等谁');
  });

  test('遗言阶段：输入框已移除，改为「结束发言」按钮', () => {
    const root = renderAndAssert('lastwords', makeState({
      phase: 'lastWords', phaseState: { seat: 1 },
      me: meFor('villager', { alive: false }),
      private: privateFor({ canEndPhase: true }),
    }));
    assert.equal(findByClass(root, 'end-phase-btn').length, 1, '应有点结束发言的按钮');
    assert.equal(root.querySelectorAll('textarea').length, 0, '线下发言，不应再有打字输入框');
    assert.match(textOf(root), /结束发言/);
  });

  test('法官模式下无 deadline 时显示「等待法官推进」', () => {
    const root = renderAndAssert('judge-wait', makeState({
      phase: 'nightWolves', phaseState: { deadline: 0 }, judgeMode: true,
      me: meFor('villager'),
    }));
    assert.match(textOf(root), /等待法官推进/);
  });

  test('引擎缺失 roleConfirm 字段时降级不崩', () => {
    renderAndAssert('roleReveal-missing', makeState({
      phase: 'roleReveal', roleConfirm: null,
    }));
  });
});

// ---------- 结算页的出口 ----------

describe('结算页', () => {
  const overState = (isHost) => makeState({
    phase: 'gameOver', gameOver: { winners: 'good' },
    me: meFor('villager', { isHost }),
  });

  test('房主看到「回到房间」与「退出房间」两个入口', () => {
    const root = renderAndAssert('over-host', overState(true));
    const btns = findByClass(root, 'btn-primary').concat(findByClass(root, 'btn-ghost'));
    const labels = btns.map(textOf).join(' | ');
    assert.match(labels, /回到房间/, '房主应有回到房间的按钮');
    assert.match(labels, /退出房间/, '应有退出房间的按钮');
  });

  test('普通玩家不显示「回到房间」（由房主发起），但能自己退出', () => {
    const root = renderAndAssert('over-player', overState(false));
    const labels = findByClass(root, 'btn-primary').concat(findByClass(root, 'btn-ghost')).map(textOf).join(' | ');
    assert.ok(!/回到房间/.test(labels), '普通玩家不该有回到房间按钮');
    assert.match(labels, /退出房间/, '普通玩家也应能退出');
    assert.match(textOf(root), /等待房主/, '应提示在等房主');
  });

  test('提示写明回到房间后会重新选座', () => {
    const root = renderAndAssert('over-hint', overState(true));
    assert.match(textOf(root), /重新选座/, '应提前说明座位会清空，避免玩家困惑');
  });
});

// ---------- 狼人自爆入口 ----------

describe('狼人自爆', () => {
  const blastState = (phase, priv) => makeState({
    phase, me: meFor('wolf'), private: privateFor(priv),
  });

  test('普通狼人：白天各阶段都有自爆按钮，且不需要选目标', () => {
    for (const phase of ['sheriffDeclare', 'sheriffVote', 'dayTalk', 'dayVote', 'votePk']) {
      const root = renderAndAssert(`blast@${phase}`, blastState(phase, { canBlast: true }));
      assert.ok(findByClass(root, 'blast-box').length > 0, `${phase} 应有自爆入口`);
      const btn = findByClass(root, 'btn-danger').find((b) => textOf(b).includes('自爆'));
      assert.ok(btn, `${phase} 应有自爆按钮`);
      assert.equal(findByClass(root, 'target-chip').length, 0,
        `${phase}：普通狼人自爆不带人，不该出现目标选择器`);
    }
  });

  test('夜晚没有自爆入口', () => {
    for (const phase of ['nightWolves', 'nightWitch', 'nightSeer']) {
      const root = renderAndAssert(`noblast@${phase}`, blastState(phase, { canBlast: false }));
      assert.equal(findByClass(root, 'blast-box').length, 0, `${phase} 不该有自爆入口`);
    }
  });

  test('白狼王：给目标选择器（自爆要带走一人）', () => {
    const root = renderAndAssert('blast-king', makeState({
      phase: 'dayTalk',
      me: meFor('whiteWolfKing'),
      private: privateFor({ canBlast: true, blastTakesVictim: true }),
    }));
    assert.ok(findByClass(root, 'blast-box').length > 0, '应有自爆入口');
    assert.ok(findByClass(root, 'target-chip').length > 0, '白狼王自爆需要选一个带走的人');
  });

  test('好人看不到任何自爆入口', () => {
    for (const phase of ['dayTalk', 'dayVote']) {
      const root = renderAndAssert(`blast-good@${phase}`, makeState({
        phase, me: meFor('villager'), private: privateFor({ canBlast: false }),
      }));
      assert.equal(findByClass(root, 'blast-box').length, 0);
    }
  });

  test('出局的狼看不到自爆入口', () => {
    const root = renderAndAssert('blast-dead', makeState({
      phase: 'dayTalk',
      me: meFor('wolf', { alive: false }),
      private: privateFor({ canBlast: false }),
    }));
    assert.equal(findByClass(root, 'blast-box').length, 0);
  });
});

// ---------- 猎人开枪不泄露身份 ----------

describe('猎人开枪', () => {
  test('猎人本人看到目标选择器', () => {
    const root = renderAndAssert('hunter-self', makeState({
      phase: 'hunterShoot',
      me: meFor('hunter', { alive: false }),
      private: privateFor({ canShoot: true }),
    }));
    assert.ok(findByClass(root, 'target-chip').length > 0, '猎人应能选目标');
  });

  test('其他人只看到等待，且认不出猎人是谁', () => {
    const root = renderAndAssert('hunter-others', makeState({
      phase: 'hunterShoot',
      me: meFor('villager'),
      private: privateFor({ canShoot: false }),
    }));
    assert.equal(findByClass(root, 'target-chip').length, 0, '无关玩家不该看到选择器');
    assert.match(textOf(root), /猎人正在抉择/);
    assert.doesNotMatch(textOf(root), /\d+号\s*猎人/,
      '不该出现「X号 猎人」——那等于当众公布刚才死掉的人就是猎人');
  });
});

// ---------- 警长竞选投票面板 ----------

describe('警长竞选投票', () => {
  test('警下玩家看到候选人可选按钮（回归：曾经只剩一个弃票按钮）', () => {
    const root = renderAndAssert('sheriff-vote-chips', makeState({
      phase: 'sheriffVote',
      phaseState: { candidates: [2, 3, 5] },
      me: meFor('villager'),
      private: privateFor({ sheriffCanVote: true }),
    }));
    const chips = findByClass(root, 'target-chip');
    const seats = chips.map((c) => Number(c.dataset.seat)).sort((a, b) => a - b);
    assert.deepEqual(seats, [2, 3, 5], '候选人应各渲染成一个可选按钮');
    assert.ok(findByClass(root, 'picker').length > 0, '应有选择器容器');
  });

  test('平票 PK 阶段用 pkCandidates 渲染候选', () => {
    const root = renderAndAssert('sheriff-pk-chips', makeState({
      phase: 'sheriffPk',
      phaseState: { pkCandidates: [4, 6] },
      me: meFor('villager'),
      private: privateFor({ sheriffCanVote: true }),
    }));
    const seats = findByClass(root, 'target-chip').map((c) => Number(c.dataset.seat)).sort((a, b) => a - b);
    assert.deepEqual(seats, [4, 6], 'PK 阶段应渲染 pkCandidates');
  });

  test('候选人里若包含自己，不出现自投选项', () => {
    const root = renderAndAssert('sheriff-self', makeState({
      phase: 'sheriffVote',
      phaseState: { candidates: [1, 2, 3] },   // 自己在 1 号
      me: meFor('villager'),
      private: privateFor({ sheriffCanVote: true }),
    }));
    const seats = findByClass(root, 'target-chip').map((c) => Number(c.dataset.seat));
    assert.ok(!seats.includes(1), '不该出现投给自己的选项');
  });
});

// ---------- 预言家查验面板 ----------

describe('预言家查验', () => {
  const seerState = (extra = {}) => makeState({
    phase: 'nightSeer',
    me: meFor('seer'),
    private: privateFor({ canEndPhase: true, ...extra }),
  });

  test('查验结果直接显示在卡片上，不是 toast', () => {
    const root = renderAndAssert('seer-result', seerState({
      seerResult: { seat: 3, camp: 'wolf' },
    }));
    const box = findByClass(root, 'seer-result');
    assert.equal(box.length, 1, '结果应渲染成卡片上的一块（toast 是 #toast，不在这里）');
    assert.match(textOf(box[0]), /3号/);
    assert.match(textOf(box[0]), /狼人/);
  });

  test('已查验后不再给选择器（一夜只能验一人）', () => {
    const root = renderAndAssert('seer-done', seerState({
      seerResult: { seat: 3, camp: 'good' },
    }));
    assert.equal(findByClass(root, 'target-grid').length, 0, '验完就不该再能选目标');
    assert.equal(findByClass(root, 'end-phase-btn').length, 1, '应提示可以结束本阶段');
  });

  test('没验过时给选择器，并排除已验过的人', () => {
    const root = renderAndAssert('seer-pick', seerState({
      seerHistory: [{ seat: 2, camp: 'wolf', day: 1 }, { seat: 4, camp: 'good', day: 2 }],
    }));
    const chips = findByClass(root, 'target-chip');
    const seats = chips.map((c) => Number(c.dataset.seat));
    assert.ok(seats.length > 0, '应有可选目标');
    assert.ok(!seats.includes(2), '2 号已验过，不该出现在可选列表里');
    assert.ok(!seats.includes(4), '4 号已验过，不该出现在可选列表里');
    assert.ok(!seats.includes(1), '不能验自己');
  });

  test('历史查验记录的身份是翻开的', () => {
    const root = renderAndAssert('seer-hist', seerState({
      seerHistory: [{ seat: 2, camp: 'wolf', day: 1 }, { seat: 4, camp: 'good', day: 2 }],
    }));
    const hist = findByClass(root, 'seer-chip');
    assert.equal(hist.length, 2, '两条历史应各占一块');
    const text = hist.map(textOf).join(' | ');
    assert.match(text, /2号\s*狼人/, '历史里应直接写出身份');
    assert.match(text, /4号\s*好人/);
  });

  test('非预言家在预言家阶段只看到等待提示', () => {
    const root = renderAndAssert('seer-others', makeState({
      phase: 'nightSeer', me: meFor('villager'), private: privateFor(),
    }));
    assert.match(textOf(root), /等待预言家/);
    assert.equal(findByClass(root, 'seer-result').length, 0);
  });
});

// ---------- 防偷看：身份牌默认收起 ----------

/** 垫片的选择器只支持 [attr]，这里按类名自己找。 */
function findByClass(node, cls, out = []) {
  if (node.classList && node.classList.contains(cls)) out.push(node);
  for (const c of node.childNodes || []) findByClass(c, cls, out);
  return out;
}

describe('防偷看', () => {
  test('确认身份阶段：身份牌内联展示（此时必须看得见）', () => {
    const root = renderAndAssert('peek-reveal', makeState({ phase: 'roleReveal' }));
    assert.equal(findByClass(root, 'role-card').length, 1, '确认身份阶段应内联显示身份牌');
    assert.equal(findByClass(root, 'peek-btn').length, 0, '此时不需要额外的查看按钮');
  });

  for (const phase of ['nightWolves', 'dayTalk', 'dayVote', 'nightSeer']) {
    test(`开局后（${phase}）身份牌不再内联展示`, () => {
      const root = renderAndAssert(`peek-${phase}`, makeState({
        phase, me: meFor('wolf'), private: privateFor(),
      }));
      assert.equal(findByClass(root, 'role-card').length, 0,
        '桌上一直摊着身份牌，隔桌就能看见——这是要防的泄露');
      assert.equal(findByClass(root, 'peek-btn').length, 1, '应提供按住查看的入口');
    });
  }

  test('出局玩家同样收起身份牌，但保留查看入口', () => {
    const root = renderAndAssert('peek-dead', makeState({
      phase: 'dayVote', me: meFor('villager', { alive: false }),
    }));
    assert.equal(findByClass(root, 'role-card').length, 0);
    assert.equal(findByClass(root, 'peek-btn').length, 1, '出局后仍可能要看自己的身份');
  });

  test('按住按钮显示浮层，松手立即消失', async () => {
    const { isPeeking, hidePeek } = await import('../public/js/components/rolePeek.js');
    const root = renderAndAssert('peek-hold', makeState({ phase: 'nightWolves', me: meFor('wolf') }));
    const btn = findByClass(root, 'peek-btn')[0];
    assert.ok(btn, '找不到查看按钮');

    btn.dispatch('pointerdown', { preventDefault() {} });
    assert.equal(isPeeking(), true, '按住应显示浮层');
    const mask = findByClass(env.doc.body, 'peek-mask');
    assert.equal(mask.length, 1, '浮层应挂在 body 上');

    env.fireWindow('pointerup');
    assert.equal(isPeeking(), false, '松手应立刻收起——这是防偷看的关键');
    assert.equal(findByClass(env.doc.body, 'peek-mask').length, 0);

    hidePeek();
  });

  test('浮层内容包含角色名与狼队友，且不含狼红/好人绿配色类', async () => {
    const { showPeek, hidePeek } = await import('../public/js/components/rolePeek.js');
    showPeek(makeState({ phase: 'nightWolves', me: meFor('wolf') }));
    const mask = findByClass(env.doc.body, 'peek-mask')[0];
    assert.ok(mask, '浮层未出现');

    const t = textOf(mask);
    assert.match(t, /狼人/, '应能看到自己的身份');
    assert.match(t, /狼队友/, '应能看到狼队友');

    // 中性配色的核心：不能出现「一眼看出阵营」的彩色类名
    const colored = findByClass(mask, 'wolf').concat(findByClass(mask, 'good'));
    assert.equal(colored.length, 0,
      `浮层里不应有 wolf/good 这类彩色类名，否则隔桌就能看出阵营：${colored.map(n => n.className).join(', ')}`);
    hidePeek();
  });

  test('浮层挂在 body 上，服务端推送重建 #app 也不会把它弄没', async () => {
    const { isPeeking, hidePeek } = await import('../public/js/components/rolePeek.js');
    renderAndAssert('peek-before-push', makeState({ phase: 'nightWolves', me: meFor('wolf') }));
    const btn = findByClass(env.roots.app, 'peek-btn')[0];
    btn.dispatch('pointerdown', { preventDefault() {} });
    assert.equal(isPeeking(), true);

    // 别人操作触发一次推送 → #app 整棵重建
    renderAndAssert('peek-after-push', makeState({ phase: 'nightWolves', me: meFor('wolf') }));
    assert.equal(isPeeking(), true, '推送重建不应关掉正在查看的身份牌');
    assert.equal(findByClass(env.doc.body, 'peek-mask').length, 1);
    hidePeek();
  });

  test('切到后台或按 Esc 都能收起浮层', async () => {
    const { showPeek, isPeeking, hidePeek } = await import('../public/js/components/rolePeek.js');
    showPeek(makeState({ phase: 'dayTalk', me: meFor('wolf') }));
    env.fireWindow('keydown', { key: 'Escape' });
    assert.equal(isPeeking(), false, 'Esc 应能收起');

    showPeek(makeState({ phase: 'dayTalk', me: meFor('wolf') }));
    env.fireDocument('visibilitychange');
    assert.equal(isPeeking(), false, '切到后台应收起——切后台往往意味着手机要放下或被别人拿去看');
    hidePeek();
  });

  test('重复显示不会残留多个浮层', async () => {
    const { showPeek, hidePeek } = await import('../public/js/components/rolePeek.js');
    showPeek(makeState({ phase: 'dayTalk', me: meFor('wolf') }));
    showPeek(makeState({ phase: 'dayTalk', me: meFor('wolf') }));
    assert.equal(findByClass(env.doc.body, 'peek-mask').length, 1, '同一时刻只应有一个浮层');
    hidePeek();
    assert.equal(findByClass(env.doc.body, 'peek-mask').length, 0);
  });

  test('反复开关不留悬挂的全局监听器', async () => {
    const { showPeek, hidePeek } = await import('../public/js/components/rolePeek.js');
    const before = env.win.listenerCount('pointerup');
    for (let i = 0; i < 10; i++) {
      showPeek(makeState({ phase: 'dayTalk', me: meFor('wolf') }));
      hidePeek();
    }
    assert.equal(env.win.listenerCount('pointerup'), before,
      '每次 show 都注册、hide 都注销，不应累积监听器');
  });
});

// ---------- 白屏防线（两个已修复的存量缺陷）----------

describe('白屏防线', () => {
  test('main.js 必须无条件渲染一次，不能只依赖状态推送', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../public/js/main.js', import.meta.url), 'utf8');
    // net.on 的回调只在「已有 state」时才触发，而服务端只在玩家处于房间中时才推送
    // state——全新访客（未登录、无房间）永远等不到推送。若 main.js 只在 net.on 里
    // 渲染，第一次打开就是白屏，且连登录入口都没有。
    const standalone = src
      .split('\n')
      .filter((l) => !l.includes('net.on') && /app\.render\(\)/.test(l));
    assert.ok(standalone.length > 0,
      'main.js 中找不到独立于 net.on 的 app.render() 调用——全新访客会看到白屏');
  });

  test('法官面板必须用 me.isJudge 判定，不能用 s.judge 的真值', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../public/js/views/game.js', import.meta.url), 'utf8');
    // 法官模式下非法官玩家拿到的 s.judge 是 {name, connected}（没有 players），
    // 拿它当开关会把普通玩家送进法官面板，j.players 未定义 → 整页崩掉变白屏。
    assert.match(src, /me\.isJudge/, 'game.js 未见 me.isJudge 判定');
    assert.ok(!/if\s*\(\s*s\.judge\s*\)/.test(src),
      'game.js 仍以 s.judge 的真值作判断——非法官玩家会白屏');
  });
});

// ---------- 重渲染不崩（真实场景：每次推送都整页重建） ----------

describe('反复重渲染', () => {
  test('连续注入 40 次状态推送不崩溃', () => {
    const phases = Object.keys(constants.PHASE_NAME);
    for (let i = 0; i < 40; i++) {
      const phase = phases[i % phases.length];
      renderAndAssert(`loop#${i}@${phase}`, makeState({
        phase,
        day: (i % 5) + 1,
        news: Array.from({ length: i % 12 }, (_, k) => ({ text: `事件 ${k}` })),
        me: meFor(['wolf', 'seer', 'witch', 'villager', 'hunter'][i % 5]),
        private: privateFor({
          witch: { healLeft: true, poisonLeft: false, killTarget: i % 8 + 1 },
          seerHistory: Array.from({ length: i % 4 }, (_, k) => ({ seat: k + 2, camp: k % 2 ? 'wolf' : 'good' })),
          canVote: i % 3 === 0,
        }),
      }));
    }
  });
});
