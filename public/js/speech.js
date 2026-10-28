// 语音播报：用浏览器内置的 SpeechSynthesis 念出播报内容。
// 零依赖、不联网、离线可用（走操作系统自带的语音引擎）。
//
// 只在「解说员设备」上朗读——房主（法官模式下即法官）那一台。
// 一屋子 9 部手机同时念旁白是灾难，线下游戏本来就是一个人念旁白。
// 其他设备上的开关自动隐藏，也就无从开启。
//
// 判断「哪些是新的」用的是播报条目自带的单调 id，不是数组下标：
// 播报上限 40 条、满了会从头部裁掉，下标会整体错位。
//
// 移动端要点：
//   1. iOS / Android 都要求至少一次用户手势才允许语音合成；这里在首次
//      pointerdown / touchend / keydown 时用一条 0 音量的空语音「解锁」。
//   2. 不要在一个同步循环里连续 speak 多条——移动端会丢句。这里改成
//      逐句串行：上一句 onend / onerror 之后再念下一句。
//   3. 句子之间留停顿。夜间「X 请闭眼」之后停 2.2 秒，再让下一位「请睁眼」，
//      否则语音连成一串，桌上的人还没闭眼，下一位就已经睁眼了。

import { store } from './net.js';

const KEY = 'ww_voice';      // '0' 表示静音，缺省为开启

// 测试环境把停顿压到 0，避免测试等真实秒数。见 test/helpers/dom.js。
const TESTING = (() => {
  try { return !!window.__WW_TEST__; } catch (_e) { return false; }
})();

// 下一句最多等多久。正常短句 onend 很快；这个计时器是兜底，
// 防止某些移动端 onend 不触发导致整个队列永久卡住。
const MIN_WATCHDOG_MS = 5000;

let lastRoom = '';           // 记录房间：换房间时重置游标，避免把上一局的播报当新的
let lastSpokenId = 0;
let cachedVoice = null;
let voiceResolved = false;

// ---------- 播报队列 ----------
const queue = [];            // { text, gapAfter, queuedAt }
let busy = false;            // 当前是否有一句正在念
let gapTimer = null;         // 句间停顿计时器
let watchdogTimer = null;
let seq = 0;                 // 每次 speak/stop 递增，用来丢弃过期的 onend
let idleWaiters = [];

export function supported() {
  return typeof window !== 'undefined' && !!window.speechSynthesis
    && typeof window.SpeechSynthesisUtterance === 'function';
}

/** 该设备是否负责朗读：房主，或法官模式下的法官。 */
export function isNarrator(s) {
  return !!(s && s.me && (s.me.isHost || s.me.isJudge));
}

export function enabled() {
  return store.get(KEY) !== '0';
}

export function setEnabled(on) {
  store.set(KEY, on ? '1' : '0');
  if (!on) stop();
}

export function stop() {
  seq++;
  clearTimeout(gapTimer);
  clearTimeout(watchdogTimer);
  gapTimer = null;
  watchdogTimer = null;
  busy = false;
  queue.length = 0;
  try { window.speechSynthesis.cancel(); } catch (_e) { /* 忽略 */ }
  notifyIdle();
}

/** 测试用：等队列念空（浏览器里也可以用它做「播报结束」回调）。 */
export function whenIdle() {
  if (!busy && !queue.length && !gapTimer) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.push(resolve));
}

function notifyIdle() {
  if (busy || queue.length || gapTimer) return;
  const ws = idleWaiters;
  idleWaiters = [];
  for (const w of ws) w();
}

/**
 * 在用户手势里调用，解锁移动端语音合成。
 * 没有手势时多数移动浏览器会静默拒绝 speak()，桌面 Chrome 则通常允许。
 */
export function unlock() {
  if (!supported()) return;
  try { window.speechSynthesis.resume(); } catch (_e) { /* 忽略 */ }
  if (unlock.done) return;
  unlock.done = true;
  try {
    const u = new window.SpeechSynthesisUtterance(' ');
    u.lang = 'zh-CN';
    u.volume = 0;      // 只用来取得播放许可，不能真的出声
    u.rate = 2;
    window.speechSynthesis.speak(u);
  } catch (_e) { /* 不支持就静默降级 */ }
}

// 首次触摸 / 按键就解锁。{ once: true } 只负责少挂监听；unlock.done 保证幂等。
if (supported() && typeof window.addEventListener === 'function') {
  const once = { once: true, passive: true };
  window.addEventListener('pointerdown', unlock, once);
  window.addEventListener('touchend', unlock, once);
  window.addEventListener('keydown', unlock, once);
}

// 从后台回到前台时，部分移动端会把 speechSynthesis 留在 paused 状态。
if (supported() && typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      try { window.speechSynthesis.resume(); } catch (_e) { /* 忽略 */ }
    }
  });
}

/** 当前使用的语音名称，用于界面提示。 */
export function voiceName() {
  const v = pickVoice();
  return v ? v.name : '系统默认';
}

