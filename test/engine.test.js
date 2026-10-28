// 引擎单元测试：直接用 Room 逻辑驱动完整对局（无需网络）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, buildSettings } from '../server/engine.js';
import { defaultBoardFor, validateRoles, isWolf } from '../server/roles.js';
import { NIGHT_MASK_MIN_MS, NIGHT_MASK_MAX_MS } from '../server/config.js';

// ---------- 确定性随机 ----------
const origRandom = Math.random;
function seedRandom(seed) {
  let s = seed >>> 0;
  Math.random = () => {
    s = (s * 1103515245 + 12345) >>> 0;
    return s / 4294967296;
  };
}
function restoreRandom() {
  Math.random = origRandom;
}

// ---------- 工具 ----------
function makeRoom(count, opts = {}) {
  const settings = buildSettings({
    playerCount: count,
    judgeMode: !!opts.judgeMode,
    roles: opts.roles,
    rules: opts.rules || {},
  });
  return new Room({ code: 'TEST01', settings, hostPlayerId: 'HOST', hostName: '房主', onChange: () => {} });
}

function setupRoom(count, opts = {}) {
  const room = makeRoom(count, opts);
  if (opts.judgeMode) {
    for (let i = 1; i <= count; i++) {
      const pid = `p${i}`;
      room.addPlayer(pid, `玩家${i}`);
      room.sit(pid, i);
    }
  } else {
    for (let i = 2; i <= count; i++) {
      const pid = `p${i}`;
      room.addPlayer(pid, `玩家${i}`);
      room.sit(pid, i);
    }
    room.sit('HOST', 1);
  }
  return room;
}

/**
 * 需要守卫的用例用它：9 人局 + 守卫（3 狼 + 2 民 + 预言家/女巫/猎人/守卫）。
 * 默认的 9 人板子是主流配置「3 狼 + 3 神 + 3 民」，不含守卫。
 */
function setupRoomWithGuard(count = 9, opts = {}) {
  return setupRoom(count, {
    ...opts,   // 别丢掉 judgeMode 之类的选项
    roles: { wolf: 3, villager: count - 7, seer: 1, witch: 1, hunter: 1, guard: 1 },
  });
}

const pidAt = (room, seat) => room._playerAt(seat).playerId;
const roleAt = (room, seat) => room._playerAt(seat).role;
const seatOfRole = (room, role) => { const p = room._livePlayers().find(x => x.role === role); return p ? p.seat : null; };
const wolfSeats = (room) => room._liveWolves().map(w => w.seat);
const aliveGood = (room) => room._livePlayers().filter(p => !isWolf(p.role)).map(p => p.seat);
const nonHunterGood = (room) => aliveGood(room).filter(s => roleAt(room, s) !== 'hunter');
const NIGHT_PHASES = ['nightGuard', 'nightWolves', 'nightWitch', 'nightSeer'];
const isNight = (ph) => NIGHT_PHASES.includes(ph);

function confirmRoles(room) {
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);
}

/**
 * 从当前夜间阶段开始，按需执行各角色行动，推进到 dayStart 或 gameOver。
 *
 * 推进规则：**行动即自动进入下一阶段**（守卫/女巫/预言家/狼人都一样）。
 * 所以这里只在「本晚不行动」时才手动 endPhase —— 与真实玩家点按钮等价。
 *
 * 注意不要在行动之后再补一次 endPhase：那时阶段已经变了，若恰好轮到
 * 房主推进的阶段（例如预言家验完已到 dayStart，而预言家正好是房主），
 * 这句多余的调用会把天亮播报也一起跳过去，静默污染整局。
 */
function playNight(room, { wolfTarget, guardTarget, witchHeal, witchPoison, seerTarget }) {
  let guard2 = 0;
  while (isNight(room.phase) && !room.gameOver && guard2++ < 40) {
    switch (room.phase) {
      case 'nightGuard': {
        const g = seatOfRole(room, 'guard');
        if (!g) { room.advance(); break; }
        const pid = pidAt(room, g);
        if (guardTarget) room.submitNightAction(pid, { type: 'guardProtect', target: guardTarget });
        else room.endPhase(pid);          // 空守 → 手动放行
        break;
      }
      case 'nightWolves': {
        const wolves = room._liveWolves();
        if (!wolfTarget || !wolves.length) { room.advance(); break; }
        // 全员投同一个目标 → 过半，引擎自动进入下一阶段
        for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: wolfTarget });
        break;
      }
      case 'nightWitch': {
        const witch = seatOfRole(room, 'witch');
        if (!witch) { room.advance(); break; }
        const pid = pidAt(room, witch);
        if (witchHeal) room.submitNightAction(pid, { type: 'witchAct', kind: 'heal', target: witchHeal });
        else if (witchPoison) room.submitNightAction(pid, { type: 'witchAct', kind: 'poison', target: witchPoison });
        else room.endPhase(pid);          // 不用药 → 手动放行
        break;
      }
      case 'nightSeer': {
        const seer = seatOfRole(room, 'seer');
        if (!seer) { room.advance(); break; }
        const pid = pidAt(room, seer);
        if (seerTarget) room.submitNightAction(pid, { type: 'seerCheck', target: seerTarget });
        else room.endPhase(pid);          // 不查验 → 手动放行
        break;
      }
      default: room.advance();
    }
  }
}

/** 把白天的事件性阶段（播报/遗言/猎人开枪/警徽移交）全部推进过去（默认不做动作）。 */
function drainDay(room) {
  let g = 0;
  while (['dayStart', 'lastWords', 'hunterShoot', 'sheriffHandoff'].includes(room.phase) && !room.gameOver && g++ < 40) {
    room.advance();
  }
}

/** 推进到白天发言阶段（处理遗言/开枪/警徽移交，以及首日的警长竞选退水）。 */
function drainToDayTalk(room) {
  drainDay(room);
  if (room.phase === 'sheriffDeclare') {
    for (const p of room._livePlayers()) room.setDeclaration(p.playerId, false);
  }
}

/**
 * 首日全员退水 → 无人上警 → 警徽流失 → 公布昨夜死讯。
 * 返回时可能停在 dayTalk，也可能因死者是猎人/警长而进入开枪/移交警徽。
 */
function skipSheriff(room) {
  if (room.phase !== 'sheriffDeclare') return;
  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, false);
}

function allExileVote(room, target) {
  for (const p of room._voteEligible()) {
    // 不能投给自己（引擎的新规则）：目标本人只能弃票。
    // 弃票不影响目标得票，所以「全员投某人出局」的语义仍然成立。
    room.exileVote(p.playerId, p.seat === target ? 0 : target);
  }
}

// ---------- 测试 ----------

test('默认板子：9~16 人全部合法且人数匹配', () => {
  for (let n = 9; n <= 16; n++) {
    const b = defaultBoardFor(n);
    assert.equal(validateRoles(b, n), null);
    assert.equal(Object.values(b).reduce((a, c) => a + c, 0), n);
  }
});

test('非法板子被拒绝', () => {
  assert.ok(validateRoles({ wolf: 4, villager: 4 }, 8), '4狼 vs 4好 应拒绝');
  assert.ok(validateRoles({ wolf: 1, villager: 6 }, 8), '总数不匹配应拒绝');
  assert.ok(validateRoles({ wolf: 0, villager: 8 }, 8), '无狼应拒绝');
  assert.ok(validateRoles({ wolf: 3, villager: 2, seer: 1 }, 7), '人数越界应拒绝');
});

test('开局发牌：角色数量与配置一致，每位玩家仅知自己身份', () => {
  seedRandom(1);
  const room = setupRoom(12);
  room.start();
  const counts = {};
  for (let s = 1; s <= 12; s++) {
    const r = roleAt(room, s);
    counts[r] = (counts[r] || 0) + 1;
  }
  const expected = {};
  for (const [k, v] of Object.entries(room.settings.roles)) if (v > 0) expected[k] = v;
  assert.deepEqual(counts, expected);
  // 快照：p2 只能看到自己的牌
  const snap = room.snapshot('p2');
  assert.equal(snap.me.role, roleAt(room, 2));
  assert.equal(snap.players.filter(p => p.role).length, 0); // 其他人不显示身份
  restoreRandom();
});

test('完整自动对局：好人阵营获胜（狼人全部出局）', () => {
  seedRandom(7);
  const room = setupRoom(9); // 3狼 + 预言家 + 女巫 + 猎人 + 2民
  room.start();
  assert.equal(room.phase, 'roleReveal');
  confirmRoles(room);

  // 夜1：狼刀好人，女巫救 → 平安夜
  const kill1 = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill1, witchHeal: kill1, seerTarget: wolfSeats(room)[0] });
  assert.equal(room._playerAt(kill1).alive, true, '被救的玩家应存活');
  drainToDayTalk(room);
  assert.equal(room.phase, 'dayTalk', '首日进入发言');

  // 白天1：放逐 1 狼
  const w1 = wolfSeats(room)[0];
  room.advance(); // → dayVote
  allExileVote(room, w1);
  assert.equal(room._playerAt(w1).alive, false, '狼人1被放逐');
  drainToDayTalk(room);

  // 夜2：狼刀（女巫解药已用，8人局无守卫）→ 死亡
  const kill2 = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill2, seerTarget: wolfSeats(room)[0] });
  assert.equal(room._playerAt(kill2).alive, false, '被刀玩家死亡');
  drainToDayTalk(room);
  assert.equal(room.phase, 'dayTalk');

  // 白天2：放逐 2 狼
  const w2 = wolfSeats(room)[0];
  room.advance();
  allExileVote(room, w2);
  assert.equal(room._playerAt(w2).alive, false);
  drainToDayTalk(room);

  // 夜3：狼刀
  const kill3 = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill3, seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);

  // 白天3：放逐最后一只狼 → 好人胜
  const w3 = wolfSeats(room)[0];
  room.advance();
  allExileVote(room, w3);
  assert.equal(room.gameOver && room.gameOver.winners, 'good');
  assert.equal(room.phase, 'gameOver');
  assert.ok(room.news.some(n => n.text.includes('好人')));
  restoreRandom();
});

test('狼人获胜：屠边（杀光所有平民）', () => {
  seedRandom(3);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);

  // 9 人板子是 3 狼 + 3 平民 + 3 神，按**屠边**规则：杀光平民（或神职）即狼胜。
  // 这里专门走「屠光平民」这条路。
  const villagers = () => room._livePlayers().filter(p => p.role === 'villager');
  assert.equal(villagers().length, 3, '前提：3 名平民');

  // 夜1：刀一个平民 → 还剩 2
  playNight(room, { wolfTarget: villagers()[0].seat, seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  assert.equal(villagers().length, 2);

  // 白天1：放逐一个平民 → 还剩 1（此时神职一个没少，不该判狼胜）
  room.advance();
  allExileVote(room, villagers()[0].seat);
  assert.ok(!room.gameOver, '只死平民而神职尚存时不该结束');
  drainToDayTalk(room);
  assert.equal(villagers().length, 1, '还剩最后一个平民');

  // 夜2：刀掉最后一个平民 → 平民全灭 → 屠边成立，狼胜。
  // 注意不要传 seerTarget：预言家不能重复验同一人，验不动的话这一夜永远结算不了。
  playNight(room, { wolfTarget: villagers()[0].seat });
  assert.ok(room.gameOver, '杀光平民应立即判定胜负');
  assert.equal(room.gameOver.winners, 'wolf', '屠边成立 → 狼人胜');
  assert.equal(room.phase, 'gameOver');
  restoreRandom();
});

test('警长竞选：上警发言 → 平票PK → 二次投票选出', () => {
  seedRandom(6);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);
  assert.equal(room.phase, 'sheriffDeclare', '首日进入警长竞选');

  // 1、2 上警，其余警下
  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, [1, 2].includes(p.seat));
  assert.equal(room.phase, 'sheriffSpeech');

  // 依次发言结束 → 投票
  while (room.phase === 'sheriffSpeech') room.advance();
  assert.equal(room.phase, 'sheriffVote');

  // 警下 3:3 平分给 1、2（1 人弃票）→ 平票 PK
  for (const v of room._sheriffVoters()) {
    room.sheriffVote(v.playerId, v.seat <= 5 ? 1 : (v.seat <= 8 ? 2 : 0));
  }
  assert.equal(room.phase, 'sheriffPk');

  // PK 重投：4 票给 1 → 当选
  for (const v of room._sheriffVoters()) {
    room.sheriffVote(v.playerId, v.seat <= 6 ? 1 : (v.seat <= 8 ? 2 : 0));
  }
  assert.equal(room.sheriff, 1);
  assert.equal(room.phase, 'dayTalk');
});

