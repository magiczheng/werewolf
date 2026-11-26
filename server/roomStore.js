import { Room, buildSettings, PHASE } from './engine.js';

const FIELDS = ['code', 'gameId', 'phaseId', 'revision', 'historySeq', 'settings', 'hostPlayerId', 'skipRoleReveal',
  'judgePlayerId', 'gameStarted', 'gameOver', 'phase', 'phaseState', 'day', 'sheriff', 'night',
  'pendingDay', 'afterQueue', '_deferredNightDeaths', '_sheriffElectionDone', 'totalDeaths',
  'news', 'newsSeq', 'lastActive', 'history', 'privateHistory', 'voteHistory'];

// Older room saves contain complete sentences. Only upgrade known engine-generated
// seat references, leaving arbitrary display names in other announcements intact.
const LEGACY_NAMED_EVENT = /^(?:\d+号 (?:开始(?:竞选|白天)发言|已结束白天发言|发表遗言|请移交警徽|在昨夜死亡|当选警长|被放逐|狼人自爆)|(?:警长|白痴|白狼王|猎人) \d+号 |(?:\d+、)*\d+号 平票)/;
const LEGACY_ACTION = /^\d+号 [^·]+ · (?:投刀|守护|查验|使用解药救|使用毒药毒)/;

function restoreAnnouncementNames(room) {
  for (const entry of [...room.news, ...room.history, ...room.privateHistory]) {
    const death = /^(\d+)号 在昨夜死亡$/.exec(entry.text);
    if (death) entry.nightDeathSeat = Number(death[1]);
    if (LEGACY_NAMED_EVENT.test(entry.text) || LEGACY_ACTION.test(entry.text)) {
      entry.text = entry.text.replace(/(\d+(?:、\d+)*)号/g,
        (_, seats) => seats.split('、').map(seat => room._labelSeat(Number(seat))).join('、'));
    }
  }
}

export function serializeRoom(room) {
  const data = Object.fromEntries(FIELDS.map(k => [k, room[k]]));
  data.players = [...room.players.values()];
  data.receipts = [...room.receipts];
  data.sheriffState = room.sheriffState && { ...room.sheriffState,
    onPodium: [...room.sheriffState.onPodium], withdrawn: [...room.sheriffState.withdrawn], votes: [...room.sheriffState.votes] };
  data.voteState = room.voteState && { ...room.voteState, votes: [...room.voteState.votes] };
  return JSON.stringify({ version: 1, data });
}

export function restoreRoom(json, onChange, { disconnected = true } = {}) {
  const record = JSON.parse(json);
  if (record.version !== 1 || !record.data) throw new Error('不支持的对局存档版本');
  const d = record.data;
  const settings = buildSettings(d.settings);
  if (!Array.isArray(d.players) || !d.players.length || d.players.length > 17 || !Object.values(PHASE).includes(d.phase)) throw new Error('对局存档无效');
  const room = new Room({ code: d.code, settings, hostPlayerId: d.hostPlayerId, hostName: '', onChange });
  for (const key of FIELDS) if (Object.hasOwn(d, key)) room[key] = d[key];
  room.settings = settings;
  if (disconnected && d.players.some(p => p.connected)) room.lastActive = Date.now();
  room.players = new Map(d.players.map(p => [p.playerId, { ...p, ...(disconnected ? { connected: false, disconnectedAt: p.disconnectedAt || Date.now() } : {}) }]));
  room.seatMap = new Array(settings.playerCount + 1).fill(null);
  for (const p of room.players.values()) {
    if (p.seat != null) {
      if (!Number.isInteger(p.seat) || p.seat < 1 || p.seat > settings.playerCount || room.seatMap[p.seat]) throw new Error('存档座位无效');
      room.seatMap[p.seat] = p.playerId;
    }
  }
  const namesBySeat = room._seatedNames();
  for (const round of room.voteHistory) round.namesBySeat ??= namesBySeat;
  restoreAnnouncementNames(room);
  room.receipts = new Map(d.receipts || []);
  room.sheriffState = d.sheriffState && { ...d.sheriffState, onPodium: new Set(d.sheriffState.onPodium), withdrawn: new Set(d.sheriffState.withdrawn), votes: new Map(d.sheriffState.votes) };
  // Older speech snapshots still retain the initial order, so recover known candidacies.
  if (room.sheriffState && room.phase === PHASE.SHERIFF_SPEECH) {
    for (const seat of room.phaseState.speechOrder || []) room.sheriffState.onPodium.add(seat);
  }
  room.voteState = d.voteState && { ...d.voteState, votes: new Map(d.voteState.votes) };
  return room;
}

export function createRoomStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS room_snapshots (code TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL)');
  const save = db.prepare('INSERT INTO room_snapshots (code, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at');
  const remove = db.prepare('DELETE FROM room_snapshots WHERE code = ?');
  const all = db.prepare('SELECT code, state FROM room_snapshots');
  return {
    save(room) { save.run(room.code, serializeRoom(room), room.lastActive); },
    remove(code) { remove.run(code); },
    load(onChange) {
      const rooms = [];
      for (const row of all.all()) {
        try { rooms.push(restoreRoom(row.state, onChange)); }
        catch (error) { console.error(JSON.stringify({ level: 'error', event: 'room_restore_failed', roomCode: row.code, message: error.message })); }
      }
      return rooms;
    },
  };
}
