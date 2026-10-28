// 全局配置与环境变量
// 所有可调项集中在同一份数据里，便于前端/引擎复用。

// 注意：本应用**没有阶段倒计时**。
// 何时推进完全由「当前操作人点结束」决定（见 engine.js 的 endPhase）：
//   · 夜间各角色行动完 → 该角色点「结束」
//   · 警长竞选发言 / 遗言 → 发言者本人点「结束发言」
//   · 天亮播报 / 白天自由发言 → 房主点「结束」
//   · 投票 / 上警 / 确认身份 → 相关玩家全部操作完自动推进
// 这样线下聚会时节奏完全由桌上的人掌握，不会因为读得慢被计时器推着走。

export const DEFAULT_RULES = {
  firstNightWitchSelfHeal: true, // 女巫首夜可自救
  guardWitchConflict: false,     // false=守救同盾平安夜；true=守救相克（目标死亡）
  // 首日顺序（面杀主流）：先竞选警长，竞选结束后再公布昨夜死讯。
  // 关闭后改为「先公布死讯，再竞选警长」（部分网杀流程）。
  // 开启时，昨夜死者仍可参加首日警长竞选——线下他们此时还不知道自己已死。
  sheriffBeforeDeath: true,
  sheriffVoteWeight: 1.5,        // 警长票权重（实现上乘2缩放：普通=2、警长=3）
  // 屠边规则（默认开，主流玩法）：
  //   true  —— 狼人杀光所有「神职」或杀光所有「平民」即获胜（屠边）
  //   false —— 狼人数量追平/反超好人即获胜（屠城）
  // 屠边更常见也更平衡：狼人需要针对性地清掉某一类好人，而不是单纯堆人数。
  killSide: true,
  // 被放逐的玩家是否公开翻牌。
  // 默认关闭：放逐只公布「谁出局」，「是什么身份」不让全场知道——
  // 否则一次放逐等于白送全场一条身份信息。想让放逐也翻牌的桌可以在创建时打开。
  revealOnExile: false,
};

export const DEFAULT_ROLES = {
  wolf: 0,
  whiteWolfKing: 0,
  villager: 0,
  seer: 0,
  witch: 0,
  hunter: 0,
  guard: 0,
  idiot: 0,
};

// 环境变量
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const PUBLIC_URL = process.env.PUBLIC_URL || ''; // 可选：固定分享链接前缀

// 账号体系
export const DB_PATH = process.env.DB_PATH || new URL('../data/werewolf.db', import.meta.url).pathname; // SQLite 数据文件
export const MIN_PASSWORD_LENGTH = 6;       // 密码最短长度
export const AUTH_RATE_LIMIT = 20;          // 每 IP 每分钟注册/登录尝试上限
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话 30 天未活跃则清理

// 房间清理：空闲房间（无连接）5 小时后回收
export const ROOM_IDLE_TTL = 5 * 60 * 60 * 1000;

// 多账号测试模式（默认关闭）：
// 开启后，前端的登录会话改存 sessionStorage（每个标签页独立），
// 于是同一个浏览器可以开多个标签页、各登录一个账号——用于本地联调一桌人。
// 普通运行（不设该变量）行为完全不变：会话仍存 localStorage。
export const MULTI_ACCOUNT = process.env.MULTI_ACCOUNT === '1';

// 测试账号种子（默认随多账号测试模式一起开启）：
// 启动时确保存在 1@qq.com ~ 8@qq.com 这 8 个账号，密码统一 111111，
// 省去每开一个标签页都要手动注册的麻烦。已存在则跳过，可反复启动。
//   SEED_ACCOUNTS=1  强制开启
//   SEED_ACCOUNTS=0  强制关闭（即使在多账号测试模式下）
//
// ⚠️ 这些账号密码极弱，只应在本地/内网测试时使用。它们会写进正式的 users 表
// 并持久化——若之后用同一个 DB_PATH 跑公网部署，记得先删掉或换库。
export const SEED_ACCOUNTS = (() => {
  const raw = process.env.SEED_ACCOUNTS;
  if (raw === '0') return false;
  if (raw === '1') return true;
  return MULTI_ACCOUNT;
})();

// 既有账号密码不符时是否重置为测试密码。默认重置——否则「密码都是 111111」
// 这个前提会静默不成立。设 SEED_RESET_PASSWORD=0 可改为只报告、不动既有账号。
export const SEED_RESET_PASSWORD = process.env.SEED_RESET_PASSWORD !== '0';

// 夜间「掩护延迟」：某个夜间角色已出局（或女巫药水用尽）时，不直接跳过它的阶段，
// 而是照常进入并停留一个随机时长再自动推进。
//
// 为什么需要：阶段被跳过本身就是情报——「守卫阶段没出现」等于当众宣布守卫已死；
// 「女巫阶段没出现」更糟，等于告诉狼人女巫没药了、可以放心刀。
// 停留一个随机时长后，从外面无法区分「这个角色死了」和「这个角色行动得快」。
//
// 延迟对客户端不可见（phaseState 里的 maskUntil 不下发），否则倒计时本身又成了信号。
// 板子里压根没有的角色不演——那是公开配置，再演一遍只是白白浪费时间。
export const NIGHT_MASK_MIN_MS = 3000;
export const NIGHT_MASK_MAX_MS = 10000;

// 测试模式下跳过「确认身份」阶段（默认随多账号测试模式开启）。
//
// 为什么只在测试环境跳过：正式玩的时候这个阶段是有意义的——每位玩家要记住自己的
// 身份牌，而且「全员确认后才进入夜晚」本身是个必要的停顿。
// 但本地联调时一个人要开 8~9 个标签页，每个都点一次「我已记住身份」纯属折磨。
//
//   SKIP_ROLE_REVEAL=1  强制跳过
//   SKIP_ROLE_REVEAL=0  强制保留（想在测试环境里验证这个阶段时用）
export const SKIP_ROLE_REVEAL = process.env.SKIP_ROLE_REVEAL === '0' ? false : MULTI_ACCOUNT;

export const TEST_ACCOUNT_COUNT = 9;
export const TEST_ACCOUNT_PASSWORD = '111111';
// 测试账号邮箱规则：1@qq.com … 9@qq.com（数量见 TEST_ACCOUNT_COUNT）
export const testAccountEmail = (i) => `${i}@qq.com`;