test('警长 1.5 票影响放逐结果（避免平票）', () => {
  seedRandom(9);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const kill = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill, witchHeal: kill, seerTarget: wolfSeats(room)[0] }); // 平安夜
  drainDay(room);
  assert.equal(room.phase, 'sheriffDeclare', '首日进入警长竞选');

  // 只有 1 号上警 → 直接当选警长
  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, p.seat === 1);
  assert.equal(room.sheriff, 1);
  assert.equal(room.phase, 'dayTalk');

  // 放逐投票：警长(1)→7号，2号→7号，3、4号→8号，其余弃票
  // 加权后 7号=3+2=5，8号=2+2=4 → 7号被放逐（不加权则 2:2 平票PK）
  room.advance();
  const A = 7, B = 8;
  room.exileVote(pidAt(room, 1), A);
  room.exileVote(pidAt(room, 2), A);
  room.exileVote(pidAt(room, 3), B);
  room.exileVote(pidAt(room, 4), B);
  for (const p of room._voteEligible()) if (![1, 2, 3, 4].includes(p.seat)) room.exileVote(p.playerId, 0);
  assert.notEqual(room.phase, 'votePk', '不应进入PK');
  assert.equal(room._playerAt(A).alive, false, '7号应被放逐');
});

test('放逐平票进入 PK，PK 仍平则平安日', () => {
  seedRandom(15);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const kill = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill, witchHeal: kill, seerTarget: wolfSeats(room)[0] }); // 平安夜
  drainToDayTalk(room);
  assert.equal(room.phase, 'dayTalk');
  room.advance();

  // 两拨 3:3 投给 1 号和 2 号 → 平票 PK。
  // 注意 1 号不能投自己、8 号留作弃票，2-4 投 1 号、5-7 投 2 号，正好 3:3。
  const voteTie = () => {
    for (const p of room._voteEligible()) {
      if (p.seat === 1 || p.seat >= 8) room.exileVote(p.playerId, 0);
      else room.exileVote(p.playerId, p.seat <= 4 ? 1 : 2);
    }
  };
  voteTie();
  assert.equal(room.phase, 'votePk');

  // PK 重投仍 3:3 → 平安日，进入夜晚
  voteTie();
  assert.equal(room._playerAt(1).alive, true);
  assert.equal(room._playerAt(2).alive, true);
  assert.ok(isNight(room.phase), 'PK 后进入夜晚');
});

test('猎人被狼刀可开枪；被女巫毒死不能开枪', () => {
  seedRandom(11);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const hunterSeat = seatOfRole(room, 'hunter');

  // 夜1：狼刀猎人，女巫不用药 → 猎人死亡
  playNight(room, { wolfTarget: hunterSeat, seerTarget: wolfSeats(room)[0] });
  // 首日先竞选警长；死讯在竞选结束后才公布（面杀主流顺序）
  assert.equal(room.phase, 'dayStart');
  room.advance();
  assert.equal(room.phase, 'sheriffDeclare');
  assert.equal(room._playerAt(hunterSeat).alive, true, '首日竞选期间，昨夜死者尚未结算');
  skipSheriff(room);
  assert.equal(room._playerAt(hunterSeat).alive, false);
  assert.equal(room.phase, 'hunterShoot', '夜间死亡不留遗言，应直接进开枪阶段');
  const target = aliveGood(room).find(s => s !== hunterSeat);
  room.hunterShoot(pidAt(room, hunterSeat), target);
  assert.equal(room._playerAt(target).alive, false, '猎人开枪带走目标');
  assert.equal(room._playerAt(hunterSeat).revealed, true, '猎枪翻牌');

  // 新一局：女巫毒猎人
  seedRandom(23);
  const room2 = setupRoom(9);
  room2.start();
  confirmRoles(room2);
  const h2 = seatOfRole(room2, 'hunter');
  playNight(room2, { wolfTarget: nonHunterGood(room2)[0], witchPoison: h2, seerTarget: wolfSeats(room2)[0] });
  drainDay(room2);      // dayStart → sheriffDeclare
  skipSheriff(room2);   // 竞选结束 → 公布死讯
  assert.equal(room2._playerAt(h2).alive, false);
  assert.equal(room2._playerAt(h2).revealed, false, '被毒死的猎人不翻牌');
  drainDay(room2);
  assert.notEqual(room2.phase, 'hunterShoot', '毒死不能开枪');
});

test('猎人被放逐可开枪（先遗言后开枪）', () => {
  seedRandom(29);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const hunterSeat = seatOfRole(room, 'hunter');
  playNight(room, { wolfTarget: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  assert.equal(room.phase, 'dayTalk');
  room.advance(); // → dayVote
  allExileVote(room, hunterSeat);
  assert.equal(room._playerAt(hunterSeat).alive, false);
  assert.equal(room.phase, 'lastWords');
  room.advance();
  assert.equal(room.phase, 'hunterShoot');
  const target = aliveGood(room).find(s => s !== hunterSeat);
  room.hunterShoot(pidAt(room, hunterSeat), target);
  assert.equal(room._playerAt(target).alive, false, '猎人开枪带走目标');
  assert.equal(room._playerAt(hunterSeat).revealed, true, '猎枪翻牌');
});

test('白痴被放逐：翻牌免死、失去投票权', () => {
  seedRandom(31);
  const room = setupRoom(12); // 12人板子含白痴
  room.start();
  confirmRoles(room);
  const idiotSeat = seatOfRole(room, 'idiot');
  playNight(room, { wolfTarget: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance();
  allExileVote(room, idiotSeat);
  const p = room._playerAt(idiotSeat);
  assert.equal(p.alive, true, '白痴免死');
  assert.equal(p.idiotFlipped, true);
  assert.equal(p.revealed, true);
  assert.ok(isNight(room.phase), '翻牌后直接进入夜晚');
  // 白痴失去投票权
  assert.equal(room._voteEligible().some(x => x.seat === idiotSeat), false);
});

test('守卫守护狼刀目标 → 平安夜', () => {
  seedRandom(17);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  const guardSeat = seatOfRole(room, 'guard');
  const kill = nonHunterGood(room).find(s => s !== guardSeat);
  playNight(room, { wolfTarget: kill, guardTarget: kill, seerTarget: wolfSeats(room)[0] });
  assert.equal(room._playerAt(kill).alive, true, '被守护的狼刀目标存活');
  drainToDayTalk(room);
  assert.ok(room.news.some(n => n.text.includes('平安夜')));
});

test('守卫不能连续两晚守同一人', () => {
  seedRandom(41);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  const guardSeat = seatOfRole(room, 'guard');
  const kill1 = nonHunterGood(room).find(s => s !== guardSeat);
  playNight(room, { wolfTarget: kill1, witchHeal: kill1, guardTarget: guardSeat, seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance(); // → dayVote
  const victim = aliveGood(room).find(s => s !== guardSeat && roleAt(room, s) === 'villager');
  allExileVote(room, victim);
  drainToDayTalk(room);
  // 夜2：守卫试图守同一人 → 被拒
  const res = room.submitNightAction(pidAt(room, guardSeat), { type: 'guardProtect', target: guardSeat });
  assert.ok(res.error, '重复守护应被拒绝');
});

test('白狼王自爆：带走一人，白天直接结束', () => {
  seedRandom(13);
  const room = setupRoom(9, { roles: { wolf: 2, whiteWolfKing: 1, villager: 3, seer: 1, witch: 1, hunter: 1 } });
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  assert.equal(room.phase, 'dayTalk');
  const wwkSeat = seatOfRole(room, 'whiteWolfKing');
  const target = aliveGood(room).find(s => roleAt(room, s) === 'villager');
  room.blast(pidAt(room, wwkSeat), target);
  assert.equal(room._playerAt(wwkSeat).alive, false);
  assert.equal(room._playerAt(target).alive, false);
  assert.equal(room._playerAt(wwkSeat).revealed, true, '白狼王翻牌');
  assert.ok(room.news.some(n => n.text.includes('自爆')));
  // 处理遗言后直接进入夜晚（或已分胜负）
  drainDay(room);
  assert.ok(isNight(room.phase) || room.gameOver, '自爆后直接进入夜晚');
});

test('女巫首夜可自救（默认开启）', () => {
  seedRandom(43);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const witchSeat = seatOfRole(room, 'witch');
  playNight(room, { wolfTarget: witchSeat, witchHeal: witchSeat, seerTarget: wolfSeats(room)[0] });
  assert.equal(room._playerAt(witchSeat).alive, true, '首夜自救成功');
});

test('法官模式：玩家操作提交、法官手动推进、法官可见全部身份', () => {
  seedRandom(19);
  const room = setupRoomWithGuard(9, { judgeMode: true });
  room.start();
  assert.equal(room.phase, 'roleReveal');

  // 法官快照含全部身份；玩家快照仅自己（能看到法官身份信息但无完整法官态）
  const jsnap = room.snapshot(room.judgePlayerId);
  assert.ok(jsnap.judge);
  assert.equal(jsnap.judge.players.length, 9);
  const p1snap = room.snapshot('p1');
  assert.ok(p1snap.judge && !p1snap.judge.players, '普通玩家无完整法官态');
  assert.equal(p1snap.me.role, roleAt(room, 1));

  // 法官手动推进，玩家夜间操作不自动推进
  room.advance(); // roleReveal → 夜1 守卫（9人局有守卫）
  assert.equal(room.phase, 'nightGuard');
  const guardSeat = seatOfRole(room, 'guard');
  const gtarget = guardSeat === 1 ? 2 : 1;
  room.submitNightAction(pidAt(room, guardSeat), { type: 'guardProtect', target: gtarget });
  assert.equal(room.phase, 'nightGuard', '法官模式下不自动推进');
  // 法官能看到守卫的选择
  assert.equal(room.snapshot(room.judgePlayerId).judge.night.guardTarget, gtarget);

  room.advance(); // → 狼人
  assert.equal(room.phase, 'nightWolves');
  const target = aliveGood(room)[0];
  for (const w of room._liveWolves()) room.submitNightAction(w.playerId, { type: 'wolfKill', target });
  assert.equal(room.phase, 'nightWolves', '狼人行动也需法官推进');

  room.advance(); // → 女巫（有药）
  room.advance(); // → 预言家
  room.advance(); // → 结算 → dayStart
  assert.equal(room.phase, 'dayStart');

  // 法官指令：手动改生死 / 强制结束
  const res = room.judgeCommand(room.judgePlayerId, 'setDeath', { seat: 1, alive: false });
  assert.ok(!res.error);
  assert.equal(room._playerAt(1).alive, false);
  const res2 = room.judgeCommand(room.judgePlayerId, 'endGame', { camp: 'good' });
  assert.ok(!res2.error);
  assert.equal(room.gameOver.winners, 'good');
  // 非法玩家调用法官指令被拒
  const res3 = room.judgeCommand('p1', 'endGame', { camp: 'wolf' });
  assert.ok(res3.error, '非法官无权');
});

// ---------- 确认身份阶段：无倒计时，全员确认即推进 ----------

test('所有阶段都没有倒计时（phaseState 不含 deadline）', () => {
  seedRandom(11);
  const room = setupRoom(9); // 9 人局有守卫，夜间四个阶段都能走到
  room.start();
  assert.ok(!('deadline' in room.phaseState), '确认身份阶段不应有 deadline');

  confirmRoles(room);
  let n = 0;
  while (isNight(room.phase) && n++ < 10) {
    assert.ok(!('deadline' in room.phaseState),
      `${room.phase} 不应有 deadline —— 去掉倒计时后不存在任何时间驱动的推进`);
    const role = { nightGuard: 'guard', nightWolves: 'wolf', nightWitch: 'witch', nightSeer: 'seer' }[room.phase];
    const actor = room._livePlayers().find(p => p.role === role);
    room.endPhase(actor.playerId);
  }
  restoreRandom();
});

test('tick 只驱动「掩护阶段」，正常阶段再久也不会被时间推进', () => {
  seedRandom(70);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  assert.equal(room.phase, 'nightGuard');
  assert.ok(!room.phaseState.masked, '守卫还活着，这是正常阶段');

  // 把时钟拨到 10 分钟后：正常阶段不该被 tick 推进
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000;
  try {
    for (let i = 0; i < 5; i++) room.tick();
  } finally {
    Date.now = realNow;
  }
  assert.equal(room.phase, 'nightGuard', '正常阶段只能由人结束，时间不参与推进');
  restoreRandom();
});

// ---------- 显式结束阶段（endPhase）----------

test('夜间：行动完即自动进入下一阶段，不需要点结束', () => {
  seedRandom(21);
  const room = setupRoomWithGuard(9); // 9 人局有守卫
  room.start();
  confirmRoles(room);
  assert.equal(room.phase, 'nightGuard');

  const guard = room._livePlayers().find(p => p.role === 'guard');
  const target = room._livePlayers().find(p => p.playerId !== guard.playerId);
  room.submitNightAction(guard.playerId, { type: 'guardProtect', target: target.seat });
  assert.equal(room.phase, 'nightWolves', '守护完应直接进入下一阶段');
  restoreRandom();
});

test('夜间：本晚不行动时可以手动放行', () => {
  seedRandom(211);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  assert.equal(room.phase, 'nightGuard');

  const guard = room._livePlayers().find(p => p.role === 'guard');
  const other = room._livePlayers().find(p => p.playerId !== guard.playerId);
  assert.ok(room.endPhase(other.playerId).error, '非守卫不能结束守卫阶段');
  assert.equal(room.endPhase(guard.playerId).ok, true, '守卫选择空守时应能手动放行');
  assert.equal(room.phase, 'nightWolves');
  restoreRandom();
});

test('夜间：女巫用药后自动进入下一阶段', () => {
  seedRandom(212);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);

  // 让狼人先刀一个，女巫才有解药可用
  const wolves = room._liveWolves();
  const victim = room._livePlayers().find(p => !isWolf(p.role)).seat;
  for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: victim });
  assert.equal(room.phase, 'nightWitch');

  const witch = room._livePlayers().find(p => p.role === 'witch');
  room.submitNightAction(witch.playerId, { type: 'witchAct', kind: 'heal', target: victim });
  assert.notEqual(room.phase, 'nightWitch', '用药后应直接进入下一阶段');
  restoreRandom();
});

test('夜间：预言家验完自动进入白天，且结果仍在私有字段里', () => {
  seedRandom(213);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  const target = room._livePlayers().find(p => p.playerId !== seer.playerId && p.role !== 'seer');

  room.submitNightAction(seer.playerId, { type: 'seerCheck', target: target.seat });
  assert.equal(room.phase, 'dayStart', '验完应直接结算进入天亮');
  // 自动推进后操作面板会整块重建，结果必须留在私有字段里供前端常驻展示
  assert.equal(room.snapshot(seer.playerId).private.seerResult.seat, target.seat);
  restoreRandom();
});

// ---------- 预言家查验 ----------

/** 开局并推进到预言家行动阶段。 */
function toNightSeer(room) {
  room.start();
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);
  let guard = 0;
  while (room.phase !== 'nightSeer' && !room.gameOver && guard++ < 20) {
    if (room.phase === 'nightWolves') {
      const wolves = room._liveWolves();
      const t = room._livePlayers().find(p => !wolves.includes(p)).seat;
      for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: t });
    } else {
      const actor = room._livePlayers().find(p => ({ nightGuard: 'guard', nightWitch: 'witch' })[room.phase] === p.role);
      if (actor) room.endPhase(actor.playerId); else room.advance();
    }
  }
  assert.equal(room.phase, 'nightSeer', `未能进入预言家阶段（当前 ${room.phase}）`);
  return room;
}

