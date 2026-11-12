// Shared by the browser and engine; role limits and editable rules have one source of truth.
export const ROLE_LIMITS = { wolf: 16, villager: 16, whiteWolfKing: 1, seer: 1, witch: 1, hunter: 1, guard: 1, idiot: 1 };
export const RULE_DEFAULTS = {
  firstNightWitchSelfHeal: true, guardWitchConflict: false, sheriffBeforeDeath: true,
  sheriffVoteWeight: 1.5, killSide: true, revealOnExile: false,
};
export function normalizeRules(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('规则配置无效');
  const rules = { ...RULE_DEFAULTS };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(rules, key)) throw new Error('存在未知规则');
    if (key === 'sheriffVoteWeight') {
      if (![1, 1.5].includes(input[key])) throw new Error('警长票权只能为 1 或 1.5');
    } else if (typeof input[key] !== 'boolean') throw new Error('规则开关必须为布尔值');
    rules[key] = input[key];
  }
  return rules;
}
