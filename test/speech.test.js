// 语音播报：验证「念什么、谁来念、不重复念」。
// 用带语音桩的 DOM 环境（installDom({ speech: true })）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const env = (await import('./helpers/dom.js')).installDom({ speech: true });
const speech = await import('../public/js/speech.js');

const snap = (o = {}) => ({
  roomCode: o.roomCode || 'ROOM1',
  me: { isHost: o.isHost !== false, isJudge: !!o.isJudge },
  news: o.news || [],
});
const news = (...items) => items.map((text, i) => ({ id: i + 1, t: 0, text }));

describe('语音播报', () => {
  test('环境支持语音合成（桩已装好）', () => {
    assert.equal(speech.supported(), true);
  });

  test('房主是解说员；普通玩家不是', () => {
    assert.equal(speech.isNarrator(snap({ isHost: true })), true);
    assert.equal(speech.isNarrator(snap({ isHost: false })), false);
    assert.equal(speech.isNarrator(snap({ isHost: false, isJudge: true })), true, '法官模式下法官也是解说员');
    assert.equal(speech.isNarrator(null), false);
  });

  test('念出新增的播报，且同一条不会重复念', () => {
    speech.resetVoice();
    const s = snap();
    assert.equal(speech.speakNew(s, news('天黑请闭眼')), 1);
    assert.deepEqual(env.spoken(), ['天黑请闭眼']);

    // 同一条再推一次（服务端重复广播）→ 不该再念
    assert.equal(speech.speakNew(s, news('天黑请闭眼')), 0);
    assert.deepEqual(env.spoken(), ['天黑请闭眼']);

    // 新增一条 → 只念新的那条
    assert.equal(speech.speakNew(s, news('天黑请闭眼', '狼人请睁眼')), 1);
    assert.deepEqual(env.spoken(), ['天黑请闭眼', '狼人请睁眼']);
  });

  test('播报被裁剪掉头部后仍不重复念（靠 id 而不是下标）', () => {
    speech.resetVoice();
    const s = snap();
    speech.speakNew(s, news('A', 'B', 'C'));       // id 1,2,3
    // 模拟 40 条上限裁剪：头部被丢掉，下标整体前移，但 id 保持递增
    const trimmed = [{ id: 2, text: 'B' }, { id: 3, text: 'C' }, { id: 4, text: 'D' }];
    assert.equal(speech.speakNew(s, trimmed), 1, '只应念 id 更大的那条');
    assert.deepEqual(env.spoken().slice(-1), ['D']);
  });

  test('普通玩家设备不出声，但游标照常推进', () => {
    speech.resetVoice();
    env.spoken().length = 0;
    const player = snap({ isHost: false });
    assert.equal(speech.speakNew(player, news('天黑请闭眼')), 0, '非解说员设备不朗读');
    assert.deepEqual(env.spoken(), []);

    // 关键：游标已推进，之后就算这台设备成了解说员，也不会把旧播报补念一遍
    const host = snap({ isHost: true });
    assert.equal(speech.speakNew(host, news('天黑请闭眼')), 0);
    assert.equal(speech.speakNew(host, news('天黑请闭眼', '狼人请睁眼')), 1);
    assert.deepEqual(env.spoken(), ['狼人请睁眼']);
  });

  test('静音时不出声，重新开启后不补念攒下的旧播报', () => {
    speech.resetVoice();
    env.spoken().length = 0;
    speech.setEnabled(false);
    const s = snap();
    assert.equal(speech.speakNew(s, news('A', 'B')), 0, '静音时不朗读');
    assert.deepEqual(env.spoken(), []);

    speech.setEnabled(true);
    assert.equal(speech.speakNew(s, news('A', 'B', 'C')), 1);
    assert.deepEqual(env.spoken(), ['C'], '只念静音期间之后新增的那条');
  });

  test('换房间时游标重置，新房间的播报从第一条开始念', () => {
    speech.resetVoice();
    env.spoken().length = 0;
    speech.speakNew(snap({ roomCode: 'ROOM1' }), news('旧房间的播报'));

    // 新房间的 id 又是从 1 开始的
    const s2 = snap({ roomCode: 'ROOM2' });
    assert.equal(speech.speakNew(s2, news('新房间的播报')), 1);
    assert.deepEqual(env.spoken().slice(-1), ['新房间的播报']);
  });

  test('没有 id 的播报条目被忽略（兼容旧数据）', () => {
    speech.resetVoice();
    env.spoken().length = 0;
    const s = snap();
    assert.equal(speech.speakNew(s, [{ text: '没有 id 的老格式' }]), 0);
    assert.deepEqual(env.spoken(), []);
  });

  test('默认开启朗读，可持久化关闭', () => {
    speech.setEnabled(true);
    assert.equal(speech.enabled(), true);
    speech.setEnabled(false);
    assert.equal(speech.enabled(), false);
    speech.setEnabled(true);
    assert.equal(speech.enabled(), true);
  });
});