test('预言家：一晚只能查验一人（回归：曾经可以一夜验遍全场）', () => {
  seedRandom(41);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  const others = room._livePlayers().filter(p => p.playerId !== seer.playerId);

  assert.equal(room.submitNightAction(seer.playerId, { type: 'seerCheck', target: others[0].seat }).ok, true);
  // 关键：不能借着再调一次接口继续验别人
  for (const o of others.slice(1)) {
    const res = room.submitNightAction(seer.playerId, { type: 'seerCheck', target: o.seat });
    assert.ok(res.error, `验 ${o.seat}号 应被拒绝`);
  }
  assert.equal(seer.seerHistory.length, 1, '一晚只能留下一条记录');
  restoreRandom();
});

test('预言家：同一人不能重复查验（跨夜也不行）', () => {
  seedRandom(42);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  const first = room._livePlayers().find(p => p.playerId !== seer.playerId);

  room.submitNightAction(seer.playerId, { type: 'seerCheck', target: first.seat });
  // 造出「同一晚再验一次」的另一个入口：换个人验也被拒
  assert.ok(room.submitNightAction(seer.playerId, { type: 'seerCheck', target: first.seat }).error);

  // 跨夜：把记录手工带过去，验证历史去重逻辑
  room.phase = 'nightSeer';
  room.night = { ...room.night, seerTarget: null, seerResult: null };
  const again = room.submitNightAction(seer.playerId, { type: 'seerCheck', target: first.seat });
  assert.ok(again.error, '已经验过的人不该能再验一次');
  assert.match(again.error, /已经查验过/);
  restoreRandom();
});

test('预言家：只能验别人，不能验自己', () => {
  seedRandom(43);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  assert.ok(room.submitNightAction(seer.playerId, { type: 'seerCheck', target: seer.seat }).error);
  restoreRandom();
});

test('预言家：他人不能冒用查验接口', () => {
  seedRandom(44);
  const room = toNightSeer(setupRoom(9));
  const notSeer = room._livePlayers().find(p => p.role !== 'seer');
  const target = room._livePlayers().find(p => p.playerId !== notSeer.playerId);
  assert.ok(room.submitNightAction(notSeer.playerId, { type: 'seerCheck', target: target.seat }).error);
  restoreRandom();
});

test('预言家：查验结果只发给本人，且当夜可读', () => {
  seedRandom(45);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  const target = room._livePlayers().find(p => p.playerId !== seer.playerId);
  const other = room._livePlayers().find(p => p.playerId !== seer.playerId && p.playerId !== target.playerId);

  room.submitNightAction(seer.playerId, { type: 'seerCheck', target: target.seat });

  const mine = room.snapshot(seer.playerId).private;
  assert.equal(mine.seerResult.seat, target.seat, '本人应拿到今夜的查验结果');
  assert.equal(mine.seerResult.camp, isWolf(target.role) ? 'wolf' : 'good', '结果必须与真实身份一致');
  assert.deepEqual(mine.seerHistory.map(h => h.seat), [target.seat], '历史记录只发给本人');

  assert.equal(room.snapshot(other.playerId).private.seerResult, null, '别人不该拿到查验结果');
  assert.deepEqual(room.snapshot(other.playerId).private.seerHistory, [], '别人不该拿到验人记录');
  restoreRandom();
});

test('预言家：查验结果随天数累积，不会因进入白天而丢', () => {
  seedRandom(46);
  const room = toNightSeer(setupRoom(9));
  const seer = room._livePlayers().find(p => p.role === 'seer');
  const target = room._livePlayers().find(p => p.playerId !== seer.playerId);
  room.submitNightAction(seer.playerId, { type: 'seerCheck', target: target.seat });
  const dayOfCheck = seer.seerHistory[0].day;

  room.endPhase(seer.playerId);          // 离开预言家阶段 → 天亮
  assert.notEqual(room.phase, 'nightSeer');
  assert.equal(seer.seerHistory.length, 1, '记录应保留');
  assert.equal(seer.seerHistory[0].day, dayOfCheck, '应记下查验的夜次');
  assert.equal(room.snapshot(seer.playerId).private.seerHistory[0].seat, target.seat,
    '天亮后仍能从快照读到历史（前端据此把身份牌翻开）');
  restoreRandom();
});

// ---------- 狼人队内投票（少数服从多数）----------

/**
 * 开局并推进到狼人行动阶段（跳过确认身份与守卫阶段）。
 * 循环带上限：万一阶段卡住，测试应该失败而不是挂死。
 */
function toWolfVote(room) {
  room.start();
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);
  let guard = 0;
  while (room.phase !== 'nightWolves' && !room.gameOver && guard++ < 20) {
    const actor = room._livePlayers().find(p => ({ nightGuard: 'guard' })[room.phase] === p.role);
    if (actor) room.endPhase(actor.playerId);
    else room.advance();
  }
  assert.equal(room.phase, 'nightWolves', `未能进入狼人行动阶段（当前 ${room.phase}）`);
  return room;
}

test('狼人：没投完就停在原阶段，全员投完后自动进入下一阶段', () => {
  seedRandom(31);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  const victim = room._livePlayers().find(p => !isWolf(p.role)).seat;

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: victim });
  assert.equal(room.phase, 'nightWolves', '只投了 1 票，阶段不动');

  room.submitNightAction(wolves[1].playerId, { type: 'wolfKill', target: victim });
  assert.equal(room.phase, 'nightWolves', '还差一票，仍不动');

  // 第三票投出 → 3/3 过半 → 直接进入下一阶段，不需要任何人点结束
  room.submitNightAction(wolves[2].playerId, { type: 'wolfKill', target: victim });
  assert.equal(room.phase, 'nightWitch', '全员投完且有结果，自动走过狼人阶段');
  restoreRandom();
});

test('狼人：阶段不提供手动结束入口', () => {
  seedRandom(311);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  // 哪怕全员都投完了，也不该有人需要/能够手动结束——引擎已经自动推进了
  for (const w of wolves) {
    assert.equal(room._canEndPhase(room.players.get(w.playerId)), false,
      '狼人阶段不应出现「结束」按钮');
  }
  restoreRandom();
});

