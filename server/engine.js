// 狼人杀游戏引擎 —— 纯逻辑、无 I/O，可单测。
// 与 socket 层的唯一接口：onChange(room) 回调（状态变化时通知外部广播快照）。
// 推进模型：**没有任何倒计时**，阶段何时结束完全由人决定，见 endPhase()：
//   · 夜间角色（守卫/女巫/预言家）与狼人一样，**行动完即自动进入下一阶段**；
//     手动「结束」只留给「这一晚不想行动」的情况（例如守卫空守）
//   · 警长发言 / 遗言 —— 该操作人点「结束发言」
//   · 无操作人的阶段（天亮播报、白天自由发言）—— 房主点「结束」
//   · 多人共同参与的阶段（确认身份、上警、投票）—— 全部操作完自动推进
// 法官模式下上述自动推进不生效，一律由法官点「下一步」（判决权仍在法官手里）。
//
// 狼人夜间是**队内投票**，规则与其它阶段不同：
//   · 每只狼各投一票，**全员选完之前阶段不会推进**（一只狼不能替全队收工）
//   · 全员选完且有人过半 → **自动进入下一阶段**，没有「结束本阶段」这个按钮
//   · 少数服从多数：得票严格过半才算数；无人过半则清空所有票重新投
//   · 票型只发给狼队，好人和法官面板都看不到（法官面板走 _judgeState，只给汇总）

import { ROLES, WOLF_ROLES, GOD_ROLES, CAMPS, isWolf, validateRoles, defaultBoardFor } from './roles.js';
import { DEFAULT_RULES, DEFAULT_ROLES, NIGHT_MASK_MIN_MS, NIGHT_MASK_MAX_MS } from './config.js';

export const PHASE = {
  LOBBY: 'lobby',
  ROLE_REVEAL: 'roleReveal',
  NIGHT_GUARD: 'nightGuard',
  NIGHT_WOLVES: 'nightWolves',
  NIGHT_WITCH: 'nightWitch',
  NIGHT_SEER: 'nightSeer',
  DAY_START: 'dayStart',
  SHERIFF_DECLARE: 'sheriffDeclare',
  SHERIFF_SPEECH: 'sheriffSpeech',
  SHERIFF_VOTE: 'sheriffVote',
  SHERIFF_PK: 'sheriffPk',
  DAY_TALK: 'dayTalk',
  DAY_VOTE: 'dayVote',
  VOTE_PK: 'votePk',
  LAST_WORDS: 'lastWords',
  HUNTER_SHOOT: 'hunterShoot',
  SHERIFF_HANDOFF: 'sheriffHandoff',
  GAME_OVER: 'gameOver',
};

// 可以自爆的阶段：一律是白天。夜晚（含各角色行动）不能自爆。
// 含放逐投票与平票 PK——此时自爆会让投票作废、不公布放逐结果。
const BLAST_PHASES = new Set([
  PHASE.SHERIFF_DECLARE, PHASE.SHERIFF_SPEECH, PHASE.SHERIFF_VOTE,
  PHASE.SHERIFF_PK, PHASE.DAY_TALK, PHASE.DAY_VOTE, PHASE.VOTE_PK,
]);

const NIGHT_ORDER = [
  PHASE.NIGHT_GUARD, PHASE.NIGHT_WOLVES, PHASE.NIGHT_WITCH, PHASE.NIGHT_SEER,
];

/** 根据客户端输入构建一份合法的 settings；非法则抛出 Error。 */
export function buildSettings(input) {
  const playerCount = Number(input.playerCount);
  if (!Number.isInteger(playerCount) || playerCount < 9 || playerCount > 16) {
    throw new Error('游戏人数需为 9~16');
  }
  const roles = {};
  if (input.roles) {
    for (const k of Object.keys(DEFAULT_ROLES)) {
      roles[k] = Math.max(0, Number(input.roles[k]) || 0);
    }
  } else {
    // 未指定角色时按人数套用默认板子
    const def = defaultBoardFor(playerCount);
    if (def) for (const k of Object.keys(DEFAULT_ROLES)) roles[k] = def[k] || 0;
  }
  const err = validateRoles(roles, playerCount);
  if (err) throw new Error(err);
  return {
    playerCount,
    judgeMode: !!input.judgeMode,
    roles,
    rules: { ...DEFAULT_RULES, ...(input.rules || {}) },
  };
}

