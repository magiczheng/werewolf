// Public participation never includes live ballot targets or hidden night actor seats.
export function activityFor(room, viewer) {
  const phase = room.phase;
  const live = room._livePlayers();
  const statuses = [];
  const add = (p, state, label) => statuses.push({ seat: p.seat, state, label });
  const result = (label, kind = 'public') => ({ kind, label, seats: statuses,
    pending: statuses.filter(p => p.state === 'pending' || p.state === 'speaking').map(p => p.seat),
    completed: statuses.filter(p => p.state === 'done').length,
    total: statuses.filter(p => ['done', 'pending', 'speaking'].includes(p.state)).length });
  if (room.gameOver || !room.gameStarted) return result(room.gameOver ? '本局已结束' : '等待开局');
  if (phase === 'roleReveal') {
    for (const p of live) add(p, p.roleReady ? 'done' : 'pending', p.roleReady ? '已确认' : '待确认');
    return result('确认身份');
  }
  if (phase === 'sheriffDeclare') {
    for (const p of live) {
      const ran = room.sheriffState?.onPodium.has(p.seat);
      const out = room.sheriffState?.withdrawn.has(p.seat);
      add(p, ran || out ? 'done' : 'pending', ran ? (out ? '已退水' : '已上警') : out ? '不上警' : '待决定');
    }
    return result('上警选择');
  }
  if (phase === 'sheriffSpeech') {
    const active = room._activeCandidates();
    for (const p of live) {
      const current = active.includes(p.seat) && room.phaseState.speakerSeat === p.seat;
      add(p, current ? 'speaking' : 'neutral', current ? '正在发言' : active.includes(p.seat) ? '候选人'
        : room.sheriffState?.onPodium.has(p.seat) ? '已退水' : '警下');
    }
    return result('竞选发言');
  }
  if (['dayVote', 'votePk', 'sheriffVote', 'sheriffPk'].includes(phase)) {
    const sheriff = phase.startsWith('sheriff');
    const state = sheriff ? room.sheriffState : room.voteState;
    const eligible = new Set((sheriff ? room._sheriffVoters() : room._voteEligible()).map(p => p.seat));
    for (const p of live) {
      if (eligible.has(p.seat)) {
        const done = !!state?.votes.has(p.playerId);
        add(p, done ? 'done' : 'pending', done ? '已投票' : '待投票');
      } else add(p, 'excluded', sheriff ? (room._activeCandidates().includes(p.seat) ? '候选人 · 不投票' : '退水 · 不投票')
        : p.idiotFlipped ? '无投票权' : 'PK · 不投票');
    }
    return result(sheriff ? '警长投票' : phase === 'votePk' ? '放逐 PK 投票' : '放逐投票');
  }
  if (['lastWords', 'sheriffHandoff'].includes(phase)) {
    const p = room._playerAt(room.phaseState.seat);
    if (p) add(p, phase === 'lastWords' ? 'speaking' : 'pending', phase === 'lastWords' ? '正在遗言' : '待移交警徽');
    return result(phase === 'lastWords' ? '遗言发言' : '警徽移交');
  }
  if (phase.startsWith('night') || phase === 'hunterShoot') {
    const judge = viewer?.isJudge;
    let actors = [];
    if (phase === 'hunterShoot') actors = [room._playerAt(room.phaseState.seat)].filter(Boolean);
    else if (phase === 'nightWolves') actors = room._liveWolves();
    else actors = live.filter(p => p.role === ({ nightGuard: 'guard', nightSeer: 'seer', nightWitch: 'witch' })[phase]);
    // Only the judge, actor or wolf teammates may see these seat-specific states.
    const visible = judge ? actors : phase === 'nightWolves' && actors.some(p => p.playerId === viewer?.playerId)
      ? actors : actors.filter(p => p.playerId === viewer?.playerId);
    for (const p of visible) {
      const done = phase === 'nightWolves' ? room.night?.wolfVotes[p.seat] != null
        : phase === 'nightGuard' ? room.night?.guardTarget != null
        : phase === 'nightSeer' ? room.night?.seerTarget != null
        : phase === 'nightWitch' ? room.night?.witchHeal != null || room.night?.witchPoison != null
        : !!room.phaseState.done;
      add(p, done ? 'done' : 'pending', done ? '已行动' : '待行动');
    }
    return result(visible.length ? '本机可见的行动进度' : '等待本阶段行动，行动者身份保密', 'private');
  }
  if (phase === 'dayTalk' && (room.phaseState.speakerSeat || room.phaseState.spoken?.length)) {
    for (const p of live) {
      const current = p.seat === room.phaseState.speakerSeat;
      const done = room.phaseState.spoken?.includes(p.seat);
      add(p, current ? 'speaking' : done ? 'done' : 'pending', current ? '正在发言' : done ? '已发言' : '待发言');
    }
    return result(room.phaseState.speakerSeat ? '白天发言进度' : '等待房主指定下一位发言者');
  }
  const host = room.players.get(room.hostPlayerId);
  if (!room.settings.judgeMode && host?.seat) add(host, 'pending', '待推进阶段');
  return result(room.settings.judgeMode ? '等待法官确认推进' : phase === 'dayTalk' ? '自由讨论 · 由房主发起投票' : '等待房主推进');
}