test('狼人：票数过半即敲定刀口（3 狼需 2 票）', () => {
  seedRandom(32);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  assert.equal(wolves.length, 3, '9 人局应为 3 狼');
  const good = room._livePlayers().filter(p => !isWolf(p.role)).map(p => p.seat);

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: good[0] });
  room.submitNightAction(wolves[1].playerId, { type: 'wolfKill', target: good[0] });
  room.submitNightAction(wolves[2].playerId, { type: 'wolfKill', target: good[1] });

  assert.equal(room.night.wolfTarget, good[0], '2:1 应由多数票当选，不再要求全员一致');
  assert.equal(room.snapshot(wolves[0].playerId).private.wolfNeed, 2, '3 狼过半需 2 票');
  restoreRandom();
});

test('狼人：无人过半则清空所有票，需要重新投票', () => {
  seedRandom(33);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  const good = room._livePlayers().filter(p => !isWolf(p.role)).map(p => p.seat);

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: good[0] });
  room.submitNightAction(wolves[1].playerId, { type: 'wolfKill', target: good[1] });
  room.submitNightAction(wolves[2].playerId, { type: 'wolfKill', target: good[2] });

  assert.equal(room.night.wolfTarget, null, '三票各不同，没人过半');
  assert.equal(Object.keys(room.night.wolfVotes).length, 0, '票应被清空');
  assert.equal(room.night.wolfRevote, true, '应标记为需要重投');
  assert.equal(room._allWolvesVoted(), false, '清空后需重新投票');
  assert.ok(room.endPhase(wolves[0].playerId).error, '没有多数票时不能结束');

  // 重投：这次集中投同一个目标 → 过半即自动进入下一阶段
  for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: good[0] });
  assert.equal(room.night.wolfTarget, good[0], '重投过半后应敲定');
  assert.equal(room.night.wolfRevote, false);
  assert.notEqual(room.phase, 'nightWolves', '重投有结果后应自动走过狼人阶段');
  restoreRandom();
});

test('狼人：票型只发给狼队，好人拿不到', () => {
  seedRandom(34);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  const villager = room._livePlayers().find(p => !isWolf(p.role));
  const target = villager.seat;

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target });

  const wolfPriv = room.snapshot(wolves[0].playerId).private;
  const goodPriv = room.snapshot(villager.playerId).private;
  assert.deepEqual(wolfPriv.wolfTally, [[target, 1]], '狼应看到票型');
  assert.equal(wolfPriv.wolfVote, target, '狼应看到自己投了谁');
  assert.equal(goodPriv.wolfTally, undefined, '好人不应拿到狼队票型');
  assert.equal(goodPriv.wolfVote, null, '好人不应拿到狼队票型（该字段对他们是空）');
  restoreRandom();
});

test('狼人：2 狼局必须意见一致（过半即全票）', () => {
  seedRandom(35);
  // 默认板子最小也是 3 狼，2 狼局要自定义板子
  const room = makeRoom(9, { roles: { wolf: 2, villager: 4, seer: 1, witch: 1, hunter: 1 } });
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  toWolfVote(room);

  const wolves = room._liveWolves();
  assert.equal(wolves.length, 2);
  const good = room._livePlayers().filter(p => !isWolf(p.role)).map(p => p.seat);

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: good[0] });
  room.submitNightAction(wolves[1].playerId, { type: 'wolfKill', target: good[1] });
  assert.equal(room.night.wolfTarget, null, '2 狼各投一个 → 平分，无多数，重投');
  assert.equal(Object.keys(room.night.wolfVotes).length, 0);
  restoreRandom();
});

test('狼人：刀口只打好人，不能刀队友或自己', () => {
  seedRandom(36);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  assert.ok(room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: wolves[0].seat }).error, '不能刀自己');
  assert.ok(room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: wolves[1].seat }).error, '不能刀队友');
  restoreRandom();
});

test('狼人：无多数导致的重投不会泄漏给好人（不广播）', () => {
  seedRandom(37);
  const room = toWolfVote(setupRoom(9));
  const wolves = room._liveWolves();
  const good = room._livePlayers().filter(p => !isWolf(p.role)).map(p => p.seat);
  const before = room.news.length;

  room.submitNightAction(wolves[0].playerId, { type: 'wolfKill', target: good[0] });
  room.submitNightAction(wolves[1].playerId, { type: 'wolfKill', target: good[1] });
  room.submitNightAction(wolves[2].playerId, { type: 'wolfKill', target: good[2] });

  assert.equal(room.news.length, before,
    '狼队重新投票不该出现在公共播报里——那等于告诉好人「狼在吵」');
  restoreRandom();
});

test('结束阶段的报错不泄露操作人座位号', () => {
  seedRandom(22);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const guard = seatOfRole(room, 'guard');
  const res = room.endPhase(pidAt(room, guard === 1 ? 2 : 1));
  assert.ok(res.error);
  assert.ok(!res.error.includes(String(guard)),
    `报错里不能出现守卫的座位号 ${guard}，否则等于当众公布谁是守卫：${res.error}`);
  restoreRandom();
});

test('天亮播报 / 白天发言：只有房主能结束', () => {
  seedRandom(23);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0] });
  assert.equal(room.phase, 'dayStart');

  assert.ok(room.endPhase('p2').error, '普通玩家不能结束播报阶段');
  assert.equal(room.endPhase('HOST').ok, true, '房主可以');
  restoreRandom();
});

test('遗言阶段：由正在留遗言的玩家点结束', () => {
  seedRandom(24);
  const room = setupRoom(9);
  room.start();
  room.phase = 'lastWords';
  room.phaseState = { seat: 3 };

  assert.ok(room.endPhase('p5').error, '别人不能替他结束');
  assert.equal(room.endPhase('p3').ok, true);
  restoreRandom();
});

test('法官模式：玩家不能用 endPhase 抢节奏', () => {
  const room = setupRoom(9, { judgeMode: true });
  room.start();
  assert.ok(room.endPhase('p1').error, '法官模式下应由法官推进');
});

test('已经结束的对局不能再结束阶段', () => {
  const room = setupRoom(9);
  room.start();
  room.gameOver = { winners: 'good' };
  assert.ok(room.endPhase('HOST').error);
});

test('无需手动结束的阶段调用 endPhase 会被拒绝', () => {
  const room = setupRoom(9);
  room.start();
  // 确认身份阶段靠全员确认自动推进，不提供「结束」入口
  assert.ok(room.endPhase('HOST').error);
  assert.equal(room._canEndPhase(room.players.get('HOST')), false);
});

test('全员确认后立即进入夜晚，差一人都不推进', () => {
  const room = setupRoom(9);
  room.start();
  const live = room._livePlayers();
  for (let i = 0; i < live.length - 1; i++) {
    room.roleConfirm(live[i].playerId);
    assert.equal(room.phase, 'roleReveal', `已确认 ${i + 1}/${live.length} 人，不应提前推进`);
  }
  room.roleConfirm(live[live.length - 1].playerId);
  assert.ok(room.phase.startsWith('night'), '最后一人确认后应立即进入夜晚');
});

test('快照里的确认进度是真实确认人数，不是已入座人数', () => {
  const room = setupRoom(9);
  room.start();
  // 满员 9 人，但一个人都还没确认——进度必须是 0/8
  assert.deepEqual(room.snapshot('HOST').roleConfirm, { ready: 0, total: 9 },
    '用已入座人数冒充确认进度会让界面一开局就显示「全员已确认」');
  room.roleConfirm(pidAt(room, 3));
  assert.deepEqual(room.snapshot('HOST').roleConfirm, { ready: 1, total: 9 });
  room.roleConfirm(pidAt(room, 5));
  assert.deepEqual(room.snapshot('HOST').roleConfirm, { ready: 2, total: 9 });
});

test('离开确认阶段后不再暴露确认进度', () => {
  const room = setupRoom(9);
  room.start();
  assert.ok(room.snapshot('HOST').roleConfirm, '确认阶段应有进度');
  confirmRoles(room);
  assert.ok(room.phase.startsWith('night'));
  assert.equal(room.snapshot('HOST').roleConfirm, null, '非确认阶段不应有该字段');
});

test('引擎已不提供「跳过阶段」能力（每个阶段只由它自己的操作人推进）', () => {
  const room = setupRoom(9);
  room.start();
  assert.equal(typeof room.hostCommand, 'undefined',
    'hostCommand 已移除：房主不能再无差别跳过任何阶段');

  // 确认身份阶段只能靠全员确认推进，房主也不例外
  room.roleConfirm(pidAt(room, 1));
  assert.equal(room.phase, 'roleReveal');
  assert.equal(room.endPhase('HOST').error !== undefined, true,
    '房主也不能结束确认身份阶段');
});

test('房主出局后仍能推进「天亮播报 / 白天发言」', () => {
  seedRandom(95);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  room.players.get('HOST').alive = false;   // 房主夜里被刀

  room.phase = 'dayStart';
  room.phaseState = {};
  assert.equal(room.endPhase('HOST').ok, true, '房主出局后仍要能主持天亮播报');

  room.phase = 'dayTalk';
  room.phaseState = {};
  const other = room._livePlayers().find(p => p.playerId !== 'HOST');
  assert.ok(room.endPhase(other.playerId).error, '普通玩家（哪怕活着）不能推进白天发言');
  assert.equal(room.endPhase('HOST').ok, true, '房主仍能推进白天发言');
});

test('法官模式：全员确认后仍由法官手动推进', () => {
  const room = setupRoom(9, { judgeMode: true });
  room.start();
  confirmRoles(room);
  assert.equal(room.phase, 'roleReveal', '法官模式下节奏由法官掌握，不应自动进入夜晚');
  const res = room.judgeCommand(room.judgePlayerId, 'advance');
  assert.equal(res.ok, true);
  assert.ok(room.phase.startsWith('night'));
});

test('法官模式下确认进度同样可见，且不因无人确认而推进', () => {
  const room = setupRoom(9, { judgeMode: true });
  room.start();
  assert.deepEqual(room.snapshot(room.judgePlayerId).roleConfirm, { ready: 0, total: 9 });
  room.roleConfirm(pidAt(room, 2));
  assert.deepEqual(room.snapshot(room.judgePlayerId).roleConfirm, { ready: 1, total: 9 });
});

// ---------- 警长竞选的候选人下发（回归：曾经前端拿不到名单）----------

/**
 * 推进到警长投票阶段，并让前 `podiumCount` 个**存活**玩家上警。
 * 不能写死座位号：不同随机种子下，夜里被刀死的人不同。
 * @returns {{ room, podium:number[] }} podium 是实际当选候选人的座位
 */
function toSheriffVote(room, podiumCount) {
  room.start();
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);
  let g = 0;
  while (room.phase !== 'sheriffDeclare' && !room.gameOver && g++ < 30) {
    if (room.phase === 'nightWolves') {
      const wolves = room._liveWolves();
      const t = room._livePlayers().find(p => !wolves.includes(p)).seat;
      for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: t });
    } else if (room.phase === 'nightSeer') {
      const seer = room._livePlayers().find(p => p.role === 'seer');
      room.submitNightAction(seer.playerId, { type: 'seerCheck', target: room._livePlayers().find(p => p.playerId !== seer.playerId).seat });
    } else {
      const actor = room._livePlayers().find(p => ({ nightGuard: 'guard', nightWitch: 'witch' })[room.phase] === p.role);
      if (actor) room.endPhase(actor.playerId); else room.advance();
    }
  }
  assert.equal(room.phase, 'sheriffDeclare', `未能进入警长竞选（当前 ${room.phase}）`);

  const alive = room._livePlayers();
  const podium = alive.slice(0, podiumCount).map(p => p.seat).sort((a, b) => a - b);
  for (const p of alive) room.setDeclaration(p.playerId, podium.includes(p.seat));

  // 候选人依次发言，由发言者本人结束
  let n = 0;
  while (room.phase === 'sheriffSpeech' && n++ < 12) {
    room.endPhase(room._playerAt(room.phaseState.speakerSeat).playerId);
  }
  return { room, podium };
}

