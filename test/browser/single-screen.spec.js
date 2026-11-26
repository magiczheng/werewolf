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
  room.gameOver = { winners: 'good' };
  room.phase = 'gameOver';
  room.players.get('host').name = '星河长夜听风的钟楼守夜人';
  room.players.get('host').alive = false;
  Object.assign(room.players.get('p2'), { role: 'idiot', idiotFlipped: true });
  for (const player of room.players.values()) player.revealed = true;
  result.push(room.snapshot('host'));
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
      if (snapshot.gameOver) {
        await expect(page.locator('.game-board .role-tag:visible')).toHaveCount(count);
        const nameSize = await page.locator('.game-board .seat[data-seat="1"] .name').evaluate(name => ({
          width: name.clientWidth, contentWidth: name.scrollWidth,
          height: name.clientHeight, contentHeight: name.scrollHeight,
          roleStartsBelow: name.getBoundingClientRect().bottom <= name.closest('.seat').querySelector('.role-tag').getBoundingClientRect().top,
        }));
        expect(nameSize.contentWidth).toBeLessThanOrEqual(nameSize.width);
        expect(nameSize.contentHeight).toBeLessThanOrEqual(nameSize.height + 1);
        expect(nameSize.roleStartsBelow).toBe(true);
        await expect(page.locator('.gt-phase')).toHaveText('好人阵营获胜');
        await expect(page.getByRole('button', { name: '查看复盘' })).toBeInViewport({ ratio: 1 });
        if (viewport.width === 390 && count === 16) {
          await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-results.png') });
        }
      }
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'roleReveal') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-identity.png') });
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'nightWitch') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-witch.png') });
      if (viewport.width === 390 && count === 9 && snapshot.phase === 'dayVote' && !snapshot.players[1].revealed) await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-vote.png') });
      if (viewport.width === 390 && count === 16 && snapshot.phase === 'dayVote' && !snapshot.players[1].revealed) await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('single-screen-16.png') });
    }
  }
  const longSnapshot = snapshots(16)[1];
  const nicknames = ['阿岚', '小满', '南风', '月白', '青禾', '归林', '山茶', '晚钟', '白露', '银杏', '长夜听风的钟楼守夜人', '飞鸟', '小溪', '晴川', '春雨', '星野'];
  longSnapshot.players.forEach(player => { player.name = nicknames[player.seat - 1]; });
  const namesBySeat = Object.fromEntries(longSnapshot.players.map(player => [player.seat, player.name]));
  longSnapshot.players[1].name = 'MidnightRain';
  longSnapshot.players[15].connected = false;
  longSnapshot.offlinePlayers = [{ seat: 16, name: longSnapshot.players[15].name }];
  longSnapshot.voteHistory = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, kind: '放逐投票', ballots: Array.from({ length: 16 }, (_, seat) => ({ seat: seat + 1, target: 2, weight: 1 })) }));
  longSnapshot.voteHistory[28] = { day: 3, kind: '放逐投票', namesBySeat, ballots: [
    { seat: 3, target: 5, weight: 1 }, { seat: 8, target: 6, weight: 1 },
    { seat: 2, target: 0, weight: 1.5 }, { seat: 6, target: 5, weight: 1 },
    { seat: 4, target: 6, weight: 1 }, { seat: 1, target: 5, weight: 1 },
    { seat: 9, target: 0, weight: 1 }, { seat: 7, target: 6, weight: 1 },
  ] };
  longSnapshot.voteHistory[29] = { day: 3, kind: '放逐 PK', namesBySeat, ballots: [
    { seat: 7, target: 6, weight: 1 }, { seat: 2, target: 5, weight: 1.5 },
    { seat: 3, target: 5, weight: 1 }, { seat: 1, target: 5, weight: 1 },
    { seat: 8, target: 0, weight: 1 }, { seat: 4, target: 6, weight: 1 },
  ] };
  await page.setViewportSize({ width: 390, height: 740 });
  await page.evaluate(async state => {
    const { net } = await import('/js/net.js');
    Object.defineProperty(net, 'state', { configurable: true, get: () => state });
    const { renderGame } = await import('/js/views/game.js');
    renderGame(document.getElementById('app'));
  }, longSnapshot);
  await page.getByRole('button', { name: '查看待操作玩家' }).click();
  const pending = page.getByRole('dialog', { name: '待操作玩家' });
  await expect(pending.getByRole('listitem')).toHaveCount(16);
  await expect(pending.getByText('星野（16号） · 离线')).toBeVisible();
  await pending.getByRole('button', { name: '查看离线处理' }).click();
  await expect(page.getByRole('button', { name: '处理本阶段离线操作' })).toBeVisible();
  await expect(page.getByText(/离线成员：星野（16号）/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '查看待操作玩家' })).toBeFocused();
  await page.getByRole('button', { name: '投票记录', exact: true }).click();
  const recordDialog = page.getByRole('dialog', { name: '投票记录', exact: true });
  await expect(recordDialog).toBeVisible();
  const records = page.locator('.vote-record');
  await expect(records).toHaveCount(30);
  await expect(records.nth(0).locator('h3')).toHaveText('第 3 天 · 放逐 PK');
  await expect(records.nth(0).locator('.vote-voters')).toHaveText(['阿岚、小满（1.5票）、南风', '月白、山茶', '晚钟']);
  await expect(records.nth(0).locator('.vote-target')).toHaveText(['青禾', '归林', '弃票']);
  await expect(records.nth(0).locator('.vote-total')).toHaveText(['3.5 票', '2 票', '1 人']);
  await expect(records.nth(1).locator('h3')).toHaveText('第 3 天 · 放逐投票');
  await expect(records.nth(1).locator('.vote-target')).toHaveText(['青禾', '归林', '弃票']);
  await expect(records.nth(1).locator('.vote-total')).toHaveText(['3 票', '3 票', '2 人']);
  await expect(records.nth(2).locator('.vote-target')).toHaveText('MidnightRain');
  expect(await records.nth(2).locator('.vote-voters, .vote-target').evaluateAll(nodes =>
    nodes.every(node => node.scrollWidth <= node.clientWidth)
  )).toBe(true);
  await recordDialog.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('single-screen-vote-records.png'),
    style: '.mode-badge, .vote-record:nth-child(n+3) { display: none; }',
  });
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
