// 语音播报：用浏览器内置的 SpeechSynthesis 念出播报内容。
// 零依赖、不联网、离线可用（走操作系统自带的语音引擎）。
//
// 只在「解说员设备」上朗读——房主（法官模式下即法官）那一台。
// 一屋子 9 部手机同时念旁白是灾难，线下游戏本来就是一个人念旁白。
// 其他设备上的开关自动隐藏，也就无从开启。
//
// 判断「哪些是新的」用的是播报条目自带的单调 id，不是数组下标：
// 播报上限 40 条、满了会从头部裁掉，下标会整体错位。

import { store } from './net.js';

const KEY = 'ww_voice';      // '0' 表示静音，缺省为开启

let lastRoom = '';           // 记录房间：换房间时重置游标，避免把上一局的播报当新的
let lastSpokenId = 0;
let cachedVoice = null;
let voiceResolved = false;

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
  try { window.speechSynthesis.cancel(); } catch (_e) { /* 忽略 */ }
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

function speakOne(text) {
  const u = new window.SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.05;    // 稍快一点，接近真人念旁白的语速
  u.pitch = 1;
  try {
    window.speechSynthesis.speak(u);
  } catch (_e) { /* 自动播放策略可能拦截，静默忽略 */ }
}

/**
 * 念出还没念过的播报。每次状态推送后调用即可。
 *
 * 无论是否真的朗读，都会推进游标——否则静音期间攒下的播报会在重新开启时
 * 一股脑全念出来。
 *
 * @returns {number} 本次实际念了几条
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
  for (const n of fresh) speakOne(n.text);
  return fresh.length;
}

/** 离开游戏页时调用：掐掉没念完的，并让游标跟随下一局重新开始。 */
export function resetVoice() {
  lastRoom = '';
  lastSpokenId = 0;
  stop();
}