test('警长投票阶段必须带上候选人名单（回归：前端曾拿不到，只剩弃票按钮）', () => {
  seedRandom(51);
  const { room, podium } = toSheriffVote(setupRoom(9), 3);
  assert.equal(room.phase, 'sheriffVote');

  assert.deepEqual(room.snapshot('HOST').phaseState.candidates, podium,
    '候选人必须随阶段下发，否则投票面板没有可选项');

  // 投票者本人也拿得到
  const voter = room._livePlayers().find(p => !podium.includes(p.seat));
  assert.deepEqual(room.snapshot(voter.playerId).phaseState.candidates, podium);
  assert.equal(room.snapshot(voter.playerId).private.sheriffCanVote, true);
  assert.equal(room.sheriffVote(voter.playerId, podium[0]).ok, true, '应能投给名单里的候选人');
  restoreRandom();
});

test('警长平票 PK 阶段带上 pkCandidates', () => {
  seedRandom(52);
  const { room, podium } = toSheriffVote(setupRoom(9), 2);
  assert.equal(room.phase, 'sheriffVote');
  const [c1, c2] = podium;

  // 警下人数为奇数，两边票数相等就必然有人弃票，正好凑成平票进 PK
  const voters = room._sheriffVoters();
  const half = Math.floor(voters.length / 2);
  voters.forEach((v, i) => room.sheriffVote(v.playerId, i < half ? c1 : (i < half * 2 ? c2 : 0)));
  assert.equal(room.phase, 'sheriffPk', `${half}:${half} 平票应进入 PK`);
  assert.deepEqual(room.snapshot('HOST').phaseState.pkCandidates, [c1, c2],
    'PK 阶段也必须下发候选人，否则重新投票时同样没有可选项');
  restoreRandom();
});

test('放逐平票 PK 阶段带上 pkCandidates', () => {
  seedRandom(53);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0] });
  drainToDayTalk(room);
  room.advance(); // → dayVote

  // 3:3 平票（1 号不能投自己，第 8 人弃票）
  const voteTie = () => {
    for (const p of room._voteEligible()) {
      if (p.seat === 1 || p.seat >= 8) room.exileVote(p.playerId, 0);
      else room.exileVote(p.playerId, p.seat <= 4 ? 1 : 2);
    }
  };
  voteTie();
  assert.equal(room.phase, 'votePk');
  assert.deepEqual(room.snapshot('HOST').phaseState.pkCandidates, [1, 2],
    '放逐 PK 也必须下发候选人');
  restoreRandom();
});

// ---------- 前后端默认板子必须一致 ----------
// 前端那份用来预填创建房间的表单并做「配置是否合法」的即时校验，
// 服务端那份在未指定 roles 时兜底。两者一旦漂移，界面会显示一套、
// 实际发牌另一套——曾经 9 人局就因为前端多写了一个村民而无法创建。

test('前端 DEFAULT_BOARDS 与服务端 defaultBoardFor 完全一致（9~16 人）', async () => {
  const client = await import('../public/js/constants.js');
  for (let n = 9; n <= 16; n++) {
    const srv = defaultBoardFor(n);
    const cli = client.DEFAULT_BOARDS[n];
    assert.ok(cli, `前端缺少 ${n} 人板子`);
    assert.deepEqual(cli, srv, `${n} 人局：前端与服务端的板子不一致`);

    const total = Object.values(cli).reduce((a, b) => a + b, 0);
    assert.equal(total, n,
      `${n} 人局：前端板子角色总数为 ${total}，与人数不符——创建按钮会被永久禁用`);
  }
});

test('前端创建表单预填的规则与服务端默认一致', async () => {
  const client = await import('../public/js/constants.js');
  const { DEFAULT_RULES: serverRules } = await import('../server/config.js');
  // 服务端可以有自己的内部默认（例如 sheriffVoteWeight，前端不发这个字段），
  // 但前端会发出去的每个键，值必须与服务端默认相同——否则界面显示的默认
  // 和实际生效的规则会对不上。
  for (const [key, val] of Object.entries(client.DEFAULT_RULES)) {
    assert.ok(key in serverRules, `前端多出一个服务端不认识的规则 ${key}`);
    assert.equal(val, serverRules[key], `规则 ${key} 的默认值前后端不一致`);
  }
});

test('规则开关的每个键都在默认规则里有定义', async () => {
  const client = await import('../public/js/constants.js');
  for (const [key] of client.RULES_LABELS) {
    assert.ok(key in client.DEFAULT_RULES, `规则开关 ${key} 缺少默认值`);
  }
});

// ---------- 阶段播报 ----------

test('每个阶段进入时都会播报一句（相当于线下法官口播）', () => {
  seedRandom(61);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  // 阶段是依次进入的，必须先走完整个夜晚再统一检查
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });

  const texts = room.news.map((n) => n.text).join(' | ');
  for (const kw of ['游戏开始', '天黑请闭眼', '守卫请睁眼', '狼人请睁眼', '女巫请睁眼', '预言家请睁眼', '天亮了']) {
    assert.ok(texts.includes(kw), `缺少播报：${kw}\n实际播报：${texts}`);
  }
  restoreRandom();
});

test('白天与竞选的阶段也有播报', () => {
  seedRandom(611);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);                       // dayStart → sheriffDeclare
  assert.equal(room.phase, 'sheriffDeclare');
  assert.ok(room.news.some(n => n.text.includes('警长竞选开始')), '应播报警长竞选');

  const room2 = setupRoom(9);
  room2.start();
  confirmRoles(room2);
  playNight(room2, { wolfTarget: nonHunterGood(room2)[0], witchHeal: nonHunterGood(room2)[0], seerTarget: wolfSeats(room2)[0] });
  drainToDayTalk(room2);                // 退水 → 进入白天发言
  assert.equal(room2.phase, 'dayTalk');
  assert.ok(room2.news.some(n => n.text.includes('自由发言')), '应播报白天发言');

  room2.advance();                      // → dayVote
  assert.ok(room2.news.some(n => n.text.includes('投票放逐')), '应播报放逐投票');
  restoreRandom();
});

test('播报顺序：天亮了 → 竞选警长 → 公布昨夜结果', () => {
  seedRandom(62);
  const room = setupRoom(9); // 8 人局无守卫
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });

  let texts = room.news.map(n => n.text);
  const iDawn = texts.findIndex(t => t.includes('天亮了'));
  const iElection = texts.findIndex(t => t.includes('首日先进行警长竞选'));
  assert.ok(iDawn >= 0, '应有天亮播报');
  assert.ok(iElection > iDawn, '「天亮了」之后应先宣布竞选警长');
  assert.ok(!texts.some(t => t.includes('平安夜') || t.includes('昨夜死亡')),
    '竞选结束前不应提前公布死讯');

  room.advance();     // 天亮播报 → 警长竞选
  skipSheriff(room);

  texts = room.news.map(n => n.text);
  const iResult = texts.findIndex(t => t.includes('平安夜') || t.includes('昨夜死亡'));
  assert.ok(iResult >= 0, '应有昨夜结果');
  assert.ok(iDawn < iElection && iElection < iResult,
    `顺序应为 天亮 → 竞选 → 死讯，实际 dawn=${iDawn} election=${iElection} result=${iResult}`);
  restoreRandom();
});

test('播报不泄露身份：夜间阶段一律不提座位号', () => {
  seedRandom(63);
  const room = setupRoomWithGuard(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });

  // 报出座位号等于当众公布「那个座位是什么角色」
  for (const kw of ['守卫请睁眼', '狼人请睁眼', '女巫请睁眼', '预言家请睁眼']) {
    const item = room.news.find((n) => n.text.includes(kw));
    assert.ok(item, `缺少播报：${kw}`);
    assert.ok(!/\d+号/.test(item.text), `「${kw}」的播报不该带座位号：${item.text}`);
  }
  restoreRandom();
});

// ---------- 猎人阶段不泄露身份 ----------

test('猎人开枪阶段：座位号对全场保密，只有猎人自己知道轮到自己', () => {
  seedRandom(64);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const hunter = room._livePlayers().find(p => p.role === 'hunter');
  const other = room._livePlayers().find(p => p.playerId !== hunter.playerId);

  room.phase = 'hunterShoot';
  room.phaseState = { seat: hunter.seat };

  const pub = room.snapshot(other.playerId).phaseState;
  assert.ok(!('seat' in pub),
    `公共 phaseState 不该带座位号——那是「死掉的人是猎人」的直接答案：${JSON.stringify(pub)}`);
  assert.equal(room.snapshot(hunter.playerId).private.canShoot, true, '猎人本人应知道轮到自己');
  assert.equal(room.snapshot(other.playerId).private.canShoot, false, '别人不该知道');
  restoreRandom();
});

// ---------- 被放逐不公开身份（默认规则）----------

test('默认规则下：被放逐的玩家身份不公开', () => {
  seedRandom(65);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0] });
  drainToDayTalk(room);
  room.advance(); // → dayVote

  const victim = room._livePlayers().find(p => p.role !== 'idiot' && p.seat !== 1);
  for (const p of room._voteEligible()) {
    room.exileVote(p.playerId, p.seat === victim.seat ? 0 : victim.seat);
  }

  assert.equal(room._playerAt(victim.seat).alive, false, '应被放逐');
  const pub = room.snapshot('HOST').players.find(p => p.seat === victim.seat);
  assert.equal(pub.role, null,
    '被放逐者的身份不该出现在公共快照里——否则一次放逐白送全场一条身份信息');
  assert.equal(pub.revealed, false);
  restoreRandom();
});

test('显式打开 revealOnExile 时才会翻牌', () => {
  seedRandom(66);
  const room = makeRoom(9, { rules: { revealOnExile: true } });
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0] });
  drainToDayTalk(room);
  room.advance();

  const victim = room._livePlayers().find(p => p.role !== 'idiot' && p.seat !== 1);
  for (const p of room._voteEligible()) {
    room.exileVote(p.playerId, p.seat === victim.seat ? 0 : victim.seat);
  }
  const pub = room.snapshot('HOST').players.find(p => p.seat === victim.seat);
  assert.equal(pub.revealed, true, '打开规则后应翻牌');
  assert.ok(pub.role, '打开规则后公共快照应带上身份');
  restoreRandom();
});

test('首日竞选前不结算夜间死亡：死者仍可上警（面杀主流顺序）', () => {
  seedRandom(621);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const victim = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: victim, seerTarget: wolfSeats(room)[0] });

  room.advance();
  assert.equal(room.phase, 'sheriffDeclare');
  assert.equal(room._playerAt(victim).alive, true, '竞选阶段，昨夜死者尚未公布，应仍按存活处理');
  // 死者本人在线下此时不知道自己已死，仍可上警并发言
  room.setDeclaration(pidAt(room, victim), true);
  assert.ok(room.sheriffState.onPodium.has(victim), '昨夜死者应能上警');

  skipSheriff(room);
  assert.equal(room._playerAt(victim).alive, false, '竞选结束后才结算昨夜死亡');
  assert.ok(room.news.some(n => n.text.includes(`${victim}号 在昨夜死亡`)));
  restoreRandom();
});

