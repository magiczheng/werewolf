import test from 'node:test';
import assert from 'node:assert/strict';
import { Room, buildSettings } from '../server/engine.js';
import { serializeRoom, restoreRoom, createRoomStore } from '../server/roomStore.js';
import { openDb } from '../server/db.js';

function setup(judgeMode = false) {
  const room = new Room({ code: 'AUDIT1', settings: buildSettings({ playerCount: 9, judgeMode,
    roles: { wolf: 3, villager: 2, seer: 1, witch: 1, hunter: 1, idiot: 1 } }),
  hostPlayerId: judgeMode ? 'judge' : 'p1', hostName: '房主' });
  for (let i = 1; i <= 9; i++) { if (judgeMode || i !== 1) room.addPlayer('p' + i, '玩家' + i); room.sit('p' + i, i); }
  room.start();
  ['wolf', 'wolf', 'wolf', 'villager', 'villager', 'seer', 'witch', 'hunter', 'idiot'].forEach((role, i) => room.players.get('p' + (i + 1)).role = role);
  return room;
}

test('翻牌白痴不能再被普通票或 PK 票放逐', () => {
  const room = setup(); room._doExile(9); room._enterDayVote();
  assert.match(room.exileVote('p1', 9).error, /不能被放逐/);
  room.phase = 'votePk'; room.voteState.pkCandidates = [8, 9];
  assert.match(room.exileVote('p1', 9).error, /不能被放逐/);
  room._doExile(9); assert.equal(room.players.get('p9').alive, true);
});

test('退水不跳过下一位候选人，已发言者不会重复发言', () => {
  const room = setup(); room.phase = 'sheriffSpeech';
  room.sheriffState = { onPodium: new Set([1, 2, 3, 4]), withdrawn: new Set(), votes: new Map(), pkCandidates: [] };
  room.phaseState = { candidates: [1, 2, 3, 4], speakerIndex: 0, speakerSeat: 1 };
  room.setDeclaration('p1', false); room.endPhase('p1'); assert.equal(room.phaseState.speakerSeat, 2);
  room.setDeclaration('p4', false); room.endPhase('p2'); assert.equal(room.phaseState.speakerSeat, 3);
  room.endPhase('p3'); assert.equal(room.phase, 'sheriffVote');
});

test('法官模式女巫同夜单药，下一夜仍可使用另一瓶', () => {
  const room = setup(true); room.phase = 'nightWitch'; room.day = 1;
  room.night = { day: 1, wolfVotes: {}, wolfTarget: 4, witchHeal: null, witchPoison: null };
  assert.equal(room.submitNightAction('p7', { type: 'witchAct', kind: 'heal', target: 4 }).ok, true);
  assert.match(room.submitNightAction('p7', { type: 'witchAct', kind: 'poison', target: 5 }).error, /一种药水/);
  assert.equal(room.players.get('p7').witchPoisonUsed, false);
  room.night = { day: 2, wolfVotes: {}, wolfTarget: 4, witchHeal: null, witchPoison: null }; room.day = 2;
  assert.equal(room.submitNightAction('p7', { type: 'witchAct', kind: 'poison', target: 5 }).ok, true);
});

test('神职和白狼王限一人，规则参数拒绝注入与非法类型', () => {
  assert.throws(() => buildSettings({ playerCount: 9, roles: { wolf: 3, villager: 3, seer: 2, witch: 1 } }), /最多 1/);
  for (const rules of [{ killSide: 'false' }, { sheriffVoteWeight: -99 }, { sheriffVoteWeight: Infinity }, { evil: true }]) {
    assert.throws(() => buildSettings({ playerCount: 9, rules }));
  }
  assert.throws(() => buildSettings({ playerCount: 9, roles: { wolf: 3, villager: 7, seer: -1 } }));
});

test('大厅房主离开后自动移交，满员房间仍可开始', () => {
  const room = setup(); room.resetGame('p1'); room.leave('p1');
  assert.equal(room.hostPlayerId, 'p2');
  room.addPlayer('p10', '新成员'); const ids = [...room.players.keys()];
  ids.forEach((pid, i) => room.sit(pid, i + 1));
  assert.equal(room.start().ok, true);
});

test('开局后保留离线座位；房主离线满一分钟才允许接任', () => {
  const room = setup(); assert.match(room.leave('p1').error, /对局进行中/);
  room.setConnected('p1', false); assert.ok(room.claimHost('p2').error);
  room.players.get('p1').disconnectedAt = Date.now() - 60001;
  assert.equal(room.claimHost('p2').ok, true); assert.equal(room.hostPlayerId, 'p2');
  assert.equal(room.players.get('p1').seat, 1);
});

test('对局中不得把法官身份移交给玩家，避免泄露全部身份', () => {
  const room = setup(true); assert.ok(room.transferHost('judge', 'p2').error);
  room.setConnected('judge', false); room.players.get('judge').disconnectedAt = Date.now() - 120000;
  assert.equal(room.canClaimHost('p2'), false);
});