function pickVoice() {
  if (!supported()) return null;
  if (voiceResolved) return cachedVoice;
  const voices = window.speechSynthesis.getVoices() || [];
  if (!voices.length) return null;    // Chrome 首次调用可能返回空，等 voiceschanged
  cachedVoice = voices.find((v) => /^zh[-_]CN/i.test(v.lang))
    || voices.find((v) => /^zh/i.test(v.lang))
    || null;
  voiceResolved = true;
  return cachedVoice;
}

// Chrome 的语音列表是异步加载的，加载完会派发 voiceschanged
if (supported()) {
  try {
    window.speechSynthesis.addEventListener('voiceschanged', () => {
      voiceResolved = false;
      pickVoice();
    });
  } catch (_e) { /* 老浏览器不支持 addEventListener，忽略 */ }
}

/** 去掉 emoji 等不该被念出来的符号。 */
function cleanText(text) {
  return String(text || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 句间停顿：这是「顿挫」的核心。
 *
 * 天黑/闭眼之后要留足时间让人真的闭上眼；天亮、死亡等结果稍作停顿即可。
 */
export function gapFor(text) {
  if (/天黑请闭眼/.test(text)) return 3200;
  if (/请闭眼/.test(text)) return 2200;
  if (/请睁眼/.test(text)) return 1400;
  if (/天亮了/.test(text)) return 1800;
  if (/死亡|平安夜|被放逐|自爆|开枪|获胜|游戏结束/.test(text)) return 1200;
  if (/当选警长|警徽流失|开始竞选发言|请投票|请上警/.test(text)) return 1100;
  return 850;
}

function scheduleGap(fn, ms) {
  return setTimeout(fn, TESTING ? 0 : ms);
}

function pump() {
  if (busy || gapTimer || !queue.length) { notifyIdle(); return; }

  // 跳过已经过时的播报：手机息屏几分钟后醒来，不该再念上一局的「请睁眼」。
  const now = Date.now();
  while (queue.length && now - queue[0].queuedAt > 15000) queue.shift();
  if (!queue.length) { notifyIdle(); return; }

  const item = queue.shift();
  const mySeq = ++seq;
  busy = true;

  let finished = false;
  const finish = () => {
    if (finished || mySeq !== seq) return;
    finished = true;
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
    busy = false;
    if (queue.length) {
      gapTimer = scheduleGap(() => {
        gapTimer = null;
        pump();
      }, item.gapAfter);
    } else {
      notifyIdle();
    }
  };

  // onend 不触发时的兜底（部分 iOS 版本会遇到）。
  // 必须在 speak() 之前设置：测试桩 / 某些实现会同步触发 onend。
  const maxMs = TESTING ? 50 : Math.max(MIN_WATCHDOG_MS, item.text.length * 500 + 3000);
  watchdogTimer = setTimeout(finish, maxMs);

  try {
    const u = new window.SpeechSynthesisUtterance(item.text);
    u.lang = 'zh-CN';
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.05;    // 稍快一点，接近真人念旁白的语速
    u.pitch = 1;
    u.onend = finish;
    u.onerror = finish;
    try { window.speechSynthesis.resume(); } catch (_e) { /* 忽略 */ }
    window.speechSynthesis.speak(u);
  } catch (_e) {
    // 自动播放策略拦截 / 语音引擎异常：不要卡住队列
    finish();
  }
}

function enqueue(text, gapAfter) {
  const clean = cleanText(text);
  if (!clean) return;
  queue.push({ text: clean, gapAfter, queuedAt: Date.now() });
  // 极端情况下（后台冻结很久）队列可能积很长；只保留最新的若干条。
  if (queue.length > 24) queue.splice(0, queue.length - 24);
  pump();
}

/**
 * 念出还没念过的播报。每次状态推送后调用即可。
 *
 * 无论是否真的朗读，都会推进游标——否则静音期间攒下的播报会在重新开启时
 * 一股脑全念出来。
 *
 * @returns {number} 本次实际加入朗读队列的条数
 */
export function speakNew(s, news) {
  if (!supported() || !s) return 0;

  const code = s.roomCode || '';
  if (code !== lastRoom) {
    lastRoom = code;
    lastSpokenId = 0;
    stop();                      // 换房间时掐掉上一局还没念完的
  }

  const fresh = (news || []).filter((n) => typeof n.id === 'number' && n.id > lastSpokenId);
  if (!fresh.length) return 0;
  lastSpokenId = fresh[fresh.length - 1].id;

  if (!enabled() || !isNarrator(s)) return 0;
  for (const n of fresh) enqueue(n.text, gapFor(n.text));
  return fresh.length;
}

/** 离开游戏页时调用：掐掉没念完的，并让游标跟随下一局重新开始。 */
export function resetVoice() {
  lastRoom = '';
  lastSpokenId = 0;
  stop();
}