/** 校验一套配置是否可开局（服务端二次校验用）。 */
export function validateSettings(settings) {
  try { buildSettings(settings); return null; } catch (e) { return e.message; }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export class Room {
  /**
   * @param {object} opts
   * @param {string} opts.code 房间号
   * @param {object} opts.settings 已校验的 settings（来自 buildSettings）
   * @param {string} opts.hostPlayerId 房主 playerId
   * @param {string} opts.hostName 房主昵称
   * @param {(room:Room)=>void} [opts.onChange] 状态变化回调
   */
  constructor(opts) {
    this.code = opts.code;
    this.settings = opts.settings;
    this.hostPlayerId = opts.hostPlayerId;
    this.onChange = opts.onChange || null;
    // 测试模式才置位：跳过「确认身份」阶段，直接发牌进夜晚（见 start()）
    this.skipRoleReveal = !!opts.skipRoleReveal;

    this.players = new Map(); // playerId -> Player
    this.seatMap = new Array(this.settings.playerCount + 1).fill(null); // seat -> playerId
    this.connectedCount = 0;

    this.judgePlayerId = this.settings.judgeMode ? this.hostPlayerId : null;

    // 房主入房：法官模式下作为法官成员，否则作为普通玩家
    this.players.set(opts.hostPlayerId, this._mkPlayer(opts.hostPlayerId, opts.hostName, {
      isJudge: this.settings.judgeMode,
    }));

    this.gameStarted = false;
    this.gameOver = null;
    this.phase = PHASE.LOBBY;
    this.phaseState = {};
    this.day = 0;
    this.sheriff = null;
    this.sheriffState = null;
    this.voteState = null;
    this.night = null;
    this.pendingDay = [];
    this.afterQueue = 'day';
    // 首日「先竞选警长、后公布死讯」时，昨夜结算出的死亡先暂存在这里，
    // 等竞选结束再真正扣血、播报、排后续事件（见 _resolveNight / _finishSheriffElection）。
    this._deferredNightDeaths = null;
    this._sheriffElectionDone = false;
    this.totalDeaths = 0;
    this.news = [];
    this.newsSeq = 0;
    this.lastActive = Date.now();
  }

  // ---------- 基础 ----------

  _mkPlayer(playerId, name, extra = {}) {
    return {
      playerId, name,
      seat: null, role: null, alive: true, connected: true,
      isJudge: false, roleReady: false, revealed: false, idiotFlipped: false,
      witchHealUsed: false, witchPoisonUsed: false,
      guardLastTarget: null, seerHistory: [],
      ...extra,
    };
  }

  _news(text) {
    // id 单调递增：客户端靠它判断「这条播报是不是已经念过了」。
    // 不能用数组下标——播报上限 40 条，满了会从头部裁掉，下标会整体错位。
    this.newsSeq = (this.newsSeq || 0) + 1;
    this.news.push({ id: this.newsSeq, t: Date.now(), text });
    if (this.news.length > 40) this.news.splice(0, this.news.length - 40);
  }

  touch() {
    this.lastActive = Date.now();
    if (this.onChange) this.onChange(this);
  }

  _playerAt(seat) {
    if (!seat || seat < 1 || seat > this.settings.playerCount) return null;
    const pid = this.seatMap[seat];
    return pid ? this.players.get(pid) : null;
  }

  _seatOf(playerId) {
    const p = this.players.get(playerId);
    return p ? p.seat : null;
  }

  _roleOfSeat(seat) {
    const p = this._playerAt(seat);
    return p ? p.role : null;
  }

  _livePlayers() {
    return [...this.players.values()].filter(p => p.seat && p.alive);
  }

  _liveWolves() {
    return this._livePlayers().filter(p => isWolf(p.role));
  }

  _liveRoleSeat(role) {
    const p = this._livePlayers().find(p => p.role === role);
    return p ? p.seat : null;
  }

  _wolfTeammates(viewerSeat) {
    return [...this.players.values()]
      .filter(p => p.seat && isWolf(p.role) && p.seat !== viewerSeat)
      .map(p => p.seat)
      .sort((a, b) => a - b);
  }

  _validTarget(seat, { exclude = [], excludeWolves = false, excludeDead = true } = {}) {
    const p = this._playerAt(seat);
    if (!p) return false;
    if (exclude.includes(seat)) return false;
    if (excludeDead && !p.alive) return false;
    if (excludeWolves && isWolf(p.role)) return false;
    return true;
  }

  setConnected(playerId, connected) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = connected;
    this.touch();
  }

  // ---------- 房间 / 入座 ----------

  addPlayer(playerId, name) {
    if (this.players.has(playerId)) return { error: '已在房间中' };
    if (this.gameStarted) return { error: '游戏已开始，无法加入' };
    if (this._joinedPlayerCount() >= this.settings.playerCount) return { error: '房间已满' };
    this.players.set(playerId, this._mkPlayer(playerId, name));
    this.touch();
    return { ok: true };
  }

  _joinedPlayerCount() {
    return [...this.players.values()].filter(p => !p.isJudge).length;
  }

  /**
   * 入座 / 换座。
   * 已经坐着的人再次调用会自动让出旧座位后坐到新位置——换座不需要先「起立」。
   */
  sit(playerId, seat) {
    const p = this.players.get(playerId);
    if (!p) return { error: '不在房间中' };
    if (p.isJudge) return { error: '法官无需入座' };
    if (this.gameStarted) return { error: '游戏已开始' };
    seat = Number(seat);
    if (!Number.isInteger(seat) || seat < 1 || seat > this.settings.playerCount) return { error: '座位号无效' };
    const holder = this.seatMap[seat];
    if (holder && holder !== playerId) return { error: `座位 ${seat} 已被占用` };
    // 让出旧座位
    if (p.seat) this.seatMap[p.seat] = null;
    this.seatMap[seat] = playerId;
    p.seat = seat;
    this.touch();
    return { ok: true };
  }

  /**
   * 离开座位（留在房间里）。之后可以重新选座，或把位置让给别人。
   * 开局后不允许——中途起立会让座位与身份对不上。
   */
  standUp(playerId) {
    const p = this.players.get(playerId);
    if (!p) return { error: '不在房间中' };
    if (p.isJudge) return { error: '法官没有座位' };
    if (this.gameStarted) return { error: '游戏已开始，不能离开座位' };
    if (!p.seat) return { error: '你还没有入座' };
    this.seatMap[p.seat] = null;
    p.seat = null;
    this.touch();
    return { ok: true };
  }

  leave(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (p.seat) this.seatMap[p.seat] = null;
    this.players.delete(playerId);
    this.touch();
  }

  canStart() {
    if (this.gameStarted) return { error: '游戏已开始' };
    const seated = this._livePlayers().length;
    if (seated < this.settings.playerCount) {
      return { error: `还有 ${this.settings.playerCount - seated} 个座位未坐满` };
    }
    return { ok: true };
  }

  start() {
    const chk = this.canStart();
    if (chk.error) return chk;
    this.gameStarted = true;
    this.day = 0;
    this.news = [];
    this.totalDeaths = 0;
    this.sheriff = null;
    this.sheriffState = null;
    this.voteState = null;
    this.night = null;
    this.pendingDay = [];
    this._deferredNightDeaths = null;
    this._sheriffElectionDone = false;
    this.gameOver = null;

    for (const p of this.players.values()) {
      if (!p.seat) continue;
      p.alive = true; p.roleReady = false; p.revealed = false; p.idiotFlipped = false;
      p.witchHealUsed = false; p.witchPoisonUsed = false;
      p.guardLastTarget = null; p.seerHistory = [];
    }
    this._dealRoles();
    if (this.skipRoleReveal) {
      // 测试模式：不发牌确认，直接进夜晚。角色照常发下去。
      this._news('测试模式：已跳过确认身份阶段');
      this._enterNight();
      return { ok: true };
    }
    this._startPhase(PHASE.ROLE_REVEAL);
    return { ok: true };
  }

  _dealRoles() {
    const deck = [];
    for (const [role, count] of Object.entries(this.settings.roles)) {
      for (let i = 0; i < count; i++) deck.push(role);
    }
    shuffle(deck);
    let i = 0;
    for (let seat = 1; seat <= this.settings.playerCount; seat++) {
      const p = this._playerAt(seat);
      p.role = deck[i++];
    }
  }

  // ---------- 阶段控制 ----------

  _startPhase(phase, extra = {}) {
    this.phase = phase;
    // 没有倒计时，因此没有 deadline；何时推进由 endPhase() 或自动完成条件决定。
    this.phaseState = { ...extra };
    this._announcePhase(phase, extra);
    this.touch();
  }

  /**
   * 进入阶段时向全场播报一句，相当于线下法官的口播（「天黑请闭眼，狼人请睁眼…」）。
   *
   * 措辞只提「轮到谁行动」，**不提座位号**——说「3 号请睁眼」等于当众报出 3 号是什么角色。
   * 例外是遗言/开枪/警徽移交：那些座位号本来就公开（人已经出局或在台上），带上更清楚。
   */
  _announcePhase(phase, extra = {}) {
    const seat = extra.seat;
    switch (phase) {
      case PHASE.ROLE_REVEAL:
        this._news('游戏开始，请查看并确认自己的身份'); break;
      case PHASE.NIGHT_GUARD:
        // 「天黑请闭眼」不在这里报——那是「进入夜晚」这件事，见 _enterNight()。
        // 挂在守卫阶段上会导致没有守卫的板子（如默认 8 人局）整晚都不报天黑。
        this._news('守卫请睁眼，请选择今晚守护的对象'); break;
      case PHASE.NIGHT_WOLVES:
        this._news('狼人请睁眼，请选择今晚击杀的对象'); break;
      case PHASE.NIGHT_WITCH:
        this._news('女巫请睁眼'); break;
      case PHASE.NIGHT_SEER:
        this._news('预言家请睁眼，请选择查验的对象'); break;
      case PHASE.DAY_START:
        this._news(`第 ${this.day} 天，天亮了`); break;
      case PHASE.SHERIFF_DECLARE:
        this._news('警长竞选开始，请选择是否上警'); break;
      case PHASE.SHERIFF_SPEECH:
        this._news(extra.speakerSeat ? `${extra.speakerSeat}号 开始竞选发言` : '警上候选人依次发言'); break;
      case PHASE.SHERIFF_VOTE:
        this._news('警下玩家请投票选出警长'); break;
      case PHASE.SHERIFF_PK:
        this._news('警长竞选平票，请重新投票'); break;
      case PHASE.DAY_TALK:
        this._news('请开始自由发言，讨论后投票放逐'); break;
      case PHASE.DAY_VOTE:
        this._news('请投票放逐一名玩家'); break;
      case PHASE.VOTE_PK:
        this._news('放逐投票平票，请重新投票'); break;
      case PHASE.LAST_WORDS:
        this._news(seat ? `${seat}号 发表遗言` : '请发表遗言'); break;
      case PHASE.HUNTER_SHOOT:
        // 不报座位号：猎人的身份是暗的，说「3 号请开枪」等于当众公布 3 号是猎人
        this._news('猎人请选择是否开枪'); break;
      case PHASE.SHERIFF_HANDOFF:
        this._news(seat ? `${seat}号 请移交警徽` : '请移交警徽'); break;
      default: break;
    }
  }

  /** 阶段推进（法官模式下由法官触发；无法官模式下由计时触发）。 */
  advance() {
    if (this.gameOver || this.phase === PHASE.LOBBY) return;
    switch (this.phase) {
      case PHASE.ROLE_REVEAL: this._enterNight(); break;
      // 夜间每个角色行动完先播一句「请闭眼」，再进入下一位的「请睁眼」。
      // 这句话本身不改变规则，但它是线下法官口播里必不可少的仪式感：
      // 没有它，语音会把「狼人请睁眼」和「女巫请睁眼」连成一串，
      // 桌上的人还没闭眼，下一位就已经睁眼了。
      case PHASE.NIGHT_GUARD:
        this._news('守卫请闭眼');
        this._startNextNightPhase(); break;
      case PHASE.NIGHT_WOLVES:
        this._news('狼人请闭眼');
        this._startNextNightPhase(); break;
      case PHASE.NIGHT_WITCH:
        this._news('女巫请闭眼');
        this._startNextNightPhase(); break;
      case PHASE.NIGHT_SEER:
        this._news('预言家请闭眼');
        this._resolveNight(); break;
      case PHASE.DAY_START:
      case PHASE.LAST_WORDS:
      case PHASE.HUNTER_SHOOT:
        this._processQueue(); break;
      case PHASE.SHERIFF_HANDOFF:
        // 未在限定时间内移交警徽 → 默认撕警徽
        if (!this.phaseState.done && this.phaseState.seat && this.sheriff === this.phaseState.seat) {
          this.sheriff = null;
          this._news(`警长 ${this.phaseState.seat}号 未移交，警徽作废`);
        }
        this._processQueue(); break;
      case PHASE.SHERIFF_DECLARE: this._enterSheriffSpeech(); break;
      case PHASE.SHERIFF_SPEECH: this._nextSpeechOrVote(); break;
      case PHASE.SHERIFF_VOTE: this._resolveSheriffVote(); break;
      case PHASE.SHERIFF_PK: this._resolveSheriffPk(); break;
      case PHASE.DAY_TALK: this._enterDayVote(); break;
      case PHASE.DAY_VOTE: this._resolveDayVote(); break;
      case PHASE.VOTE_PK: this._resolvePkVote(); break;
      default: break;
    }
  }

  /**
   * 多人共同参与的阶段：全部操作完自动推进。
   *
   * 注意这里只处理「所有人做完就该走」的阶段。有明确操作人的阶段
   * （夜间各角色、警长发言、遗言）**不在此列**——它们由该操作人点「结束」
   * 显式推进，见 endPhase()。这正是「去掉倒计时」后的推进模型。
   */
  _maybeComplete() {
    if (this.settings.judgeMode || this.gameOver) return;
    switch (this.phase) {
      case PHASE.ROLE_REVEAL:
        if (this._allRoleConfirmed()) this.advance(); break;
      case PHASE.SHERIFF_DECLARE:
        if (this._allDeclared()) this.advance(); break;
      case PHASE.SHERIFF_VOTE:
      case PHASE.SHERIFF_PK:
        if (this._allSheriffVoted()) this.advance(); break;
      case PHASE.DAY_VOTE:
      case PHASE.VOTE_PK:
        if (this._allVoted()) this.advance(); break;
      // 开枪与移交：动作本身就是这一阶段的全部内容，做完即结束
      case PHASE.HUNTER_SHOOT:
      case PHASE.SHERIFF_HANDOFF:
        if (this.phaseState.done) this.advance(); break;
      default: break;
    }
  }

  /**
   * 当前操作人显式结束本阶段 —— 没有倒计时之后的主要推进方式。
   *
   * 谁能结束由阶段决定：
   *   夜间各角色   → 该角色本人
   *   警长发言     → 当前发言者
   *   遗言         → 正在留遗言的玩家
   *   天亮播报 / 白天自由发言 → 房主（这两个阶段没有「操作人」）
   *
   * 返回的错误文案是给所有人看的，所以**不能暴露操作人的座位号**
   * （夜间阶段说「由守卫结束」即可，说「由 3 号结束」等于泄露 3 号是守卫）。
   */
  _endPhaseError(p) {
    const ps = this.phaseState || {};
    const isHost = p.playerId === this.hostPlayerId;

    switch (this.phase) {
      case PHASE.NIGHT_GUARD:
        return (p.role === 'guard' && p.alive) ? null : { error: '当前由守卫结束本阶段' };
      // 狼人阶段不提供手动结束：全员投完且过半时引擎会自动进入下一阶段
      // （见 _resolveWolfVote），所以这里不列 NIGHT_WOLVES。
      case PHASE.NIGHT_WITCH:
        return (p.role === 'witch' && p.alive) ? null : { error: '当前由女巫结束本阶段' };
      case PHASE.NIGHT_SEER:
        return (p.role === 'seer' && p.alive) ? null : { error: '当前由预言家结束本阶段' };
      case PHASE.SHERIFF_SPEECH:
        return ps.speakerSeat === p.seat ? null : { error: '当前由发言者结束本阶段' };
      case PHASE.LAST_WORDS:
        return ps.seat === p.seat ? null : { error: '当前由发言者结束本阶段' };
      case PHASE.DAY_START:
      case PHASE.DAY_TALK:
        return isHost ? null : { error: '当前由房主结束本阶段' };
      default:
        return { error: '当前阶段无需手动结束' };
    }
  }

  /** 该玩家现在能不能点「结束」（前端据此决定是否显示按钮）。 */
  _canEndPhase(p) {
    if (this.gameOver) return false;
    // 法官模式下节奏由法官掌握，玩家侧不出现「结束」按钮
    if (this.settings.judgeMode) return false;
    if (!p || !p.seat) return false;
    return this._endPhaseError(p) === null;
  }

  endPhase(playerId) {
    if (this.gameOver) return { error: '游戏已结束' };
    if (this.settings.judgeMode) return { error: '法官模式下由法官推进阶段' };
    const p = this.players.get(playerId);
    if (!p || !p.seat) return { error: '无效玩家' };
    const err = this._endPhaseError(p);
    if (err) return err;
    this.advance();
    return { ok: true };
  }

  // ---------- 夜晚 ----------

  _enterNight() {
    this.day++;
    this.night = {
      day: this.day,
      wolfVotes: {},     // seat -> targetSeat（每只狼各投一票）
      wolfTarget: null,  // 得票过半的刀口；无多数票时为 null
      wolfRevote: false, // 上一轮无人过半、已清空重投
      guardTarget: null,
      seerTarget: null,
      seerResult: null,
      witchHeal: null,
      witchPoison: null,
      nextIndex: 0,
      deaths: [],
    };
    this.pendingDay = [];
    this.afterQueue = 'day';
    // 「天黑请闭眼」属于「进入夜晚」而非某个角色：绑在守卫阶段上的话，
    // 没有守卫的板子（默认 8 人局就没有）整晚都不会播报天黑。
    this._news('天黑请闭眼');
    this._startNextNightPhase();
  }

  /** 这个板子里是否配置了该夜间角色（与「当前是否可用」无关）。 */
  _nightRoleOf(ph) {
    return {
      [PHASE.NIGHT_GUARD]: 'guard',
      [PHASE.NIGHT_WITCH]: 'witch',
      [PHASE.NIGHT_SEER]: 'seer',
    }[ph] || null;
  }

  _roleInBoard(role) {
    return role != null && (this.settings.roles[role] || 0) > 0;
  }

  /**
   * 进入下一个夜间阶段。
   *
   * 关键：**即使该角色已出局也不跳过它的阶段**，而是照常进入并停留一个随机时长
   * 再自动推进（见 _maskNightPhase）。直接跳过等于当众宣布「这个角色死了」，
   * 「女巫阶段没出现」更是直接告诉狼人女巫没药了。
   *
   * 例外：板子里压根没有这个角色（公开配置）时照常跳过——那不是情报，是常识。
   */
  _startNextNightPhase() {
    while (this.night.nextIndex < NIGHT_ORDER.length) {
      const ph = NIGHT_ORDER[this.night.nextIndex++];
      if (this._nightPhaseNeeded(ph)) {
        this._startPhase(ph);
        return;
      }
      if (this._roleInBoard(this._nightRoleOf(ph))) {
        this._maskNightPhase(ph);   // 角色在板子里但当前不可用 → 演满随机时长再走
        return;
      }
      // 板子里没有这个角色：跳过不会泄露任何东西
    }
    this._resolveNight();
  }

  /**
   * 掩护阶段：照常播报与展示（含阶段名），但不设行动者，停留随机时长后自动推进。
   * 「没有行动者」这一点同时意味着没有任何人能手动结束它——只能等时间到。
   */
  _maskNightPhase(ph) {
    const span = NIGHT_MASK_MAX_MS - NIGHT_MASK_MIN_MS;
    const delay = NIGHT_MASK_MIN_MS + Math.floor(Math.random() * (span + 1));
    this._startPhase(ph, { masked: true, maskUntil: Date.now() + delay });
  }

  /**
   * 由 socket 层的秒级心跳调用。
   * 只做一件事：掩护阶段的时间到了就推进——正常阶段的时间从不参与推进。
   */
  tick() {
    const ps = this.phaseState;
    if (ps && ps.masked && ps.maskUntil && Date.now() >= ps.maskUntil) this.advance();
  }

  _nightPhaseNeeded(ph) {
    switch (ph) {
      case PHASE.NIGHT_GUARD: return this._liveRoleSeat('guard') != null;
      case PHASE.NIGHT_WOLVES: return this._liveWolves().length > 0;
      case PHASE.NIGHT_WITCH: {
        const seat = this._liveRoleSeat('witch');
        if (!seat) return false;
        const w = this._playerAt(seat);
        return !w.witchHealUsed || !w.witchPoisonUsed;
      }
      case PHASE.NIGHT_SEER: return this._liveRoleSeat('seer') != null;
      default: return false;
    }
  }

  /** 狼人当前票型：[座位, 票数]，按票数降序（票数相同按座位升序，保证结果稳定）。 */
  _wolfTally() {
    const tally = new Map();
    if (!this.night) return [];
    for (const w of this._liveWolves()) {
      const t = this.night.wolfVotes[w.seat];
      if (t != null) tally.set(t, (tally.get(t) || 0) + 1);
    }
    return [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  }

  /** 在线狼人是否都已选好目标。全员选完之前任何人都不能结束本阶段。 */
  _allWolvesVoted() {
    const wolves = this._liveWolves();
    if (!wolves.length) return true;
    if (!this.night) return false;
    return wolves.every(w => this.night.wolfVotes[w.seat] != null);
  }

  /**
   * 少数服从多数：返回得票**严格过半**的目标座位；无人过半返回 null（需重新投票）。
   * 3 狼要 2 票、4 狼要 3 票、2 狼必须一致。
   */
  _wolfMajority() {
    const wolves = this._liveWolves();
    if (!wolves.length) return null;
    const need = Math.floor(wolves.length / 2) + 1;
    const top = this._wolfTally()[0];
    return top && top[1] >= need ? top[0] : null;
  }

  /**
   * 夜间角色行动完毕 → 直接进入下一阶段，不需要再点一次「结束本阶段」。
   * 守卫/女巫/预言家与狼人投票保持一致：做完就走。
   * 手动结束只留给「这一晚不想行动」的情况（例如守卫选择空守）。
   * 法官模式下节奏仍归法官，不自动推进。
   */
  _finishNightAction() {
    if (!this.settings.judgeMode) this.advance();
  }

  /**
   * 狼人全员选完后计票。
   * 过半 → 敲定刀口并**直接进入下一阶段**（狼人不需要再点一次结束）；
   * 无人过半 → 清空所有票重新投（少数服从多数，跑不出多数就再议）。
   */
  _resolveWolfVote() {
    const n = this.night;
    if (!n || !this._allWolvesVoted()) return;
    const maj = this._wolfMajority();
    if (maj != null) {
      n.wolfTarget = maj;
      n.wolfRevote = false;
      // 有结果就直接走过狼人阶段。法官模式下节奏仍归法官，不自动推进。
      if (!this.settings.judgeMode) this.advance();
      return;
    }
    // 无多数票：全部作废重投。只让狼队自己知道，不广播给好人。
    n.wolfVotes = {};
    n.wolfTarget = null;
    n.wolfRevote = true;
  }

  _resolveNight() {
    const n = this.night;
    const guardTarget = n.guardTarget;
    const heal = n.witchHeal;
    const poison = n.witchPoison;
    // 刀口在狼人全员投完票时就已经敲定（见 _resolveWolfVote），这里直接用
    const wolfTarget = n.wolfTarget || null;
    const deaths = [];

    if (wolfTarget) {
      const protectedBy = guardTarget === wolfTarget;
      const healedBy = heal === wolfTarget;
      if (!protectedBy && !healedBy) deaths.push({ seat: wolfTarget, cause: 'wolfKill' });
      else if (this.settings.rules.guardWitchConflict && protectedBy && healedBy) {
        deaths.push({ seat: wolfTarget, cause: 'conflict' }); // 守救相克
      }
    }
    // 守救相克：即使无狼刀，守护+解药同人也死
    if (guardTarget && heal === guardTarget && this.settings.rules.guardWitchConflict) {
      deaths.push({ seat: guardTarget, cause: 'conflict' });
    }
    if (poison) deaths.push({ seat: poison, cause: 'poison' });

    const seen = new Set();
    const unique = deaths.filter(d => !seen.has(d.seat) && seen.add(d.seat));
    n.deaths = unique;
    this.pendingDay = [];
    this.afterQueue = 'day';

    // 先把「天亮了」播报出去，再报昨夜结果——反过来读着别扭
    // （先前是「昨夜是平安夜」出现在「天亮了」之前）。
    this._startPhase(PHASE.DAY_START);

    // 首日按面杀主流：先竞选警长，竞选结束再公布昨夜死讯。
    // 此时暂不扣血，昨夜死者仍可参加竞选——线下他们这时确实还不知道自己已死。
    if (this.day === 1 && this.settings.rules.sheriffBeforeDeath) {
      this._deferredNightDeaths = unique;
      this._news('首日先进行警长竞选，竞选结束后公布昨夜死讯');
    } else {
      this._applyNightDeaths(unique);
      if (this._checkVictory()) { this.touch(); return; }
    }

    // 昨夜结果是在 _startPhase 之后才写进 news 的，必须再广播一次：
    // 否则客户端停留在「天亮了」那一版快照上，根本看不到平安夜/死亡播报。
    this.touch();
  }

  /** 把「昨夜结果」真正写入状态并播报；首日延迟结算与其它夜晚共用这一段。 */
  _applyNightDeaths(deaths) {
    if (!deaths.length) {
      this._news('昨夜是平安夜');
      return;
    }
    for (const d of deaths) {
      const p = this._playerAt(d.seat);
      if (!p || !p.alive) continue;   // 幂等：已经因其它原因出局的人不重复结算
      p.alive = false;
      this.totalDeaths++;
      this._news(`${d.seat}号 在昨夜死亡`);
      this._queueDeathEvents(d);
    }
  }

  /**
   * 首日竞选结束 → 公布昨夜死讯。
   * @returns {boolean} 是否确实有被延迟的结算
   */
  _flushDeferredNightDeaths() {
    if (!this._deferredNightDeaths) return false;
    const deaths = this._deferredNightDeaths;
    this._deferredNightDeaths = null;
    this._applyNightDeaths(deaths);
    this._checkVictory();
    return true;
  }

  /**
   * 死亡后要排的后续事件。
   *
   * **遗言只有「被投票放逐」才有。** 夜间被刀 / 被毒 / 守救相克、
   * 猎人开枪带走、白狼王自爆带走——都不留遗言。
   * （之前不分死因一律排遗言，导致夜里被刀的人第二天还要发言。）
   */
  _queueDeathEvents(d) {
    if (d.cause === 'exile') {
      this.pendingDay.push({ type: 'lastWords', seat: d.seat });
    }
    const role = this._roleOfSeat(d.seat);
    if (role === 'hunter' && (d.cause === 'wolfKill' || d.cause === 'exile')) {
      this.pendingDay.push({ type: 'hunterShoot', seat: d.seat });
    }
    if (this.sheriff === d.seat) {
      this.pendingDay.push({ type: 'sheriffHandoff', seat: d.seat });
    }
  }

  _processQueue() {
    while (this.pendingDay.length) {
      const ev = this.pendingDay.shift();
      if (ev.type === 'lastWords') {
        const p = this._playerAt(ev.seat);
        if (p && !p.alive) {
          this._startPhase(PHASE.LAST_WORDS, { seat: ev.seat });
          return;
        }
        continue;
      }
      if (ev.type === 'hunterShoot') {
        const p = this._playerAt(ev.seat);
        if (p && p.role === 'hunter') {
          this._startPhase(PHASE.HUNTER_SHOOT, { seat: ev.seat });
          return;
        }
        continue;
      }
      if (ev.type === 'sheriffHandoff') {
        if (this.sheriff === ev.seat) {
          this._startPhase(PHASE.SHERIFF_HANDOFF, { seat: ev.seat });
          return;
        }
        continue;
      }
    }
    if (this.afterQueue === 'night') {
      // 理论上首日死讯不会拖到天黑还没公布；这里兜底，避免延迟结算被吞掉。
      this._flushDeferredNightDeaths();
      if (this.gameOver) return;
      // 延迟结算可能新排入猎人开枪 / 警徽移交，必须先处理完再进夜。
      if (this.pendingDay.length) { this._processQueue(); return; }
      this._enterNight();
      return;
    }
    if (this.day === 1 && !this._sheriffElectionDone) {
      this._startPhase(PHASE.SHERIFF_DECLARE);
      return;
    }
    this._startPhase(PHASE.DAY_TALK);
  }

  // ---------- 白天：警长竞选 ----------

  setDeclaration(playerId, onPodium) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || !p.seat) return { error: '无效玩家' };
    if (this.phase !== PHASE.SHERIFF_DECLARE && this.phase !== PHASE.SHERIFF_SPEECH) {
      return { error: '当前不在上警阶段' };
    }
    if (this.phase === PHASE.SHERIFF_SPEECH && onPodium) return { error: '发言阶段只能退水' };
    if (!this.sheriffState) this._initSheriffState();
    const seat = p.seat;
    if (onPodium) {
      this.sheriffState.onPodium.add(seat);
      this.sheriffState.withdrawn.delete(seat);
    } else {
      this.sheriffState.onPodium.delete(seat);
      this.sheriffState.withdrawn.add(seat);
    }
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  _initSheriffState() {
    this.sheriffState = { onPodium: new Set(), withdrawn: new Set(), votes: new Map(), pkCandidates: [] };
  }

  _allDeclared() {
    return this._livePlayers().every(p => this.sheriffState.onPodium.has(p.seat) || this.sheriffState.withdrawn.has(p.seat));
  }

  _enterSheriffSpeech() {
    if (!this.sheriffState) this._initSheriffState();
    const cands = this._activeCandidates();
    if (cands.length === 0) { this._noSheriff('无人上警，警徽流失，本局无警长'); return; }
    if (cands.length === 1) { this._electSheriff(cands[0]); return; }
    // 警下一个人都没有 → 谁都没资格投警长票 → 直接判警徽流失。
    // 不这样处理的话会先让所有候选人都走一遍无意义的发言，然后卡在投票阶段：
    // 有投票权的人数为 0，没有任何操作能触发推进。
    if (this._sheriffVoters().length === 0) {
      this._noSheriff('全体上警，无警下玩家，警徽流失，本局无警长');
      return;
    }
    this._startPhase(PHASE.SHERIFF_SPEECH, { candidates: cands, speakerIndex: 0, speakerSeat: cands[0] });
  }

  _activeCandidates() {
    return [...this.sheriffState.onPodium]
      .filter(s => !this.sheriffState.withdrawn.has(s))
      .sort((a, b) => a - b);
  }

  _nextSpeechOrVote() {
    const cands = this._activeCandidates();
    const idx = this.phaseState.speakerIndex || 0;
    if (idx + 1 < cands.length) {
      // 候选人依次发言，由当前发言者本人点「结束发言」推进到下一位。
      // 这里直接改 phaseState 而不是 _startPhase，所以播报要手动补一句。
      this.phaseState.speakerIndex = idx + 1;
      this.phaseState.speakerSeat = cands[idx + 1];
      this._news(`${cands[idx + 1]}号 开始竞选发言`);
      this.touch();
      return;
    }
    if (cands.length === 1) { this._electSheriff(cands[0]); return; }
    if (cands.length === 0) { this._noSheriff('无人上警，警徽流失，本局无警长'); return; }
    // 兜底：没有投票权的玩家时不能进入投票阶段，否则没人能操作、阶段永久卡住
    if (this._sheriffVoters().length === 0) {
      this._noSheriff('全体上警，无警下玩家，警徽流失，本局无警长');
      return;
    }
    // 候选人必须随阶段一起下发，否则前端拿不到名单，投票面板会只剩「弃票」
    this._startPhase(PHASE.SHERIFF_VOTE, { candidates: this._activeCandidates() });
  }

  _sheriffVoters() {
    return this._livePlayers().filter(p => !this.sheriffState.onPodium.has(p.seat));
  }

  sheriffVote(playerId, target) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || !p.seat) return { error: '无效玩家' };
    if (this.phase !== PHASE.SHERIFF_VOTE && this.phase !== PHASE.SHERIFF_PK) return { error: '当前不是警长投票' };
    if (!this.sheriffState) return { error: '状态异常' };
    if (this.sheriffState.onPodium.has(p.seat)) return { error: '警上玩家不能投票' };
    // 一经提交不可修改（线下投票不该反复改票）
    if (this.sheriffState.votes.has(playerId)) return { error: '已投票，不可修改' };
    target = Number(target) || 0;
    if (target === p.seat) return { error: '不能投给自己' };
    if (target !== 0) {
      const allowed = this.phase === PHASE.SHERIFF_PK ? this.sheriffState.pkCandidates : this._activeCandidates();
      if (!allowed.includes(target)) return { error: '目标无效' };
    }
    this.sheriffState.votes.set(playerId, target);
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  _allSheriffVoted() {
    const voters = this._sheriffVoters();
    if (!voters.length) return true;
    return voters.every(v => this.sheriffState.votes.has(v.playerId));
  }

  _resolveSheriffVote() {
    const tally = this._tally(this.sheriffState.votes, null);
    if (tally.size === 0) { this._noSheriff(); return; }
    const winners = this._maxKeys(tally);
    if (winners.length === 1) { this._electSheriff(winners[0]); return; }
    this.sheriffState.pkCandidates = winners;
    this.sheriffState.votes.clear(); // 进入 PK 需重新投票
    this._startPhase(PHASE.SHERIFF_PK, { pkCandidates: winners });
  }

  _resolveSheriffPk() {
    const tally = this._tally(this.sheriffState.votes, null);
    if (tally.size === 0) { this._noSheriff(); return; }
    const winners = this._maxKeys(tally);
    if (winners.length === 1) { this._electSheriff(winners[0]); return; }
    this._noSheriff();
  }

  _electSheriff(seat) {
    this.sheriff = seat;
    this._news(`${seat}号 当选警长`);
    this.sheriffState = null;
    this._finishSheriffElection();
  }

  _noSheriff(reason) {
    this._news(reason || '无人当选警长，本局无警长');
    this.sheriffState = null;
    this._finishSheriffElection();
  }

  /**
   * 首日警长竞选结束：公布昨夜死讯，再处理由死讯引出的后续事件
   * （猎人开枪 / 警徽移交），最后进入白天发言。
   *
   * 注意顺序：先 set sheriff 再 flush，这样「昨夜死的人恰好当选警长」时，
   * _queueDeathEvents 能看到新的 sheriff 并把警徽移交排进队列。
   */
  _finishSheriffElection() {
    this._sheriffElectionDone = true;
    this._flushDeferredNightDeaths();
    if (this.gameOver) { this.touch(); return; }
    this._processQueue();
  }

  // ---------- 白天：放逐投票 ----------

  _enterDayVote() {
    this.voteState = { votes: new Map(), pkCandidates: [] };
    this._startPhase(PHASE.DAY_VOTE);
  }

  _voteEligible() {
    return this._livePlayers().filter(p => !p.idiotFlipped);
  }

  exileVote(playerId, target) {
    const p = this.players.get(playerId);
    if (!p || !p.alive || !p.seat) return { error: '无效玩家' };
    if (this.phase !== PHASE.DAY_VOTE && this.phase !== PHASE.VOTE_PK) return { error: '当前不是放逐投票' };
    if (p.idiotFlipped) return { error: '白痴失去投票权' };
    if (!this.voteState) return { error: '状态异常' };
    // 一经提交不可修改（线下投票不该反复改票）
    if (this.voteState.votes.has(playerId)) return { error: '已投票，不可修改' };
    target = Number(target) || 0;
    if (target === p.seat) return { error: '不能投给自己' };
    if (target !== 0) {
      if (this.phase === PHASE.VOTE_PK) {
        if (!this.voteState.pkCandidates.includes(target)) return { error: '目标无效' };
      } else if (!this._validTarget(target)) {
        return { error: '目标无效' };
      }
    }
    this.voteState.votes.set(playerId, target);
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  _allVoted() {
    const voters = this._voteEligible();
    if (!voters.length) return true;
    return voters.every(v => this.voteState.votes.has(v.playerId));
  }

  _tally(votes, weightFor) {
    const tally = new Map();
    for (const [pid, target] of votes) {
      if (!target) continue;
      const p = this.players.get(pid);
      const w = weightFor ? weightFor(p) : 2;
      tally.set(target, (tally.get(target) || 0) + w);
    }
    return tally;
  }

  _maxKeys(tally) {
    let max = 0;
    const keys = [];
    for (const [k, v] of tally) {
      if (v > max) { max = v; keys.length = 0; keys.push(k); }
      else if (v === max) keys.push(k);
    }
    return keys;
  }

  _sheriffWeight = (p) => (p.seat === this.sheriff ? Math.round(2 * this.settings.rules.sheriffVoteWeight) : 2);

  _resolveDayVote() {
    const tally = this._tally(this.voteState.votes, this._sheriffWeight);
    if (tally.size === 0) {
      this._news('投票无人被放逐（平安日）');
      this._enterNight();
      return;
    }
    const winners = this._maxKeys(tally);
    if (winners.length === 1) { this._doExile(winners[0]); return; }
    this.voteState.pkCandidates = winners;
    this.voteState.votes.clear(); // 进入 PK 需重新投票
    this._news(`${winners.join('、')}号 平票，进入 PK`);
    this._startPhase(PHASE.VOTE_PK, { pkCandidates: winners });
  }

  _resolvePkVote() {
    const tally = this._tally(this.voteState.votes, this._sheriffWeight);
    if (tally.size === 0) {
      this._news('PK 无人出局（平安日）');
      this._enterNight();
      return;
    }
    const winners = this._maxKeys(tally);
    if (winners.length === 1) { this._doExile(winners[0]); return; }
    this._news('PK 仍平票，无人出局');
    this._enterNight();
  }

  _doExile(seat) {
    const p = this._playerAt(seat);
    if (!p) return;
    this._news(`${seat}号 被放逐`);
    if (p.role === 'idiot' && !p.idiotFlipped) {
      p.idiotFlipped = true;
      p.revealed = true;
      this._news(`白痴 ${seat}号 翻牌免死，失去投票权`);
      this.pendingDay = [];
      this.afterQueue = 'night';
      if (this._checkVictory()) { this.touch(); return; }
      this._enterNight();
      return;
    }
    p.alive = false;
    this.totalDeaths++;
    if (this.settings.rules.revealOnExile) p.revealed = true;
    this.pendingDay = [];
    this.afterQueue = 'night';
    this._queueDeathEvents({ seat, cause: 'exile' });
    if (this._checkVictory()) { this.touch(); return; }
    this._processQueue();
  }

  // ---------- 白狼王自爆 ----------

  _blastAllowed() {
    return BLAST_PHASES.has(this.phase);
  }

  /**
   * 狼人自爆。
   *
   * 时机：只能在**白天**的发言/讨论/投票阶段（夜晚不能自爆）。
   * 效果：翻牌亮明身份 → 立即出局 → **没有遗言** → 当天白天立刻结束，直接进入黑夜。
   * 投票：若正在进行放逐投票，投票作废，不公布放逐结果。
   * 后续：自爆的狼已出局，自然不能参与当晚刀人（_liveWolves 不含死者）；
   *       若他是最后一只狼，好人直接获胜（见 _checkVictory）。
   *
   * 普通狼人只需自爆；**白狼王**额外带走一名玩家（这是它的角色能力）。
   */
  blast(playerId, target) {
    const p = this.players.get(playerId);
    if (!p || !p.seat) return { error: '无效玩家' };
    if (!isWolf(p.role)) return { error: '只有狼人可以自爆' };
    if (!p.alive) return { error: '你已出局' };
    if (!this._blastAllowed()) return { error: '只能在白天的发言 / 讨论 / 投票阶段自爆' };

    // 首日先竞选时，昨夜死讯还没公布。狼人若在警长竞选期间自爆，
    // 必须先公布死讯（面杀规则里的「自爆吞警徽」也要求先报死讯），
    // 否则延迟结算会跟着竞选一起被丢掉。
    if (this._deferredNightDeaths) {
      this._flushDeferredNightDeaths();
      if (this.gameOver) return { error: '游戏已结束' };
      if (!p.alive) return { error: '你已出局' };
    }

    const isKing = p.role === 'whiteWolfKing';
    let victim = null;
    if (isKing) {
      victim = Number(target);
      if (!this._validTarget(victim, { exclude: [p.seat] })) {
        return { error: '白狼王自爆需要选择一名要带走的玩家' };
      }
    }

    const tp = victim ? this._playerAt(victim) : null;
    p.alive = false;
    p.revealed = true;              // 自爆必须翻牌亮明身份
    if (tp) { tp.alive = false; tp.revealed = false; }  // 被带走的玩家不翻牌
    this.totalDeaths += tp ? 2 : 1;

    this._news(tp
      ? `白狼王 ${p.seat}号 自爆，带走 ${victim}号，当天白天结束`
      : `${p.seat}号 狼人自爆，当天白天结束`);

    // 投票作废：正在进行的放逐投票（或警长竞选）直接丢弃，不公布结果
    this.voteState = null;
    this.sheriffState = null;

    // 自爆者不留遗言；当天白天立刻结束，直接进入黑夜。
    // 保留 pendingDay：首日先竞选时，上面 flush 可能刚排入昨夜死者的
    // 猎人开枪 / 警徽移交，这些必须处理完才能进夜。
    this.afterQueue = 'night';
    for (const seat of [p.seat, victim].filter(Boolean)) {
      if (this.sheriff === seat) this.pendingDay.push({ type: 'sheriffHandoff', seat });
    }

    if (this._checkVictory()) { this.touch(); return { ok: true }; }
    this._processQueue();
    return { ok: true };
  }

  // ---------- 猎人开枪 / 警徽 / 遗言 ----------

  hunterShoot(playerId, target) {
    const p = this.players.get(playerId);
    if (!p) return { error: '无效玩家' };
    if (this.phase !== PHASE.HUNTER_SHOOT) return { error: '当前不是开枪阶段' };
    if (this.phaseState.seat !== p.seat) return { error: '不是你开枪' };
    if (this.phaseState.done) return { error: '已结算' };
    target = Number(target) || 0;
    if (target !== 0) {
      if (!this._validTarget(target)) return { error: '目标无效' };
      const tp = this._playerAt(target);
      tp.alive = false;
      this.totalDeaths++;
      this._news(`猎人 ${p.seat}号 开枪，带走 ${target}号`);
      p.revealed = true;
      // 注意：这里**不要**覆盖 afterQueue、也不要清空 pendingDay。
      //
      // 猎人有两种死法，后续流向完全相反：
      //   · 被放逐  → _doExile 已把 afterQueue 设为 'night'（当天事务已了）
      //   · 夜里被刀 → _resolveNight 设的是 'day'（天亮后才开枪，白天还没开始）
      // 无条件写成 'night' 会让「夜里被刀的猎人开枪后直接跳进黑夜」，整个白天被吞掉。
      // 同理清空 pendingDay 会丢掉待处理的警徽移交（猎人自己可能就是警长）。
      this._queueDeathEvents({ seat: target, cause: 'hunter' });
      if (this._checkVictory()) { this.phaseState.done = true; this.touch(); return { ok: true }; }
    } else {
      this._news(`猎人 ${p.seat}号 选择不开枪`);
      p.revealed = true;
    }
    this.phaseState.done = true;
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  sheriffHandoff(playerId, payload) {
    const p = this.players.get(playerId);
    if (!p) return { error: '无效玩家' };
    if (this.phase !== PHASE.SHERIFF_HANDOFF) return { error: '当前不是移交警徽阶段' };
    if (this.phaseState.seat !== p.seat) return { error: '不是你移交警徽' };
    if (this.phaseState.done) return { error: '已结算' };
    const mode = payload.mode;
    if (mode === 'pass') {
      const target = Number(payload.target);
      if (!this._validTarget(target)) return { error: '目标无效' };
      this.sheriff = target;
      this._news(`警长 ${p.seat}号 将警徽移交给 ${target}号`);
    } else if (mode === 'tear') {
      this.sheriff = null;
      this._news(`警长 ${p.seat}号 撕毁警徽`);
    } else {
      return { error: '无效操作' };
    }
    this.phaseState.done = true;
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  roleConfirm(playerId) {
    const p = this.players.get(playerId);
    if (!p) return { error: '无效玩家' };
    if (this.phase !== PHASE.ROLE_REVEAL) return { error: '当前不是确认身份阶段' };
    p.roleReady = true;
    this.touch();
    this._maybeComplete();
    return { ok: true };
  }

  _allRoleConfirmed() {
    return this._livePlayers().every(p => p.roleReady);
  }

  // ---------- 胜负判定 ----------

  _checkVictory() {
    const wolves = this._liveWolves().length;
    let winners = null;

    if (wolves === 0) {
      winners = CAMPS.GOOD;
    } else if (this.settings.rules.killSide) {
      // 屠边：杀光所有神职 或 杀光所有平民即获胜。
      // 只对「开局时确实存在」的那一类判定——否则没有村民的板子会一开局就判狼胜。
      const live = this._livePlayers();
      const godsLeft = live.filter(p => GOD_ROLES.includes(p.role)).length;
      const villagersLeft = live.filter(p => p.role === 'villager').length;
      const had = [...this.players.values()].filter(p => p.seat);
      const hadGods = had.some(p => GOD_ROLES.includes(p.role));
      const hadVillagers = had.some(p => p.role === 'villager');
      if ((hadGods && godsLeft === 0) || (hadVillagers && villagersLeft === 0)) winners = CAMPS.WOLF;
    } else {
      // 屠城：狼人数量追平或反超好人即获胜
      const good = this._livePlayers().length - wolves;
      if (wolves >= good) winners = CAMPS.WOLF;
    }
    if (winners) {
      this.gameOver = { winners };
      this._news(winners === CAMPS.GOOD ? '🎉 好人阵营获胜！' : '🐺 狼人阵营获胜！');
      for (const p of this.players.values()) if (p.seat) p.revealed = true;
      this.phase = PHASE.GAME_OVER;
      this.phaseState = {};
      return true;
    }
    return false;
  }

  // ---------- 夜间行动 ----------

  submitNightAction(playerId, action) {
    const p = this.players.get(playerId);
    if (!p || !p.seat) return { error: '无效玩家' };
    if (!p.alive) return { error: '你已死亡' };
    const seat = p.seat;
    const n = this.night;
    const type = action.type;
    switch (type) {
      case 'wolfKill': {
        if (this.phase !== PHASE.NIGHT_WOLVES) return { error: '现在不是狼人行动阶段' };
        if (!isWolf(p.role)) return { error: '你不是狼人' };
        const target = Number(action.target);
        if (!this._validTarget(target, { exclude: [seat], excludeWolves: true })) return { error: '目标无效' };
        n.wolfVotes[seat] = target;
        // 全员选完后立刻计票：过半敲定刀口，无人过半则清空重投
        this._resolveWolfVote();
        this.touch();
        return { ok: true };
      }
      case 'guardProtect': {
        if (this.phase !== PHASE.NIGHT_GUARD) return { error: '现在不是守卫行动阶段' };
        if (p.role !== 'guard') return { error: '你不是守卫' };
        const target = Number(action.target);
        if (!this._validTarget(target, { exclude: [p.guardLastTarget || -1] })) return { error: '目标无效（不能连续守护同一人）' };
        n.guardTarget = target;
        p.guardLastTarget = target;
        this.touch();
        this._finishNightAction();   // 守护完直接走，不用再点结束
        return { ok: true };
      }
      case 'seerCheck': {
        if (this.phase !== PHASE.NIGHT_SEER) return { error: '现在不是预言家行动阶段' };
        if (p.role !== 'seer') return { error: '你不是预言家' };
        // 每晚只能查验一人。少了这道守卫，预言家在一夜里反复调用就能把
        // 全场身份逐个验出来——seerHistory 会被无限追加。
        if (n.seerTarget != null) return { error: '今晚已经查验过了' };
        const target = Number(action.target);
        // 历史判断放在有效性之前：命中历史时「已经查验过」远比「目标无效」说得清楚
        // （被验过的人可能当晚已经死了，先报「目标无效」会让人以为是选错了人）
        if (p.seerHistory.some(h => h.seat === target)) {
          return { error: `${target}号已经查验过了，换一个人` };
        }
        if (!this._validTarget(target, { exclude: [seat] })) return { error: '目标无效' };
        n.seerTarget = target;
        const tp = this._playerAt(target);
        n.seerResult = { seat: target, camp: isWolf(tp.role) ? 'wolf' : 'good' };
        p.seerHistory.push({ seat: target, camp: n.seerResult.camp, day: this.day });
        this.touch();
        this._finishNightAction();   // 验完直接走
        return { ok: true };
      }
      case 'witchAct': {
        if (this.phase !== PHASE.NIGHT_WITCH) return { error: '现在不是女巫行动阶段' };
        if (p.role !== 'witch') return { error: '你不是女巫' };
        const kind = action.kind;
        const target = Number(action.target);
        if (kind === 'heal') {
          if (p.witchHealUsed) return { error: '解药已使用' };
          if (!n.wolfTarget) return { error: '今夜无人被刀，无法使用解药' };
          if (target !== n.wolfTarget) return { error: '解药只能救被刀的人' };
          if (target === seat && !(this.day === 1 && this.settings.rules.firstNightWitchSelfHeal)) return { error: '今夜不能救自己' };
          p.witchHealUsed = true;
          n.witchHeal = target;
        } else if (kind === 'poison') {
          if (p.witchPoisonUsed) return { error: '毒药已使用' };
          if (!this._validTarget(target, { exclude: [seat] })) return { error: '目标无效' };
          p.witchPoisonUsed = true;
          n.witchPoison = target;
        } else {
          return { error: '无效操作' };
        }
        this.touch();
        this._finishNightAction();   // 用完药直接走，不用再点结束
        return { ok: true };
      }
      default:
        return { error: '未知操作' };
    }
  }

  /** 房主/法官：回到大厅（保留玩家与座位），便于再来一局。 */
  resetGame(playerId) {
    if (playerId !== this.hostPlayerId && playerId !== this.judgePlayerId) return { error: '无权限' };
    this.gameStarted = false;
    this.gameOver = null;
    this.phase = PHASE.LOBBY;
    this.phaseState = {};
    this.day = 0;
    this.sheriff = null;
    this.sheriffState = null;
    this.voteState = null;
    this.night = null;
    this.pendingDay = [];
    this._deferredNightDeaths = null;
    this._sheriffElectionDone = false;
    this.news = [];
    this.totalDeaths = 0;
    for (const p of this.players.values()) {
      if (p.seat) {
        p.role = null; p.alive = true; p.roleReady = false; p.revealed = false;
        p.idiotFlipped = false; p.witchHealUsed = false; p.witchPoisonUsed = false;
        p.guardLastTarget = null; p.seerHistory = [];
      }
      // 座位一并清空：回到大厅后大家重新选座。
      // 否则每局都钉死在同一位置，想换座位只能退出房间重进。
      p.seat = null;
    }
    this.seatMap = new Array(this.settings.playerCount + 1).fill(null);
    this.touch();
    return { ok: true };
  }

  // ---------- 法官指令 ----------

  judgeCommand(playerId, cmd, payload = {}) {
    if (!this.settings.judgeMode) return { error: '本局不是法官模式' };
    if (playerId !== this.judgePlayerId) return { error: '无权限' };
    switch (cmd) {
      case 'advance': this.advance(); return { ok: true };
      case 'setDeath': {
        const p = this._playerAt(Number(payload.seat));
        if (!p) return { error: '玩家不存在' };
        p.alive = !!payload.alive;
        this.touch();
        return { ok: true };
      }
      case 'endGame': {
        const camp = payload.camp === 'wolf' ? CAMPS.WOLF : CAMPS.GOOD;
        this.gameOver = { winners: camp, forced: true };
        for (const p of this.players.values()) if (p.seat) p.revealed = true;
        this.phase = PHASE.GAME_OVER;
        this.phaseState = {};
        this._news(camp === CAMPS.GOOD ? '法官裁定：好人阵营获胜' : '法官裁定：狼人阵营获胜');
        this.touch();
        return { ok: true };
      }
      default: return { error: '未知指令' };
    }
  }

  // ---------- 快照 ----------

  /** 为某个观看者生成快照（公开信息 + 该玩家私密信息 + 法官额外信息）。 */
  snapshot(viewerId) {
    const me = this.players.get(viewerId);
    const s = {
      roomCode: this.code,
      judgeMode: this.settings.judgeMode,
      gameStarted: this.gameStarted,
      gameOver: this.gameOver,
      phase: this.phase,
      phaseState: this._publicPhaseState(),
      day: this.day,
      news: this.news,
      sheriff: this.sheriff,
      players: this._publicPlayers(),
      settings: this._publicSettings(),
      canStart: this.canStart(),
      // 确认身份阶段的进度。属于公开信息：只暴露「几人已确认」，不泄露任何身份。
      // 前端用它替代倒计时显示——该阶段没有 deadline，玩家需要看到还差谁。
      roleConfirm: this.phase === PHASE.ROLE_REVEAL
        ? (() => {
            const live = this._livePlayers();
            return { ready: live.filter(p => p.roleReady).length, total: live.length };
          })()
        : null,
      waiting: [...this.players.values()]
        .filter(p => !p.isJudge && !p.seat)
        .map(p => ({ playerId: p.playerId, name: p.name, connected: p.connected })),
      judge: this.settings.judgeMode
        ? (() => { const j = this.players.get(this.judgePlayerId); return j ? { name: j.name, connected: j.connected } : null; })()
        : null,
      me: null,
      private: null,
    };
    if (me) {
      s.me = {
        playerId: me.playerId, name: me.name, seat: me.seat,
        alive: me.alive,
        role: me.role,
        roleName: me.role ? ROLES[me.role].name : null,
        roleDesc: me.role ? ROLES[me.role].description : null,
        isWolf: me.role ? isWolf(me.role) : false,
        wolfTeammates: me.role && isWolf(me.role) ? this._wolfTeammates(me.seat) : [],
        isJudge: !!me.isJudge,
        isHost: me.playerId === this.hostPlayerId,
        idiotFlipped: !!me.idiotFlipped,
        connected: me.connected,
      };
      s.private = this._privateFor(me);
    }
    if (this.settings.judgeMode && this.judgePlayerId === viewerId) {
      s.judge = this._judgeState();
    }
    return s;
  }

  /**
   * 下发给全场的 phaseState。
   *
   * 目前只有猎人开枪阶段需要裁剪：phaseState.seat 是「谁在开枪」，而猎人的身份
   * 本来是暗的——座位号一旦公开，全场立刻知道昨夜死掉的那个人是猎人。
   * 其余阶段（遗言、警徽移交）的座位号本来就公开，照常下发。
   */
  _publicPhaseState() {
    const ps = this.phaseState || {};
    // masked / maskUntil 是掩护阶段的内部状态，**绝不能下发**：
    // 谁能读到 masked，就等于知道「这个角色已经出局了」，掩护就白做了。
    const { masked, maskUntil, ...rest } = ps;
    // 猎人开枪阶段的座位号同样保密（见下）
    if (this.phase === PHASE.HUNTER_SHOOT) {
      const { seat: _seat, ...noSeat } = rest;
      return noSeat;
    }
    return rest;
  }

  _publicPlayers() {
    const arr = [];
    for (let seat = 1; seat <= this.settings.playerCount; seat++) {
      const p = this._playerAt(seat);
      if (!p) {
        arr.push({ seat, name: null, alive: false, connected: false, isSheriff: false, revealed: false, role: null, roleName: null });
        continue;
      }
      const showRole = p.revealed || !!this.gameOver;
      arr.push({
        seat, name: p.name, alive: p.alive, connected: p.connected,
        isSheriff: this.sheriff === seat,
        revealed: !!p.revealed,
        role: showRole ? p.role : null,
        roleName: showRole ? ROLES[p.role].name : null,
        idiotFlipped: !!p.idiotFlipped,
      });
    }
    return arr;
  }

  _publicSettings() {
    const s = this.settings;
    return {
      playerCount: s.playerCount,
      judgeMode: s.judgeMode,
      roles: s.roles,
      rules: s.rules,
    };
  }

  _privateFor(p) {
    const info = {
      roleReady: !!p.roleReady,
      // 所有狼人都能自爆；白狼王额外能带走一人（前端据此决定要不要给目标选择器）
      canBlast: isWolf(p.role) && p.alive && this._blastAllowed(),
      blastTakesVictim: p.role === 'whiteWolfKing',
      seerHistory: p.seerHistory,
      // 今夜的查验结果，供预言家的操作卡片直接展示（不用 toast——一闪就没了）
      seerResult: (p.role === 'seer' && this.night) ? this.night.seerResult : null,
      guardLastTarget: p.guardLastTarget,
      witch: null,
      wolfVote: null,
      onPodium: this.sheriffState ? this.sheriffState.onPodium.has(p.seat) : false,
      withdrawn: this.sheriffState ? this.sheriffState.withdrawn.has(p.seat) : false,
      canDeclare: (this.phase === PHASE.SHERIFF_DECLARE || this.phase === PHASE.SHERIFF_SPEECH) && p.alive,
      sheriffCanVote: (this.phase === PHASE.SHERIFF_VOTE || this.phase === PHASE.SHERIFF_PK)
        && p.alive && this.sheriffState && !this.sheriffState.onPodium.has(p.seat),
      sheriffHasVoted: this.sheriffState ? this.sheriffState.votes.has(p.playerId) : false,
      // 0 表示弃票，未投过是 null —— 前端据此区分「弃票」与「还没投」
      sheriffMyVote: this.sheriffState && this.sheriffState.votes.has(p.playerId)
        ? this.sheriffState.votes.get(p.playerId) : null,
      hasVoted: this.voteState ? this.voteState.votes.has(p.playerId) : false,
      myVote: this.voteState ? (this.voteState.votes.get(p.playerId) || 0) : 0,
      canVote: (this.phase === PHASE.DAY_VOTE || this.phase === PHASE.VOTE_PK) && p.alive && !p.idiotFlipped,
      canEndPhase: this._canEndPhase(p),
      // 猎人开枪阶段：只让猎人本人知道轮到谁（座位号对全场保密，见 _publicPhaseState）
      canShoot: this.phase === PHASE.HUNTER_SHOOT
        && this.phaseState && this.phaseState.seat === p.seat,
      nightPhase: this.night ? this.night.day : 0,
    };
    if (p.role === 'witch') {
      info.witch = {
        healLeft: !p.witchHealUsed,
        poisonLeft: !p.witchPoisonUsed,
        killTarget: this.night ? this.night.wolfTarget : null,
        canSelfHeal: this.day === 1 && this.settings.rules.firstNightWitchSelfHeal,
      };
    }
    if (isWolf(p.role)) {
      const live = this._liveWolves();
      const voted = live.filter(w => this.night && this.night.wolfVotes[w.seat] != null).length;
      info.wolfVote = this.night ? (this.night.wolfVotes[p.seat] || null) : null;
      info.wolfConfirmed = `${voted}/${live.length}`;
      info.wolfAllVoted = this.night ? this._allWolvesVoted() : false;
      info.wolfTally = this.night ? this._wolfTally() : [];   // 票型只在狼队内部共享
      info.wolfRevote = this.night ? !!this.night.wolfRevote : false;
      // 严格过半所需的票数：3 狼要 2 票、4 狼要 3 票、2 狼必须一致
      info.wolfNeed = Math.floor(live.length / 2) + 1;
    }
    return info;
  }

  _judgeState() {
    const players = [];
    for (let seat = 1; seat <= this.settings.playerCount; seat++) {
      const p = this._playerAt(seat);
      players.push({
        seat,
        name: p ? p.name : null,
        role: p ? p.role : null,
        roleName: p && p.role ? ROLES[p.role].name : null,
        alive: p ? p.alive : false,
        isSheriff: this.sheriff === seat,
      });
    }
    return {
      players,
      phase: this.phase,
      phaseState: this.phaseState,
      sheriff: this.sheriff,
      night: this.night,
      sheriffState: this.sheriffState
        ? {
            onPodium: [...this.sheriffState.onPodium],
            withdrawn: [...this.sheriffState.withdrawn],
            votes: [...this.sheriffState.votes.entries()].map(([pid, t]) => [this._seatOf(pid), t]),
            pkCandidates: this.sheriffState.pkCandidates,
          }
        : null,
      voteState: this.voteState
        ? {
            votes: [...this.voteState.votes.entries()].map(([pid, t]) => [this._seatOf(pid), t]),
            pkCandidates: this.voteState.pkCandidates,
          }
        : null,
    };
  }
}