test('离线处理需房主确认且等待满一分钟，在线选择不受影响', () => {
  const room = setup(); room._enterDayVote(); room.exileVote('p2', 4); room.setConnected('p3', false);
  assert.ok(room.recoverOffline('p1').error);
  room.players.get('p3').disconnectedAt = Date.now() - 60001;
  assert.ok(room.recoverOffline('p2').error);
  assert.equal(room.recoverOffline('p1').ok, true);
  assert.equal(room.voteState.votes.get('p3'), 0); assert.equal(room.voteState.votes.get('p2'), 4);
});

test('对局存档保留 Map、Set、药水、身份、待处理事件及去重回执', () => {
  const room = setup(true); room.phase = 'sheriffVote';
  room.sheriffState = { onPodium: new Set([1, 2]), withdrawn: new Set([3]), votes: new Map([['p4', 2]]), pkCandidates: [] };
  room.voteState = { votes: new Map([['p5', 1]]), pkCandidates: [1] };
  room.pendingDay = [{ type: 'hunterShoot', seat: 8 }]; room.players.get('p7').witchHealUsed = true;
  room.receipts.set('request', { ok: true });
  const restored = restoreRoom(serializeRoom(room), () => {});
  assert.deepEqual([...restored.sheriffState.onPodium], [1, 2]);
  assert.equal(restored.sheriffState.votes.get('p4'), 2); assert.equal(restored.voteState.votes.get('p5'), 1);
  assert.equal(restored.players.get('p7').witchHealUsed, true); assert.equal(restored.players.get('p7').connected, false);
  assert.deepEqual(restored.pendingDay, room.pendingDay); assert.deepEqual(restored.receipts.get('request'), { ok: true });
  assert.equal(restored.gameId, room.gameId); assert.equal(restored.phaseId, room.phaseId);
  assert.equal(restored.snapshot('p4').judge.players, undefined);
});

test('存档持久化可加载且房间状态相互独立', () => {
  const db = openDb(':memory:'); const store = createRoomStore(db); const room = setup(); store.save(room);
  const loaded = createRoomStore(db).load(); assert.equal(loaded.length, 1); assert.equal(loaded[0]._playerAt(6).role, 'seer');
  loaded[0].players.get('p6').seerHistory.push({ seat: 1, camp: 'wolf' });
  assert.equal(room.players.get('p6').seerHistory.length, 0); store.remove(room.code); assert.equal(store.load().length, 0); db.close();
});

test('夜间行动仅在结算复盘揭示；完成投票才公开票型', () => {
  const room = setup(true); room.phase = 'nightSeer'; room.night = { day: 1, wolfVotes: {} }; room.day = 1;
  room.submitNightAction('p6', { type: 'seerCheck', target: 1 });
  assert.equal(room.snapshot('p4').replay, null);
  room.judgeCommand('judge', 'endGame', { camp: 'good' });
  assert.ok(room.snapshot('p4').replay.some(item => /查验 1号：狼人/.test(item.text)));
  const next = setup(); next._enterDayVote(); next.exileVote('p1', 4); assert.equal(next.snapshot('p2').voteHistory.length, 0);
  for (let i = 2; i <= 9; i++) next.exileVote('p' + i, i === 4 ? 5 : 4);
  assert.equal(next.snapshot('p2').voteHistory.length, 1); assert.equal(next.voteHistory[0].ballots.length, 9);
});

test('放逐 PK 排除所有 PK 玩家，服务端与私有资格保持一致', () => {
  const room = setup(); room.phase = 'votePk';
  room.voteState = { votes: new Map(), pkCandidates: [4, 5] };
  for (const seat of [4, 5]) {
    assert.match(room.exileVote('p' + seat, 0).error, /PK 玩家/);
    assert.equal(room.snapshot('p' + seat).private.canVote, false);
  }
  assert.deepEqual(room._voteEligible().map(p => p.seat), [1, 2, 3, 6, 7, 8, 9]);
  const activity = room.snapshot('p1').activity;
  assert.equal(activity.total, 7);
  assert.equal(activity.seats.find(p => p.seat === 4).state, 'excluded');
  room.exileVote('p1', 4);
  assert.equal(room.snapshot('p2').activity.seats.find(p => p.seat === 1).label, '已投票');
  assert.equal(JSON.stringify(room.snapshot('p2').activity).includes('target'), false);
});

