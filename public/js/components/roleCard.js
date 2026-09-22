// 身份牌：玩家自己的角色 + 私有信息（狼队友、药水、验人记录、守护记录）。
//
// 防偷看是这个组件的核心约束，体现在两点：
//   1. 默认不显示——开局确认之后，身份牌收进「按住查看」的浮层里（见 rolePeek）。
//   2. 显示时用中性低对比配色——不用红/绿大色块和发光。旁边的人扫一眼只会看到
//      一块深色面板，而不是「红色 = 这人是狼」这种隔桌可读的信号。
// 角色名本身已经说明了阵营（狼人/预言家/村民…），不需要靠颜色去喊。
import { el } from '../ui.js';

/** 角色名 + 阵营 + 描述 + 私有信息，身份牌与浮层共用同一份内容。 */
export function roleLines(s) {
  const me = s.me;
  const priv = s.private || {};
  const extras = [];

  if (me.isWolf) {
    extras.push(el('div', { class: 'rc-extra' }, [
      el('span', { class: 'rc-k' }, '狼队友'),
      el('span', { class: 'rc-v' }, me.wolfTeammates.length
        ? me.wolfTeammates.map((n) => `${n}号`).join('、')
        : '（无）'),
    ]));
  }

  if (priv.witch) {
    const potions = [
      priv.witch.healLeft ? '解药' : null,
      priv.witch.poisonLeft ? '毒药' : null,
    ].filter(Boolean).join('、') || '已用尽';
    extras.push(el('div', { class: 'rc-extra' }, [
      el('span', { class: 'rc-k' }, '药水'),
      el('span', { class: 'rc-v' }, potions),
    ]));
    if (priv.witch.killTarget) {
      extras.push(el('div', { class: 'rc-extra' }, [
        el('span', { class: 'rc-k' }, '今夜刀口'),
        el('span', { class: 'rc-v' }, `${priv.witch.killTarget}号`),
      ]));
    }
  }

  if (priv.seerHistory && priv.seerHistory.length) {
    extras.push(el('div', { class: 'rc-extra' }, [
      el('span', { class: 'rc-k' }, '验人记录'),
      el('span', { class: 'rc-v rc-checks' }, priv.seerHistory.map((h) => el('span', {
        class: 'rc-check',
      }, `${h.seat}号 ${h.camp === 'wolf' ? '狼' : '好'}`))),
    ]));
  }

  if (priv.guardLastTarget) {
    extras.push(el('div', { class: 'rc-extra' }, [
      el('span', { class: 'rc-k' }, '上一晚守护'),
      el('span', { class: 'rc-v' }, `${priv.guardLastTarget}号`),
    ]));
  }

  if (priv.canBlast) {
    extras.push(el('div', { class: 'rc-extra' }, '💣 白天发言阶段可自爆，带走一人'));
  }

  if (s.sheriff === me.seat) {
    extras.push(el('div', { class: 'rc-extra' }, '🛡 你是警长'));
  }

  return [
    el('div', { class: 'rc-name' }, me.roleName || '—'),
    el('div', { class: 'rc-camp' }, me.isWolf ? '狼人阵营' : '好人阵营'),
    me.roleDesc ? el('div', { class: 'rc-desc' }, me.roleDesc) : null,
    extras.length ? el('div', { class: 'rc-extras' }, extras) : null,
  ].filter(Boolean);
}

/** 确认身份阶段内联展示的卡片（游戏开始后不再内联，见 views/game.js）。 */
export function roleCard(s) {
  return el('div', { class: 'role-card', id: 'role-card' }, [
    el('div', { class: 'rc-kicker' }, '你的身份 · 别让旁人看到'),
    ...roleLines(s),
  ]);
}
