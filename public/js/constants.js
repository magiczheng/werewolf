// 前端常量：角色、板子、规则、阶段名。与 server/roles.js 的默认板子保持一致。

export const ROLE_META = {
  wolf: { name: '狼人', sub: '夜晚共同刀人', camp: 'wolf' },
  whiteWolfKing: { name: '白狼王', sub: '狼人·白天可自爆', camp: 'wolf' },
  villager: { name: '村民', sub: '无技能的好人', camp: 'good' },
  seer: { name: '预言家', sub: '每晚验一人', camp: 'good' },
  witch: { name: '女巫', sub: '一救一毒', camp: 'good' },
  hunter: { name: '猎人', sub: '死亡可开枪', camp: 'good' },
  guard: { name: '守卫', sub: '每晚守护一人', camp: 'good' },
  idiot: { name: '白痴', sub: '被放逐免死翻牌', camp: 'good' },
};

export const ROLE_KEYS = ['wolf', 'whiteWolfKing', 'villager', 'seer', 'witch', 'hunter', 'guard', 'idiot'];

export const DEFAULT_BOARDS = {
  9: { wolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1 },   // 主流配置：3 狼 + 3 神（预言家/女巫/猎人）+ 3 民，不含守卫
  10: { wolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 },
  11: { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 },
  12: { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 },
  13: { wolf: 4, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 },
  14: { wolf: 4, villager: 5, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 },
  15: { wolf: 5, villager: 5, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 },
  16: { wolf: 5, villager: 6, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 },
};

export const PLAYER_COUNTS = [9, 10, 11, 12, 13, 14, 15, 16];

/** 创建房间时预选的人数（板子取 DEFAULT_BOARDS[此值]）。 */
export const DEFAULT_PLAYER_COUNT = 9;   // 主流起点是 9 人局（3 狼 + 3 神 + 3 民）

export const DEFAULT_RULES = {
  firstNightWitchSelfHeal: true,
  guardWitchConflict: false,
  sheriffBeforeDeath: true,
  killSide: true,
  revealOnExile: false,
};

export const RULES_LABELS = [
  ['firstNightWitchSelfHeal', '女巫首夜可自救'],
  ['guardWitchConflict', '守救相克（守+救同人则死亡）'],
  ['sheriffBeforeDeath', '首日先竞选警长，再公布死讯（面杀主流）'],
  ['killSide', '屠边规则（杀光神职或平民即狼胜；关闭则改为屠城）'],
  ['revealOnExile', '被放逐的玩家翻牌公开身份'],
];

export const PHASE_NAME = {
  roleReveal: '确认身份',
  nightGuard: '守卫行动',
  nightWolves: '狼人行动',
  nightWitch: '女巫行动',
  nightSeer: '预言家行动',
  dayStart: '天亮了',
  sheriffDeclare: '警长竞选 · 上警',
  sheriffSpeech: '警长竞选 · 发言',
  sheriffVote: '警长竞选 · 投票',
  sheriffPk: '警长竞选 · 平票PK',
  dayTalk: '白天发言',
  dayVote: '放逐投票',
  votePk: '放逐 · 平票PK',
  lastWords: '遗言',
  hunterShoot: '猎人开枪',
  sheriffHandoff: '警徽移交',
  gameOver: '游戏结束',
};

export const isNightPhase = (p) => !!p && p.startsWith('night');