test('关闭 sheriffBeforeDeath：先公布死讯，再竞选警长', () => {
  seedRandom(622);
  const room = setupRoom(9, { rules: { sheriffBeforeDeath: false } });
  room.start();
  confirmRoles(room);
  const victim = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: victim, seerTarget: wolfSeats(room)[0] });

  assert.equal(room.phase, 'dayStart');
  assert.equal(room._playerAt(victim).alive, false, '关闭新规则后，天亮即结算死亡');
  assert.ok(room.news.some(n => n.text.includes(`${victim}号 在昨夜死亡`)));
  assert.ok(!room.news.some(n => n.text.includes('首日先进行警长竞选')));

  room.advance();
  assert.equal(room.phase, 'sheriffDeclare', '公布死讯后再进入竞选');
  restoreRandom();
});

test('昨夜死者当选警长：竞选结束后公布死讯并立即移交警徽', () => {
  seedRandom(623);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const victim = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: victim, seerTarget: wolfSeats(room)[0] });
  room.advance();
  assert.equal(room.phase, 'sheriffDeclare');

  // 只有死者上警 → 直接当选（他此时还不知道自己已死）
  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, p.seat === victim);
  assert.equal(room.sheriff, victim, '死者在竞选阶段按存活处理，可以当选');
  assert.equal(room._playerAt(victim).alive, false, '竞选结束后结算死讯');
  assert.equal(room.phase, 'sheriffHandoff', '死去的警长必须交回警徽');

  const heir = aliveGood(room).find(s => s !== victim);
  room.sheriffHandoff(pidAt(room, victim), { mode: 'pass', target: heir });
  assert.equal(room.sheriff, heir);
  restoreRandom();
});

test('昨夜结果必须随广播发出去（回归：曾在最后一次广播之后才写 news）', () => {
  seedRandom(67);
  // 记录每次 onChange 广播时的 news 快照，模拟客户端实际收到的内容
  const broadcasts = [];
  const settings = buildSettings({ playerCount: 9 });
  const room = new Room({
    code: 'TEST01', settings, hostPlayerId: 'HOST', hostName: '房主',
    onChange: (r) => broadcasts.push(r.news.map((n) => n.text).join(' | ')),
  });
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  // 首日的死讯要等竞选结束才结算；广播必须把结算后的版本推出去
  room.advance();     // 天亮播报 → 警长竞选
  skipSheriff(room);

  assert.ok(broadcasts.length > 0, '应发生过广播');
  const last = broadcasts[broadcasts.length - 1];
  assert.ok(/平安夜|昨夜死亡/.test(last),
    `最后一次广播里必须带上昨夜结果，否则客户端看不到。最后一次广播内容：${last}`);
  restoreRandom();
});

test('没有守卫的板子也要播报「天黑请闭眼」（回归：曾把它挂在守卫阶段上）', () => {
  seedRandom(68);
  const room = setupRoom(9); // 默认 8 人局：3 狼 + 预言家 + 女巫 + 猎人 + 2 民，没有守卫
  assert.ok(!room._livePlayers().some(p => p.role === 'guard'), '前提：8 人局确实没有守卫');
  room.start();
  confirmRoles(room);
  assert.equal(room.phase, 'nightWolves', '没有守卫时夜晚直接从狼人开始');

  // 「天黑请闭眼」是「进入夜晚」的播报，不该依赖任何角色存在
  assert.ok(room.news.some(n => n.text.includes('天黑请闭眼')),
    `没有守卫的板子也必须播报天黑，实际播报：${room.news.map(n => n.text).join(' | ')}`);
  // 守卫阶段被跳过，就不该出现守卫的播报
  assert.ok(!room.news.some(n => n.text.includes('守卫请睁眼')), '没有守卫就不该报守卫');

  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  const texts = room.news.map(n => n.text).join(' | ');
  for (const kw of ['天黑请闭眼', '狼人请睁眼', '女巫请睁眼', '预言家请睁眼', '天亮了']) {
    assert.ok(texts.includes(kw), `缺少播报：${kw}`);
  }
  restoreRandom();
});

test('每个夜晚都会播报一次天黑', () => {
  seedRandom(69);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  let guard = 0;
  let nights = 0;
  while (!room.gameOver && guard++ < 60) {
    if (room.phase === 'nightWolves') {
      nights++;
      const wolves = room._liveWolves();
      const t = room._livePlayers().find(p => !wolves.includes(p));
      if (t) for (const w of wolves) room.submitNightAction(w.playerId, { type: 'wolfKill', target: t.seat });
      else room.advance();
    } else if (['nightGuard', 'nightWitch', 'nightSeer'].includes(room.phase)) {
      const actor = room._livePlayers().find(p => ({ nightGuard: 'guard', nightWitch: 'witch', nightSeer: 'seer' })[room.phase] === p.role);
      if (actor) room.endPhase(actor.playerId); else room.advance();
    } else if (room.phase === 'dayTalk') {
      room.advance();
    } else if (room.phase === 'dayVote' || room.phase === 'votePk') {
      const cands = room.phaseState.pkCandidates || room._livePlayers().map(p => p.seat);
      for (const p of room._voteEligible()) room.exileVote(p.playerId, cands.find(s => s !== p.seat) ?? 0);
    } else {
      room.advance();
    }
  }
  const dawnCount = room.news.filter(n => n.text.includes('天黑请闭眼')).length;
  assert.ok(nights >= 2, `应至少经历两个夜晚，实际 ${nights}`);
  // news 上限 40 条，这里每晚条目不多，两个夜晚都能留得住
  assert.ok(dawnCount >= 2, `每个夜晚都该播报一次天黑，实际 ${dawnCount} 次（共 ${nights} 夜）`);
  restoreRandom();
});

// ---------- 女巫自救：仅首夜 ----------

/** 构造「女巫被刀」的局面，返回自救的提交结果。 */
function tryWitchSelfHeal(dayNum, ruleOn) {
  const room = makeRoom(9, { rules: { firstNightWitchSelfHeal: ruleOn } });
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  confirmRoles(room);
  const witch = room._livePlayers().find(p => p.role === 'witch');
  room.day = dayNum;
  room.phase = 'nightWitch';
  room.night = {
    day: dayNum, wolfVotes: {}, wolfTarget: witch.seat, wolfRevote: false,
    guardTarget: null, seerTarget: null, seerResult: null,
    witchHeal: null, witchPoison: null, deaths: [],
  };
  return room.submitNightAction(witch.playerId, { type: 'witchAct', kind: 'heal', target: witch.seat });
}

test('女巫首夜可自救，过了第一夜不能再自救', () => {
  assert.ok(!tryWitchSelfHeal(1, true).error, '首夜应能自救');
  for (const d of [2, 3, 4]) {
    const res = tryWitchSelfHeal(d, true);
    assert.ok(res.error, `第 ${d} 夜不该能自救`);
    assert.match(res.error, /不能救自己/);
  }
});

test('关闭「首夜可自救」后，首夜也不能自救', () => {
  for (const d of [1, 2]) {
    assert.ok(tryWitchSelfHeal(d, false).error, `规则关闭时第 ${d} 夜不该能自救`);
  }
});

test('女巫救别人不受夜次限制', () => {
  const room = makeRoom(9, {});
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  confirmRoles(room);
  const witch = room._livePlayers().find(p => p.role === 'witch');
  const other = room._livePlayers().find(p => p.playerId !== witch.playerId);
  room.day = 3;                       // 第三夜
  room.phase = 'nightWitch';
  room.night = {
    day: 3, wolfVotes: {}, wolfTarget: other.seat, wolfRevote: false,
    guardTarget: null, seerTarget: null, seerResult: null, witchHeal: null, witchPoison: null, deaths: [],
  };
  assert.ok(!room.submitNightAction(witch.playerId, { type: 'witchAct', kind: 'heal', target: other.seat }).error,
    '救别人不该受「仅首夜」的限制——那条只针对自救');
});

// ---------- 狼人自爆 ----------

/** 造一个已开局、可指定角色板的房间。 */
function startedRoom(count, opts = {}) {
  // 复用 setupRoom：法官模式下房主是法官、不占座位，自己写一套容易漏
  const room = setupRoom(count, opts);
  room.start();
  confirmRoles(room);
  return room;
}

const firstWolf = (room) => room._liveWolves()[0];

test('自爆时机：白天可以，夜晚不行', () => {
  seedRandom(81);
  const room = startedRoom(9);
  const wolf = firstWolf(room);

  // 夜晚各阶段一律拒绝
  for (const ph of NIGHT_PHASES) {
    room.phase = ph;
    const res = room.blast(wolf.playerId);
    assert.ok(res.error, `${ph} 阶段不该能自爆`);
    assert.match(res.error, /白天/);
  }

  // 白天各阶段都允许（含投票阶段）
  for (const ph of ['sheriffDeclare', 'sheriffSpeech', 'sheriffVote', 'sheriffPk', 'dayTalk', 'dayVote', 'votePk']) {
    room.phase = ph;
    assert.equal(room._blastAllowed(), true, `${ph} 应允许自爆`);
  }
  restoreRandom();
});

test('普通狼人自爆：翻牌、出局、没有遗言、当天立刻进黑夜', () => {
  seedRandom(82);
  const room = startedRoom(9);
  room.phase = 'dayTalk';
  const wolf = firstWolf(room);
  const others = room._livePlayers().length;

  const res = room.blast(wolf.playerId);
  assert.equal(res.ok, true);
  assert.ok(!res.error);

  const p = room._playerAt(wolf.seat);
  assert.equal(p.alive, false, '应立即出局');
  assert.equal(p.revealed, true, '自爆必须翻牌亮明身份');
  assert.equal(room._livePlayers().length, others - 1, '只死自爆者一人，不带走旁人');

  assert.ok(!room.pendingDay.some(e => e.type === 'lastWords'), '自爆者不该有遗言');
  // 跳到夜晚且没经过遗言/白天发言阶段，就说明「当天白天立刻结束」生效了
  assert.ok(room.phase.startsWith('night'), `应直接进入黑夜，实际 ${room.phase}`);
  assert.notEqual(room.phase, 'lastWords');
  assert.notEqual(room.phase, 'dayTalk');
  assert.ok(room.news.some(n => n.text.includes('自爆')), '应有自爆播报');
  restoreRandom();
});

test('投票阶段自爆：投票作废，不公布放逐结果', () => {
  seedRandom(83);
  const room = startedRoom(9);
  room.phase = 'dayVote';
  room.voteState = { votes: new Map(), pkCandidates: [] };

  // 先投几票，再自爆
  const wolf = firstWolf(room);
  const voters = room._voteEligible().filter(p => p.playerId !== wolf.playerId).slice(0, 3);
  const target = room._livePlayers().find(p => p.seat !== wolf.seat && p.role !== 'wolf');
  for (const v of voters) room.exileVote(v.playerId, target.seat);
  assert.ok(room.voteState.votes.size > 0, '前提：已有票');

  const victimSeat = target.seat;
  room.blast(wolf.playerId);

  assert.equal(room.voteState, null, '投票应作废');
  assert.ok(room.phase.startsWith('night'), '应直接进入黑夜');
  assert.equal(room._playerAt(victimSeat).alive, true, '被投票的人不该因这次投票出局');
  restoreRandom();
});