test('退水保留上警历史，不获得普通警长票或 PK 票，存档恢复仍有效', () => {
  const room = setup(); room.phase = 'sheriffDeclare'; room._initSheriffState();
  room.setDeclaration('p1', true); room.setDeclaration('p1', false);
  room.setDeclaration('p2', true); room.setDeclaration('p3', true);
  for (let i = 4; i <= 9; i++) room.setDeclaration('p' + i, false);
  assert.equal(room.phaseState.speakerSeat, 2);
  room.endPhase('p2'); room.endPhase('p3');
  assert.equal(room.phase, 'sheriffVote');
  assert.equal(room.snapshot('p1').private.sheriffCanVote, false);
  assert.equal(room.snapshot('p4').private.sheriffCanVote, true);
  assert.match(room.sheriffVote('p1', 2).error, /退水/);
  const restored = restoreRoom(serializeRoom(room), () => {});
  assert.equal(restored.snapshot('p1').private.sheriffCanVote, false);
  restored.phase = 'sheriffPk'; restored.sheriffState.pkCandidates = [2, 3];
  assert.match(restored.sheriffVote('p1', 0).error, /退水/);
});

test('当前发言者退水直接轮到下一人，不等待其再次结束发言', () => {
  const room = setup(); room.phase = 'sheriffSpeech';
  room.sheriffState = { onPodium: new Set([1, 2, 3]), withdrawn: new Set(), votes: new Map(), pkCandidates: [] };
  room.phaseState = { candidates: [1, 2, 3], speechOrder: [1, 2, 3], speakerSeat: 1 };
  room.setDeclaration('p1', false);
  assert.equal(room.phaseState.speakerSeat, 2);
  assert.match(room.endPhase('p1').error, /发言者/);
  assert.equal(room.snapshot('p4').activity.seats.find(p => p.seat === 2).state, 'speaking');
});

test('全部存活者进入放逐 PK 时，无可投者直接平安日，不能卡死', () => {
  const room = setup(); room.phase = 'dayVote';
  room.voteState = { votes: new Map(), pkCandidates: [] };
  for (let seat = 1; seat <= 9; seat++) room.exileVote('p' + seat, seat === 9 ? 1 : seat + 1);
  assert.ok(room.phase.startsWith('night'));
  assert.equal(room.voteHistory.at(-1).kind, '放逐 PK');
  assert.deepEqual(room.voteHistory.at(-1).ballots, []);
});

test('夜间行动进度不向无关玩家公开操作者；狼人只看到自己队伍', () => {
  const room = setup(); room.phase = 'nightWolves';
  room.night = { wolfVotes: { 1: 4 } };
  assert.deepEqual(room.snapshot('p4').activity.seats, []);
  assert.deepEqual(room.snapshot('p1').activity.seats.map(p => p.seat), [1, 2, 3]);
  room.phase = 'nightSeer';
  assert.deepEqual(room.snapshot('p4').activity.seats, []);
  assert.deepEqual(room.snapshot('p6').activity.pending, [6]);
  room.phase = 'hunterShoot'; room.phaseState = { seat: 8 };
  assert.deepEqual(room.snapshot('p4').activity.seats, []);
  assert.deepEqual(room.snapshot('p8').activity.pending, [8]);
});

test('法官模式守卫不能同夜重复操作，目标状态仅本人可见', () => {
  const room = setup(true); room.players.get('p6').role = 'guard'; room.phase = 'nightGuard';
  room.night = { guardTarget: null };
  assert.equal(room.submitNightAction('p6', { type: 'guardProtect', target: 4 }).ok, true);
  assert.match(room.submitNightAction('p6', { type: 'guardProtect', target: 5 }).error, /已完成守护/);
  assert.equal(room.snapshot('p6').private.guardTarget, 4);
  assert.equal(room.snapshot('p4').private.guardTarget, null);
});

test('白天发言可由房主标记，其他人不能抢麦，结束后全场看到已发言', () => {
  const room = setup(); room.phase = 'dayTalk'; room.phaseState = {};
  assert.match(room.setSpeaker('p2', 4).error, /房主/);
  assert.equal(room.setSpeaker('p1', 4).ok, true);
  assert.equal(room.snapshot('p5').activity.seats.find(p => p.seat === 4).state, 'speaking');
  assert.match(room.finishSpeech('p5').error, /未轮到你/);
  assert.equal(room.snapshot('p4').private.canEndSpeech, true);
  assert.equal(room.finishSpeech('p4').ok, true);
  assert.equal(room.snapshot('p5').activity.seats.find(p => p.seat === 4).label, '已发言');
  room.setSpeaker('p1', 5);
  assert.equal(room.phaseState.speakerSeat, 5);
  assert.equal(room.phase, 'dayTalk');
  room.endPhase('p1'); assert.equal(room.phase, 'dayVote');
});

test('PK 目标死亡后不能继续投给它，法官不能冒充玩家确认身份', () => {
  const room = setup(true);
  assert.match(room.roleConfirm('judge').error, /无效玩家/);
  room.phase = 'votePk'; room.voteState = { votes: new Map(), pkCandidates: [4, 5] };
  room.players.get('p4').alive = false;
  assert.match(room.exileVote('p1', 4).error, /目标无效/);
  room.phase = 'sheriffPk'; room.sheriffState = { onPodium: new Set([4, 5]), withdrawn: new Set(), votes: new Map(), pkCandidates: [4, 5] };
  assert.match(room.sheriffVote('p1', 4).error, /目标无效/);
});
