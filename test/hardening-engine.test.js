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