test('自爆的狼不能参与当晚刀人', () => {
  seedRandom(84);
  const room = startedRoom(9);
  room.phase = 'dayTalk';
  const wolf = firstWolf(room);
  const seat = wolf.seat;
  const before = room._liveWolves().length;

  room.blast(wolf.playerId);
  assert.ok(room.phase.startsWith('night'));
  assert.equal(room._liveWolves().length, before - 1, '自爆者应从狼队中移除');
  assert.ok(!room._liveWolves().some(w => w.seat === seat), '自爆者不能参与当晚刀人');

  // 引擎层面也拒绝他的刀人提交
  assert.ok(room.submitNightAction(wolf.playerId, { type: 'wolfKill', target: room._livePlayers()[0].seat }).error);
  restoreRandom();
});

test('最后一只狼自爆 → 好人直接获胜', () => {
  seedRandom(85);
  const room = startedRoom(9, { roles: { wolf: 1, villager: 5, seer: 1, witch: 1, hunter: 1 } });
  room.phase = 'dayTalk';
  assert.equal(room._liveWolves().length, 1);
  room.blast(firstWolf(room).playerId);
  assert.ok(room.gameOver, '应判定胜负');
  assert.equal(room.gameOver.winners, 'good', '狼人全灭 → 好人胜');
  restoreRandom();
});

test('白狼王自爆必须带走一人；普通狼人则不带人', () => {
  seedRandom(86);
  const room = startedRoom(9, { roles: { wolf: 1, whiteWolfKing: 1, villager: 4, seer: 1, witch: 1, hunter: 1 } });
  room.phase = 'dayTalk';
  const king = room._livePlayers().find(p => p.role === 'whiteWolfKing');
  const good = room._livePlayers().find(p => p.role === 'villager');

  assert.ok(room.blast(king.playerId, 0).error, '白狼王不带目标应被拒绝');
  assert.equal(room.blast(king.playerId, good.seat).ok, true);
  assert.equal(room._playerAt(king.seat).alive, false, '白狼王应出局');
  assert.equal(room._playerAt(good.seat).alive, false, '被带走的玩家应出局');
  assert.equal(room._playerAt(good.seat).revealed, false, '被带走者不翻牌');
  restoreRandom();
});

test('好人不能自爆；已出局的狼也不能', () => {
  seedRandom(87);
  const room = startedRoom(9);
  room.phase = 'dayTalk';
  const villager = room._livePlayers().find(p => p.role === 'villager');
  assert.ok(room.blast(villager.playerId).error, '好人不能自爆');

  const wolf = firstWolf(room);
  wolf.alive = false;
  assert.ok(room.blast(wolf.playerId).error, '已出局的狼不能自爆');
  restoreRandom();
});

test('法官模式下自爆同样可用（自爆是玩家行动，不是法官推进）', () => {
  seedRandom(88);
  const room = startedRoom(9, { judgeMode: true });
  room.phase = 'dayTalk';
  const wolf = firstWolf(room);
  assert.equal(room.blast(wolf.playerId).ok, true);
  assert.equal(room._playerAt(wolf.seat).alive, false);
  restoreRandom();
});

// ---------- 夜间阶段掩护：不因角色出局而跳过阶段 ----------

/** 开局后先把指定角色标记为出局，再进入夜晚。 */
function nightWithDead(count, roles, deadRoles) {
  const room = makeRoom(count, roles ? { roles } : {});
  for (let i = 2; i <= count; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  for (const p of room._livePlayers()) if (deadRoles.includes(p.role)) p.alive = false;
  for (const p of room._livePlayers()) room.roleConfirm(p.playerId);
  return room;
}

/** 让当前掩护阶段「时间到」，模拟秒级心跳跑过。 */
function expireMask(room) {
  room.phaseState.maskUntil = Date.now() - 1;
  room.tick();
}

test('夜间角色出局后，它的阶段仍然出现（改为随机延迟掩护）', () => {
  const std11 = { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 };
  const seqOf = (dead) => {
    const room = nightWithDead(11, std11, dead);
    const seq = [];
    let g = 0;
    while (room.phase.startsWith('night') && g++ < 12) {
      seq.push(room.phase);
      if (room.phase === 'nightWolves') {
        const w = room._liveWolves();
        const t = room._livePlayers().find(p => !w.includes(p));
        if (t) for (const x of w) room.submitNightAction(x.playerId, { type: 'wolfKill', target: t.seat });
        else room.advance();
      } else if (room.phaseState.masked) {
        expireMask(room);
      } else {
        const role = { nightGuard: 'guard', nightWitch: 'witch', nightSeer: 'seer' }[room.phase];
        const a = room._livePlayers().find(p => p.role === role);
        if (a) room.endPhase(a.playerId); else room.advance();
      }
    }
    return seq.join(',');
  };

  const allAlive = seqOf([]);
  assert.equal(allAlive, 'nightGuard,nightWolves,nightWitch,nightSeer', '对照组');

  // 关键：任何一个角色出局，阶段序列都与全员存活时一模一样
  for (const role of ['guard', 'witch', 'seer']) {
    assert.equal(seqOf([role]), allAlive,
      `${role} 出局后阶段序列变了——这等于当众宣布该角色已死`);
  }
});

test('掩护阶段停留 3~10 秒，且时长为随机', () => {
  const std11 = { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 };
  const spans = [];
  for (let i = 0; i < 60; i++) {
    const room = nightWithDead(11, std11, ['guard']);
    assert.equal(room.phaseState.masked, true, '守卫已出局，应是掩护阶段');
    spans.push(room.phaseState.maskUntil - Date.now());
  }
  assert.ok(Math.min(...spans) >= NIGHT_MASK_MIN_MS - 50, `最短 ${Math.min(...spans)}ms 不应低于下限`);
  assert.ok(Math.max(...spans) <= NIGHT_MASK_MAX_MS + 50, `最长 ${Math.max(...spans)}ms 不应超过上限`);
  assert.ok(new Set(spans).size > 30, '时长应当是随机的，不能被算出来');
});

test('掩护阶段的内部状态不下发给客户端（否则等于直接公布死讯）', () => {
  const std11 = { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 };
  const room = nightWithDead(11, std11, ['guard']);
  const villager = room._livePlayers().find(p => p.role === 'villager');
  const pub = room.snapshot(villager.playerId).phaseState;
  assert.ok(!('masked' in pub), `公开 phaseState 不该含 masked：${JSON.stringify(pub)}`);
  assert.ok(!('maskUntil' in pub), '公开 phaseState 不该含 maskUntil');
});

test('掩护阶段没有任何人能手动结束它', () => {
  const std11 = { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 };
  const room = nightWithDead(11, std11, ['guard']);
  assert.ok(room.phaseState.masked);
  const anyone = room._livePlayers().filter(p => room._canEndPhase(p));
  assert.equal(anyone.length, 0, '没人能结束掩护阶段，只能等时间到或房主跳过');

  // 时间到 → 自动推进到下一个阶段
  expireMask(room);
  assert.equal(room.phase, 'nightWolves');
});

test('板子里没有的角色仍然跳过，不做无意义的空演', () => {
  const room = nightWithDead(9, null, []);   // 默认 8 人局没有守卫
  assert.equal(room.settings.roles.guard || 0, 0, '前提：板子里没有守卫');
  assert.equal(room.phase, 'nightWolves', '没有守卫就直接从狼人开始，不空演');
});

test('女巫两瓶药都用完时，阶段同样以掩护方式出现', () => {
  const room = nightWithDead(9, null, []);
  const witch = room._livePlayers().find(p => p.role === 'witch');
  witch.witchHealUsed = true;
  witch.witchPoisonUsed = true;
  // 重新推进到女巫阶段
  let g = 0;
  while (room.phase !== 'nightWitch' && !room.gameOver && g++ < 12) {
    if (room.phase === 'nightWolves') {
      const w = room._liveWolves();
      const t = room._livePlayers().find(p => !w.includes(p));
      if (t) for (const x of w) room.submitNightAction(x.playerId, { type: 'wolfKill', target: t.seat });
      else room.advance();
    } else if (room.phaseState.masked) {
      expireMask(room);
    } else {
      const role = { nightGuard: 'guard', nightSeer: 'seer' }[room.phase];
      const a = room._livePlayers().find(p => p.role === role);
      if (a) room.endPhase(a.playerId); else room.advance();
    }
  }
  assert.equal(room.phase, 'nightWitch', '女巫阶段仍应出现');
  assert.equal(room.phaseState.masked, true,
    '药水用尽时也要掩护——否则「女巫阶段没出现」等于告诉狼人女巫没药了');
});

// ---------- 遗言只在放逐时才有 ----------

test('夜间死亡不留遗言（回归：曾经夜里被刀的人第二天还要发言）', () => {
  seedRandom(91);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);

  const victim = room._livePlayers().find(p => !['hunter', 'seer', 'witch', 'wolf'].includes(p.role));
  playNight(room, { wolfTarget: victim.seat, seerTarget: wolfSeats(room)[0] });
  room.advance();   // 天亮播报 → 首日警长竞选
  skipSheriff(room);
  assert.equal(room._playerAt(victim.seat).alive, false, '前提：该玩家夜里被刀');

  assert.notEqual(room.phase, 'lastWords', '夜里被刀的人不该有遗言');
  restoreRandom();
});

test('猎人夜里被刀：能开枪，但没有遗言', () => {
  seedRandom(92);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const hunterSeat = seatOfRole(room, 'hunter');

  playNight(room, { wolfTarget: hunterSeat, seerTarget: wolfSeats(room)[0] });
  room.advance();     // 天亮播报 → 首日警长竞选
  skipSheriff(room);  // 竞选结束 → 公布死讯 → 猎人开枪
  assert.equal(room.phase, 'hunterShoot', '应直接进开枪阶段，不经过遗言');
  assert.ok(room.snapshot(pidAt(room, hunterSeat)).private.canShoot, '猎人本人应能开枪');
  restoreRandom();
});

test('被投票放逐仍然有遗言', () => {
  seedRandom(93);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance();  // → dayVote

  const victim = room._livePlayers().find(p => p.role !== 'hunter' && p.seat !== 1);
  for (const p of room._voteEligible()) room.exileVote(p.playerId, p.seat === victim.seat ? 0 : victim.seat);
  assert.equal(room.phase, 'lastWords', '被放逐的人必须有遗言');
  assert.equal(room.phaseState.seat, victim.seat);
  restoreRandom();
});

