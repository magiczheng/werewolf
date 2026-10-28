// 角色定义、阵营与默认板子生成器

export const CAMPS = {
  WOLF: 'wolf',   // 狼人阵营
  GOOD: 'good',   // 好人阵营
};

// 角色元信息
export const ROLES = {
  wolf: {
    id: 'wolf',
    name: '狼人',
    camp: CAMPS.WOLF,
    description: '每晚与狼队友共同选择一名玩家杀害。杀光所有神职或所有平民即可获胜。',
    nightAction: 'wolfKill',
    revealOnDeath: false,
  },
  whiteWolfKing: {
    id: 'whiteWolfKing',
    name: '白狼王',
    camp: CAMPS.WOLF,
    description: '属狼人阵营。白天发言阶段可自爆，带走一名玩家并立即结束白天（不进行放逐投票）。',
    nightAction: 'wolfKill', // 与狼人一同刀人
    revealOnDeath: true,
  },
  villager: {
    id: 'villager',
    name: '村民',
    camp: CAMPS.GOOD,
    description: '没有特殊能力的好人，依靠推理找出狼人。',
    nightAction: null,
    revealOnDeath: false,
  },
  seer: {
    id: 'seer',
    name: '预言家',
    camp: CAMPS.GOOD,
    description: '每晚可以查验一名存活玩家的阵营（好人 / 狼人）。',
    nightAction: 'seerCheck',
    revealOnDeath: true,
  },
  witch: {
    id: 'witch',
    name: '女巫',
    camp: CAMPS.GOOD,
    description: '拥有一瓶解药和一瓶毒药各一次。每晚得知狼人刀口，可用解药救人或用毒药毒人（一晚只能使用一种）。',
    nightAction: 'witchAct',
    revealOnDeath: false,
  },
  hunter: {
    id: 'hunter',
    name: '猎人',
    camp: CAMPS.GOOD,
    description: '被狼人杀害或被放逐时可开枪带走一名玩家；被女巫毒死不能开枪。开枪时公开翻牌。',
    nightAction: null,
    revealOnDeath: true,
  },
  guard: {
    id: 'guard',
    name: '守卫',
    camp: CAMPS.GOOD,
    description: '每晚守护一名玩家使其免受狼刀；不能连续两晚守护同一人。',
    nightAction: 'guardProtect',
    revealOnDeath: false,
  },
  idiot: {
    id: 'idiot',
    name: '白痴',
    camp: CAMPS.GOOD,
    description: '被放逐时翻牌免死并失去投票权，此后不可再被放逐；被狼刀仍会死亡。',
    nightAction: null,
    revealOnDeath: true,
  },
};

export const WOLF_ROLES = ['wolf', 'whiteWolfKing'];

// 神职：好人阵营中带技能的角色。屠边规则要区分「神职」与「平民」，
// 因此这里单独列出——villager 是唯一不算神职的好人。
export const GOD_ROLES = ['seer', 'witch', 'hunter', 'guard', 'idiot'];

// 默认板子：8~16 人
// 结构：{ roles: {roleId: count} }
export const DEFAULT_BOARDS = {
  // 9 人局用主流配置：3 狼 + 3 神（预言家/女巫/猎人）+ 3 民，不含守卫
  9:  { roles: { wolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1 } },
  10: { roles: { wolf: 3, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 } },
  11: { roles: { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1 } },
  12: { roles: { wolf: 4, villager: 3, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 } },
  13: { roles: { wolf: 4, villager: 4, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 } },
  14: { roles: { wolf: 4, villager: 5, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 } },
  15: { roles: { wolf: 5, villager: 5, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 } },
  16: { roles: { wolf: 5, villager: 6, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 } },
};

export const ROLE_KEYS = Object.keys(ROLES);

/** 取某角色所属阵营 */
export function campOf(roleId) {
  return (ROLES[roleId] || {}).camp;
}

export function isWolf(roleId) {
  return campOf(roleId) === CAMPS.WOLF;
}

/**
 * 生成某人数下的默认角色配置（返回 DEFAULT_ROLES 形状的 {roleId: count}）。
 * 校验：总人数必须匹配、阵营数量合法。
 */
export function defaultBoardFor(playerCount) {
  const board = DEFAULT_BOARDS[playerCount];
  if (!board) return null;
  return { ...board.roles };
}

/**
 * 校验一份自定义角色配置是否合法。
 * @param {object} roles {roleId: count}
 * @param {number} playerCount
 * @returns {string|null} 错误信息或 null（合法）
 */
export function validateRoles(roles, playerCount) {
  if (!roles || typeof roles !== 'object') return '角色配置无效';
  let total = 0;
  let wolves = 0;
  for (const key of ROLE_KEYS) {
    const n = Number(roles[key]) || 0;
    if (!Number.isInteger(n) || n < 0) return `「${ROLES[key].name}」数量非法`;
    total += n;
    if (campOf(key) === CAMPS.WOLF) wolves += n;
  }
  if (total !== playerCount) return `角色总数 ${total} 与玩家数 ${playerCount} 不一致`;
  if (wolves < 1) return '至少需要 1 名狼人';
  if (wolves > playerCount - 1) return '狼人数量过多';
  if (wolves * 2 >= playerCount) return '狼人数量过多（需少于好人数）';
  return null;
}
