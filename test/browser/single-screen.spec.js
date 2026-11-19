import { test, expect } from '@playwright/test';
import { Room, buildSettings } from '../../server/engine.js';

// 使用引擎快照隔离检查不同人数、角色与阶段的布局边界；真实操作由 party.spec 覆盖。
function snapshots(count) {
  const room = new Room({ code: 'SCREEN', settings: buildSettings({ playerCount: count }), hostPlayerId: 'host', hostName: '很长昵称的房主', onChange() {} });
  room.sit('host', 1);
  for (let i = 2; i <= count; i++) { room.addPlayer(`p${i}`, `月夜玩家${i}`); room.sit(`p${i}`, i); }
  room.start();
  const result = [room.snapshot('host')];
  room.day = 1;
  room._startPhase('dayVote'); result.push(room.snapshot('host'));
  room._startPhase('sheriffDeclare'); result.push(room.snapshot('host'));
  room.night = { wolfVotes: {}, wolfTarget: 2 };
  room._startPhase('nightWitch');
  const witch = [...room.players.values()].find(p => p.role === 'witch');
  result.push(room.snapshot(witch.playerId));
  const revealed = structuredClone(result[1]);
  revealed.phaseId += '-revealed';
  Object.assign(revealed.players[1], { alive: false, revealed: true, role: 'wolf', roleName: '狼人' });
  Object.assign(revealed.players[2], { revealed: true, role: 'idiot', roleName: '白痴', idiotFlipped: true });
  result.push(revealed);
  return result;
}

async function fits(page) {
  const geometry = await page.evaluate(() => {
    const seats = [...document.querySelectorAll('.seat-grid:not([hidden]) .seat')];
    const tools = document.querySelector('.board-tools').getBoundingClientRect();
    return {
      height: innerHeight, scrollHeight: document.documentElement.scrollHeight,
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      toolsBottom: tools.bottom,
      seats: seats.map(n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, width: r.width, content: n.scrollHeight, box: n.clientHeight }; }),
    };
  });
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.height + 1);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
  expect(geometry.toolsBottom).toBeLessThanOrEqual(geometry.height);
  for (const seat of geometry.seats) {
    expect(seat.height).toBeGreaterThanOrEqual(44);
    expect(seat.width).toBeGreaterThanOrEqual(44);
    expect(seat.bottom).toBeLessThan(geometry.toolsBottom);
    expect(seat.content).toBeLessThanOrEqual(seat.box + 1);
  }
  for (const button of await page.locator('.board-action-controls > button').all()) await expect(button).toBeInViewport({ ratio: 1 });
}

test('9、12、16 人在手机可用视口内完整展示，记录浮层不撑长页面', async ({ page }, testInfo) => {
  await page.goto('/');
  for (const viewport of [{ width: 390, height: 664 }, { width: 375, height: 620 }, { width: 430, height: 740 }]) {
    await page.setViewportSize(viewport);
    for (const count of [9, 12, 16]) for (const snapshot of snapshots(count)) {
      await page.evaluate(async state => {
        const { net } = await import('/js/net.js');
        Object.defineProperty(net, 'state', { configurable: true, get: () => state });
        const { renderGame } = await import('/js/views/game.js');
        renderGame(document.getElementById('app'));
      }, snapshot);
      await fits(page);
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'roleReveal') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-identity.png') });
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'nightWitch') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-witch.png') });
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'dayVote' && !snapshot.players[1].revealed) await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-vote.png') });
      if (viewport.width === 390 && count === 16 && snapshot.phase === 'dayVote' && !snapshot.players[1].revealed) await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-16.png') });
    }
  }
  const longSnapshot = snapshots(16)[1];
  longSnapshot.voteHistory = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, kind: '放逐投票', ballots: Array.from({ length: 16 }, (_, seat) => ({ seat: seat + 1, target: 2, weight: 1 })) }));
  await page.evaluate(async state => {
    const { net } = await import('/js/net.js');
    Object.defineProperty(net, 'state', { configurable: true, get: () => state });
    const { renderGame } = await import('/js/views/game.js');
    renderGame(document.getElementById('app'));
  }, longSnapshot);
  await page.getByRole('button', { name: '投票记录', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '投票记录', exact: true })).toBeVisible();
  await expect(page.locator('.vote-record')).toHaveCount(30);
  const scrollable = await page.locator('[data-sheet=records] .sheet-content').evaluate(node => node.scrollHeight > node.clientHeight);
  expect(scrollable).toBe(true);
  await page.locator('[data-sheet=records] .sheet-content').evaluate(node => { node.scrollTop = 150; });
  await fits(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '投票记录', exact: true })).toBeFocused();
  await page.evaluate(() => {
    const notice = document.createElement('div');
    notice.className = 'update-notice';
    notice.textContent = '新版本已就绪';
    document.body.append(notice);
  });
  await expect(page.locator('.update-notice')).toBeHidden();
  await fits(page);
  await page.getByRole('button', { name: '投票记录', exact: true }).click();
  longSnapshot.phaseId += '-next';
  longSnapshot.phase = 'dayTalk';
  await page.evaluate(async state => {
    const { net } = await import('/js/net.js');
    Object.defineProperty(net, 'state', { configurable: true, get: () => state });
    const { renderGame } = await import('/js/views/game.js');
    renderGame(document.getElementById('app'));
  }, longSnapshot);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '阶段详情与更多操作', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '阶段详情与更多操作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await fits(page);
});