test('不会出现「遗言名额被夜间死者占掉」的情况', () => {
  seedRandom(94);
  const room = setupRoom(11);   // 11 人局有守卫，夜里可能多死
  room.start();
  confirmRoles(room);
  const kill = nonHunterGood(room)[0];
  playNight(room, { wolfTarget: kill, seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance();

  // 连续两次放逐，第二次也必须有遗言（旧的全局上限会在第 3 次才截断，这里验证不被夜间死者占用）
  for (let round = 0; round < 2; round++) {
    const victim = room._livePlayers().find(p => p.role !== 'hunter' && p.seat !== room.sheriff);
    if (!victim) break;
    for (const p of room._voteEligible()) room.exileVote(p.playerId, p.seat === victim.seat ? 0 : victim.seat);
    assert.equal(room.phase, 'lastWords', `第 ${round + 1} 次放逐应有遗言`);
    while (room.phase === 'lastWords' || room.phase === 'hunterShoot' || room.phase === 'sheriffHandoff') room.advance();
    if (!room.phase.startsWith('night')) break;
    playNight(room, { wolfTarget: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
    drainToDayTalk(room);
    room.advance();
  }
  restoreRandom();
});

// ---------- 猎人开枪之后的流向取决于他是怎么死的 ----------

test('猎人夜里被刀：警长竞选后开枪，开枪后应继续白天而不是进入黑夜', () => {
  seedRandom(96);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  const hunterSeat = seatOfRole(room, 'hunter');

  // 狼刀猎人；首日先竞选警长，死讯与开枪在竞选结束后
  playNight(room, { wolfTarget: hunterSeat, seerTarget: wolfSeats(room)[0] });
  assert.equal(room.phase, 'dayStart');
  room.advance();
  skipSheriff(room);
  assert.equal(room.phase, 'hunterShoot', '竞选结束、公布死讯后开枪');

  const target = aliveGood(room).find(s => s !== hunterSeat);
  room.hunterShoot(pidAt(room, hunterSeat), target);

  // 开枪之后必须继续白天（首日竞选已经完成 → 自由发言），而不是进入黑夜
  let g = 0;
  while (room.phase === 'hunterShoot' && g++ < 5) room.advance();
  assert.ok(!room.phase.startsWith('night'),
    `猎人夜里被刀、开枪后不该直接进黑夜，实际到了 ${room.phase}`);
  assert.equal(room.phase, 'dayTalk', '警长竞选已结束，应继续白天发言');
  restoreRandom();
});

test('猎人被放逐：开枪后进入黑夜（当天事务已了）', () => {
  seedRandom(97);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance();   // → dayVote

  const hunterSeat = seatOfRole(room, 'hunter');
  for (const p of room._voteEligible()) room.exileVote(p.playerId, p.seat === hunterSeat ? 0 : hunterSeat);
  assert.equal(room.phase, 'lastWords', '被放逐先留遗言');
  room.advance();
  assert.equal(room.phase, 'hunterShoot');

  const target = aliveGood(room).find(s => s !== hunterSeat);
  room.hunterShoot(pidAt(room, hunterSeat), target);
  let g = 0;
  while (room.phase === 'hunterShoot' && g++ < 5) room.advance();
  assert.ok(room.phase.startsWith('night'),
    `被放逐的猎人开枪后当天应结束进入黑夜，实际到了 ${room.phase}`);
  restoreRandom();
});

test('猎人开枪不会丢掉待处理的警徽移交', () => {
  seedRandom(98);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainToDayTalk(room);
  room.advance();

  // 把猎人设为警长后放逐他
  const hunterSeat = seatOfRole(room, 'hunter');
  room.sheriff = hunterSeat;
  for (const p of room._voteEligible()) room.exileVote(p.playerId, p.seat === hunterSeat ? 0 : hunterSeat);
  room.advance();   // 遗言 → 开枪
  assert.equal(room.phase, 'hunterShoot');

  const target = aliveGood(room).find(s => s !== hunterSeat);
  room.hunterShoot(pidAt(room, hunterSeat), target);
  let g = 0;
  while (room.phase === 'hunterShoot' && g++ < 5) room.advance();

  // 猎人（警长）死后警徽必须处理：移交阶段或者已经处理完（sheriff 被清空）
  assert.ok(room.phase === 'sheriffHandoff' || room.sheriff === null,
    `警长的警徽不该被丢掉，实际阶段 ${room.phase}，sheriff=${room.sheriff}`);
  restoreRandom();
});

// ---------- 警长竞选：警下无人时的处理 ----------

test('全员上警 → 警徽流失、本局无警长，直接进入白天（回归：曾经卡死在投票阶段）', () => {
  seedRandom(101);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);
  assert.equal(room.phase, 'sheriffDeclare');

  const alive = room._livePlayers();
  for (const p of alive) room.setDeclaration(p.playerId, true);   // 全员上警

  // 警下 0 人 → 没人有投票权，应该直接判警徽流失
  assert.equal(room.phase, 'dayTalk',
    `全员上警后不该停在竞选流程里（实际 ${room.phase}）——投票阶段会因无人可投而永久卡住`);
  assert.equal(room.sheriff, null, '本局无警长');
  assert.ok(room.news.some(n => n.text.includes('警徽流失')),
    `应播报警徽流失，实际播报：${room.news.map(n => n.text).join(' | ')}`);
  restoreRandom();
});

test('部分人上警时警长竞选照常进行', () => {
  seedRandom(102);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);

  const alive = room._livePlayers();
  const podium = alive.slice(0, 3).map(p => p.seat);
  for (const p of alive) room.setDeclaration(p.playerId, podium.includes(p.seat));

  assert.equal(room.phase, 'sheriffSpeech', '有人警下时应正常进入竞选发言');
  assert.ok(room._sheriffVoters().length > 0, '警下应有投票权玩家');
  restoreRandom();
});

test('无人上警 → 直接进入白天，无警长', () => {
  seedRandom(103);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);

  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, false);
  assert.equal(room.phase, 'dayTalk', '没人上警就直接进入白天');
  assert.equal(room.sheriff, null);
  restoreRandom();
});

test('全员上警后不会留下无法推进的阶段', () => {
  seedRandom(104);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  playNight(room, { wolfTarget: nonHunterGood(room)[0], witchHeal: nonHunterGood(room)[0], seerTarget: wolfSeats(room)[0] });
  drainDay(room);
  for (const p of room._livePlayers()) room.setDeclaration(p.playerId, true);

  // 核心：必须已经离开竞选阶段。任何「没人有投票权」的阶段都无法被推进。
  assert.ok(!['sheriffSpeech', 'sheriffVote', 'sheriffPk'].includes(room.phase),
    `不应停在 ${room.phase} —— 那些阶段需要有人操作才能推进`);
  assert.equal(room.phase, 'dayTalk');
  restoreRandom();
});

// ---------- 测试模式跳过「确认身份」 ----------

test('正式模式：开局停在确认身份阶段（默认行为不变）', () => {
  seedRandom(111);
  const room = setupRoom(9);
  room.start();
  assert.equal(room.phase, 'roleReveal', '默认应保留确认身份阶段');
  assert.ok(room._livePlayers().every(p => p.role), '角色应已发放');
  restoreRandom();
});

test('测试模式：跳过确认身份直接进夜晚，但角色照常发放', () => {
  seedRandom(112);
  const room = makeRoom(9, {});
  room.skipRoleReveal = true;
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();

  assert.ok(room.phase.startsWith('night'), `应直接进入夜晚，实际 ${room.phase}`);
  const lived = room._livePlayers();
  assert.ok(lived.every(p => p.role), '跳过的只是「点确认」这一步，角色必须照常发下去');
  assert.ok(room.news.some(n => n.text.includes('跳过确认身份')),
    '播报里应写明跳过了确认身份，避免被误认为漏了流程');

  // 狼人配置仍然正确（3 狼）
  assert.equal(room._liveWolves().length, 3);
  restoreRandom();
});

test('跳过确认身份的设置只影响开局那一步，重开一局仍然有效', () => {
  seedRandom(113);
  const room = makeRoom(9, {});
  room.skipRoleReveal = true;
  for (let i = 2; i <= 9; i++) { room.addPlayer(`p${i}`, `玩家${i}`); room.sit(`p${i}`, i); }
  room.sit('HOST', 1);
  room.start();
  assert.ok(room.phase.startsWith('night'));

  room.resetGame('HOST');
  assert.equal(room.phase, 'lobby');
  // 重开后座位被清空（见 resetGame），必须先重新入座才能开始
  for (let i = 2; i <= 9; i++) room.sit(`p${i}`, i);
  room.sit('HOST', 1);
  assert.equal(room.start().ok, true);
  assert.ok(room.phase.startsWith('night'), '重开一局也应跳过确认身份');
  restoreRandom();
});

// ---------- 结算后回房间重开 ----------

test('回到房间会清空座位，所有人重新选座', () => {
  seedRandom(121);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  room.gameOver = { winners: 'good' };
  room.phase = 'gameOver';

  assert.equal(room._livePlayers().length, 9, '前提：满员入座');

  assert.equal(room.resetGame('HOST').ok, true);
  assert.equal(room.phase, 'lobby');
  assert.equal([...room.players.values()].filter(p => p.seat).length, 0, '座位应全部清空');
  assert.ok(room.seatMap.every(x => x === null), 'seatMap 也应一并清空');
  assert.ok([...room.players.values()].every(p => p.role === null), '角色应回收');
  assert.ok(!room.canStart().ok, '没人入座时不能开局');

  // 重新入座后可以再开一局
  for (let i = 2; i <= 9; i++) room.sit(`p${i}`, i);
  room.sit('HOST', 1);
  assert.equal(room.canStart().ok, true, '重新入座后应可开局');
  assert.equal(room.start().ok, true);
  assert.equal(room.phase, 'roleReveal');
  restoreRandom();
});

test('回到房间后可以换座位（清空座位的目的）', () => {
  seedRandom(122);
  const room = setupRoom(9);
  room.start();
  confirmRoles(room);
  room.gameOver = { winners: 'wolf' };
  room.resetGame('HOST');

  // 原来 3 号坐 3 号位，现在换到 7 号
  assert.equal(room.sit('p3', 7).ok, true, '座位清空后应能换到别的座位');
  assert.equal(room._seatOf('p3'), 7);
  restoreRandom();
});

test('非房主不能触发重开', () => {
  const room = setupRoom(9);
  room.start();
  room.gameOver = { winners: 'good' };
  assert.ok(room.resetGame('p2').error, '只有房主/法官能重开');
  assert.notEqual(room.phase, 'lobby');
});

// ---------- 换座 / 离开座位 ----------

test('已入座的人可以直接换到别的空位（引擎自动让出旧座位）', () => {
  const room = setupRoom(9);
  assert.equal(room._seatOf('p3'), 3);
  assert.equal(room.standUp('p9').ok, true, '先腾出一个空位');

  assert.equal(room.sit('p3', 9).ok, true, '可直接换座，不需要先起立');
  assert.equal(room._seatOf('p3'), 9);
  assert.equal(room.seatMap[3], null, '旧座位必须被释放，否则会凭空占着两个位置');
  assert.equal(room.seatMap[9], 'p3');
});

test('离开座位后回到「等待选座」，可以重新坐下', () => {
  const room = setupRoom(9);
  assert.equal(room.standUp('p5').ok, true);
  assert.equal(room._seatOf('p5'), null);
  assert.equal(room.seatMap[5], null);

  const snap = room.snapshot('HOST');
  assert.ok(snap.waiting.some(w => w.playerId === 'p5'),
    '离开座位的人应回到等待区，界面才能提示他还没入座');

  assert.equal(room.sit('p5', 5).ok, true, '应能重新坐回原座位');
  assert.equal(room._seatOf('p5'), 5);
});

test('离开座位后别人可以坐那个位置', () => {
  const room = setupRoom(9);
  room.standUp('p5');
  assert.equal(room.sit('p2', 5).ok, true, '空出来的座位别人可以坐');
  assert.equal(room._seatOf('p2'), 5);
  assert.equal(room.seatMap[2], null, 'p2 的旧座位也应释放');
});

test('座位边界：不能占别人的位置、也不能重复离开', () => {
  const room = setupRoom(9);
  assert.ok(room.sit('p2', 3).error, '不能坐别人已占的座位');
  room.standUp('p5');
  assert.ok(room.standUp('p5').error, '已经没座位了，再离开应被拒绝');
  assert.match(room.standUp('p5').error, /还没有入座/);
});

test('开局后不能离开座位或换座', () => {
  seedRandom(131);
  const room = setupRoom(9);
  room.start();
  assert.ok(room.standUp('p3').error, '开局后不能起立——座位与身份会脱节');
  assert.match(room.standUp('p3').error, /游戏已开始/);
  assert.ok(room.sit('p3', 3).error, '开局后也不能换座');
  restoreRandom();
});
