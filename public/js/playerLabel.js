export function playerLabel(player, seat = player?.seat) {
  const name = player?.name || '未知玩家';
  return seat ? `${name}（${seat}号）` : name;
}

export function seatLabel(players, seat) {
  return playerLabel(players?.find(player => player.seat === seat), seat);
}
