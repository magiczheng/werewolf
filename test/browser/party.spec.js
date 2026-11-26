import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function register(page) {
  await page.goto('/'); await page.getByRole('button', { name: '注册账号', exact: true }).click();
  await page.getByLabel('邮箱地址', { exact: true }).fill(`browser-${randomUUID()}@test.dev`);
  await page.getByLabel('密码', { exact: true }).fill('BrowserLocal123');
  await page.getByLabel('昵称（可选）', { exact: true }).fill('聚会来客');
  await page.getByRole('button', { name: '创建账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible();
}
async function createRoom(page) {
  await page.getByLabel('你的昵称', { exact: true }).fill('本局昵称');
  await page.locator('form').getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('.room-code')).toBeVisible();
  return page.locator('.room-code').innerText();
}
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test('八张角色原画加载完成，桌面与手机均无横向溢出', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/roles.html'); await expect(page.locator('.role-gallery-art')).toHaveCount(8);
  await expect.poll(() => page.locator('.role-gallery-art').evaluateAll(images => images.every(i => i.complete && i.naturalWidth > 0))).toBe(true);
  await noOverflow(page); expect(errors).toEqual([]);
});

test('常用板子、人数上限、昵称和配置记忆', async ({ page }) => {
  await register(page);
  await page.locator('.roles-disclosure > summary').click();
  await expect(page.getByRole('button', { name: '增加预言家', exact: true })).toBeDisabled();
  await page.locator('.roles-disclosure > summary').click();
  await page.getByRole('button', { name: '12 人经典', exact: true }).click();
  await expect(page.getByLabel('游戏人数')).toHaveValue('12');
  await page.reload(); await expect(page.getByLabel('游戏人数')).toHaveValue('12');
  await noOverflow(page); await createRoom(page);
  await page.locator('.lobby-details > summary').click();
  await expect(page.locator('.waiting-chip')).toHaveText('本局昵称');
  await expect(page.getByText('第一次来？三步开启月夜')).toBeVisible();
  await page.getByRole('button', { name: '我知道了', exact: true }).click();
  await page.reload(); await expect(page.locator('.quick-guide')).toHaveCount(0);
  await noOverflow(page);
});

test('快速重复点击只创建一个房间', async ({ page }) => {
  let creates = 0;
  page.on('websocket', socket => socket.on('framesent', ({ payload }) => { if (typeof payload === 'string' && /^42\d*\["createRoom"/.test(payload)) creates++; }));
  await register(page);
  await page.locator('form button[type=submit]').evaluate(button => { button.click(); button.click(); });
  await expect(page.locator('.room-code')).toHaveCount(1);
  await expect(page.locator('.lobby-view')).toHaveCount(1);
  expect(creates).toBe(1);
});

test('离线点击不排队，恢复连接后仍保留原房间和未入座状态', async ({ page, context }) => {
  await register(page); const code = await createRoom(page);
  await context.setOffline(true);
  await expect(page.locator('body')).toHaveClass(/offline/);
  await page.getByRole('button', { name: '1号座位，点击入座', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('网络未连接');
  await context.setOffline(false); await page.reload();
  await expect(page.locator('.room-code')).toHaveText(code);
  await expect(page.locator('.seat.mine')).toHaveCount(0);
});

test('同账号多标签页关闭一页，另一页仍可正常换座', async ({ page, context }) => {
  await register(page); const code = await createRoom(page);
  await page.getByRole('button', { name: '1号座位，点击入座', exact: true }).click();
  const saved = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  const second = await context.newPage(); await second.addInitScript(data => { for (const [key, value] of Object.entries(data)) sessionStorage.setItem(key, value); }, saved);
  await second.goto('/'); await expect(second.locator('.room-code')).toHaveText(code); await second.close();
  await page.getByRole('button', { name: '2号座位，换到这里', exact: true }).click();
  await expect(page.locator('.seat.mine .seat-no')).toHaveText('2');
  await expect(page.locator('.seat.mine .dot.off')).toHaveCount(0);
});

test('Service Worker 更新使用网络中的样式，不继续展示旧缓存', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.evaluate(async () => {
    const cache = await caches.open('werewolf-hardening-v4');
    await cache.put('/css/theme.css', new Response('body { display: none !important }', { headers: { 'Content-Type': 'text/css' } }));
  });
  await page.reload(); await expect(page.getByRole('heading', { name: '月夜俱乐部' })).toBeVisible();
});

test('九人真实页面：发牌、第一夜、退水顺序及投票记录', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(120000); // WebKit needs more time to run nine isolated browser contexts in CI.
  const contexts = []; const players = [];
  const nicknames = ['本局昵称', '小满', '南风', '月白', '青禾', '归林', '山茶', '晚钟', '白露'];
  try {
    for (let i = 1; i <= 9; i++) {
      const context = await browser.newContext({ baseURL, viewport: testInfo.project.use.viewport }); contexts.push(context);
      const page = await context.newPage(); await page.goto('/');
      await page.getByRole('button', { name: String(i), exact: true }).click();
      await expect(page.getByRole('heading', { name: '创建房间' })).toBeVisible();
      players.push({ page, seat: i, name: nicknames[i - 1] });
    }
    const host = players[0].page; const code = await createRoom(host);
    await host.getByRole('button', { name: '1号座位，点击入座', exact: true }).click();
    for (const p of players.slice(1)) {
      await p.page.getByRole('button', { name: '加入房间', exact: true }).click();
      await p.page.getByLabel('昵称', { exact: true }).fill(p.name);
      await p.page.getByLabel('房间号', { exact: true }).fill(code);
      await p.page.getByRole('button', { name: '进入房间', exact: true }).click();
      await p.page.getByRole('button', { name: `${p.seat}号座位，点击入座`, exact: true }).click();
    }
    await host.getByRole('button', { name: '开始游戏', exact: true }).click();
    for (const p of players) { await expect(p.page.locator('.role-card .identity-art')).toBeVisible(); p.role = await p.page.locator('.role-card .rc-name').innerText(); }
    const identityBeforeConfirm = await host.evaluate(() => {
      const card = document.querySelector('.role-card').getBoundingClientRect();
      const button = [...document.querySelectorAll('button')].find(n => n.textContent === '我已记住身份').getBoundingClientRect();
      return card.bottom <= button.top;
    });
    expect(identityBeforeConfirm).toBe(true);
    await expect(host.getByRole('button', { name: '我已记住身份', exact: true })).toBeInViewport();
    for (const [index, p] of players.entries()) {
      await p.page.getByRole('button', { name: '我已记住身份', exact: true }).click();
      if (index === 0) {
        await expect(p.page.getByRole('button', { name: '已确认身份 ✓', exact: true })).toBeDisabled();
        await expect(p.page.locator('.role-card')).toHaveCount(0);
        await expect(p.page.locator('.game-board .seat[data-seat="1"] .seat-activity')).toHaveText('已确认');
      }
    }
    await expect(host.locator('.gt-phase')).toContainText('狼人行动');
    await expect(host.locator('.game-board')).toBeVisible();
    await expect(host.locator('.tabbar')).toHaveCount(0);
    await expect(host.locator('.seat-grid')).toHaveCount(1);
    const target = players.find(p => p.role === '村民'); const wolves = players.filter(p => p.role === '狼人');
    await target.page.locator('.seat-grid').evaluate(node => node.dataset.preserved = 'yes');
    for (const [index, p] of wolves.entries()) {
      await p.page.locator(`.game-board .seat.selectable[data-seat="${target.seat}"]`).click();
      await p.page.getByRole('button', { name: '确认投票', exact: true }).click();
      if (index === 0) await expect(target.page.locator('.seat-grid')).toHaveAttribute('data-preserved', 'yes');
    }
    const witch = players.find(p => p.role === '女巫').page;
    const poisonTarget = witch.locator('.game-board .seat.selectable').first();
    const poisonSeat = await poisonTarget.getAttribute('data-seat');
    await poisonTarget.click();
    const poisonDialog = witch.getByRole('dialog', { name: '确认使用毒药？' });
    await expect(poisonDialog).toContainText(`对 ${nicknames[Number(poisonSeat) - 1]}（${poisonSeat}号）使用毒药`);
    await expect(poisonDialog.getByRole('button', { name: '确认用毒', exact: true })).toBeVisible();
    await poisonDialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(poisonTarget).toBeEnabled();
    await witch.getByRole('button', { name: `使用解药救 ${target.name}（${target.seat}号）`, exact: true }).click();
    const seer = players.find(p => p.role === '预言家').page;
    await seer.locator(`.game-board .seat.selectable[data-seat="${wolves[0].seat}"]`).click();
    await expect(host.locator('.gt-phase')).toContainText('天亮了');
    await expect(seer.locator('.seer-result')).toContainText('狼人');
    await expect(seer.locator('.seer-result')).toContainText(wolves[0].name);
    await seer.getByRole('button', { name: '按住查看身份牌' }).focus();
    await seer.keyboard.down('Space'); await expect(seer.locator('.peek-panel .identity-art')).toBeVisible();
    await seer.keyboard.up('Space'); await expect(seer.locator('.peek-mask')).toHaveCount(0);
    await expect(host.locator('.identity-art')).toHaveCount(0);
    await host.getByRole('button', { name: '进入下一步', exact: true }).click();
    for (const p of players) await p.page.getByRole('button', { name: p.seat <= 3 ? '上警（参加竞选）' : '警下（不竞选）', exact: true }).click();
    await expect(host.locator('.speaker-seat')).toHaveText('本局昵称（1号）');
    await host.getByRole('button', { name: '退水（放弃竞选）', exact: true }).click();
    await expect(players[1].page.locator('.speaker-seat')).toHaveText('小满（2号）');
    await players[1].page.getByRole('button', { name: '结束发言', exact: true }).click();
    await players[2].page.getByRole('button', { name: '结束发言', exact: true }).click();
    await expect(host.locator('.game-board .seat.selectable')).toHaveCount(0);
    for (const p of players.filter(p => p.seat >= 4)) {
      await p.page.locator('.game-board .seat.selectable[data-seat="2"]').click();
      if (p.seat === 4) {
        await expect(p.page.getByRole('dialog', { name: '确认投票？' })).toContainText('小满（2号）');
        await p.page.getByRole('button', { name: '取消', exact: true }).click();
        await expect(p.page.locator('.game-board .seat.selectable[data-seat="2"]')).toBeEnabled();
        await p.page.locator('.game-board .seat.selectable[data-seat="2"]').click();
      }
      await p.page.getByRole('button', { name: '确认投票', exact: true }).click();
      if (p.seat === 4) {
        await expect(host.locator('.game-board .seat[data-seat="4"] .seat-activity')).toHaveText('已投票');
        await expect(host.locator('.game-board .seat[data-seat="5"] .seat-activity')).toHaveText('待投票');
      }
    }
    await expect(host.locator('.gt-phase')).toContainText('白天发言');
    await host.getByRole('button', { name: '投票记录', exact: true }).click();
    const sheriffRecord = host.locator('.vote-record').filter({ hasText: '警长投票' });
    await expect(sheriffRecord.locator('.vote-voters')).toHaveText(nicknames.slice(3).join('、'));
    await expect(sheriffRecord.locator('.vote-target')).toHaveText('小满');
    await host.getByRole('button', { name: '关闭', exact: true }).click();
    await host.locator('.game-board .seat.selectable[data-seat="4"]').click();
    await expect(players[4].page.locator('.game-board .seat[data-seat="4"] .seat-activity')).toHaveText('正在发言');
    await host.getByRole('button', { name: '进入放逐投票', exact: true }).click();
    await expect(host.getByRole('dialog', { name: '现在开始放逐投票？' })).toContainText('月白（4号）仍在发言');
    await host.getByRole('button', { name: '取消', exact: true }).click();
    await players[3].page.getByRole('button', { name: '结束我的发言', exact: true }).click();
    await expect(host.locator('.game-board .seat[data-seat="4"] .seat-activity')).toHaveText('已发言');
    await host.getByRole('button', { name: '进入放逐投票', exact: true }).click();
    for (const p of players) {
      const ballot = p.seat === 2 ? 0 : [1, 3, 4, 9].includes(p.seat) ? 8 : 9;
      if (ballot) await p.page.locator(`.game-board .seat.selectable[data-seat="${ballot}"]`).click();
      else await p.page.getByRole('button', { name: '弃票', exact: true }).click();
      await p.page.getByRole('button', { name: '确认投票', exact: true }).click();
    }
    await expect(host.locator('.gt-phase')).toContainText('PK');
    for (const p of players.filter(p => p.seat >= 8)) {
      await expect(p.page.locator('.game-board .seat.selectable')).toHaveCount(0);
      await expect(p.page.locator('.game-actions')).toContainText('本轮不能投票');
    }
    for (const p of players.filter(p => p.seat <= 7)) {
      await p.page.locator('.game-board .seat.selectable[data-seat="8"]').click();
      await p.page.getByRole('button', { name: '确认投票', exact: true }).click();
    }
    await host.getByRole('button', { name: '投票记录', exact: true }).click();
    const pkRecord = host.locator('.vote-record').filter({ hasText: '放逐 PK' });
    await expect(pkRecord.locator('.vote-voters')).toContainText('本局昵称、小满');
    await expect(pkRecord.locator('.vote-target')).toHaveText('晚钟');
    await noOverflow(host);
  } finally { for (const context of contexts) await context.close(); }
});

test('房主可主动移交，其他在线成员接任后能管理房间', async ({ page, context }) => {
  await register(page); const code = await createRoom(page);
  const guest = await context.newPage(); await register(guest);
  await guest.getByRole('button', { name: '加入房间', exact: true }).click();
  await guest.getByLabel('房间号', { exact: true }).fill(code);
  await guest.getByRole('button', { name: '进入房间', exact: true }).click();
  await page.locator('.lobby-details > summary').click();
  await page.locator('.room-controls > summary').click();
  const chooser = page.getByLabel('选择新房主');
  await expect(chooser.locator('option')).toHaveCount(2);
  await chooser.selectOption({ index: 1 }); await page.getByRole('button', { name: '移交', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '移交房主？' })).toContainText('聚会来客');
  await page.getByRole('button', { name: '移交', exact: true }).last().click();
  await guest.locator('.lobby-details > summary').click();
  await guest.locator('.room-controls > summary').click();
  await expect(guest.getByLabel('选择新房主')).toBeVisible();
  await expect(page.getByLabel('选择新房主')).toHaveCount(0);
  await expect(guest.locator('.room-controls')).toContainText('房主：聚会来客');
});


test('紧凑建房首屏保留主按钮，角色与规则可按需展开', async ({ page }) => {
  await register(page);
  await expect(page.locator('.create-dock')).toBeInViewport();
  await expect(page.locator('.roles-disclosure')).not.toHaveAttribute('open', '');
  await expect(page.locator('.board-preview .role-preview')).toHaveCount(5);
  for (const count of [12, 16, 9]) {
    await page.getByRole('button', { name: `${count} 人经典`, exact: true }).click();
    await noOverflow(page);
    await expect(page.locator('.create-dock button')).toBeInViewport();
  }
  await page.locator('.roles-disclosure > summary').click();
  await expect(page.getByRole('button', { name: '增加白狼王', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '增加白狼王', exact: true }).click();
  await expect(page.locator('.create-dock button')).toBeDisabled();
  await page.getByRole('button', { name: '减少白狼王', exact: true }).click();
  await expect(page.locator('.create-dock button')).toBeEnabled();
  await page.locator('.rules-disclosure > summary').click();
  await expect(page.getByRole('button', { name: '女巫首夜可自救', exact: true })).toBeVisible();
  await noOverflow(page);
});

test('确认弹窗支持键盘循环、Escape 取消及恢复原按钮焦点', async ({ page }) => {
  await register(page); await createRoom(page);
  const leave = page.getByRole('button', { name: '离开', exact: true });
  await leave.click();
  const dialog = page.getByRole('dialog', { name: '离开房间？' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: '离开', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await expect(leave).toBeFocused(); await expect(page.locator('.room-code')).toBeVisible();
});

test('减少动态效果偏好下取消入场和循环动效', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.auth-view')).toBeVisible();
  expect(await page.locator('.auth-view').evaluate(node => getComputedStyle(node).animationName)).toBe('none');
  await noOverflow(page);
});

test('手机大厅的座位全部在桌内，开局按钮和二维码互不遮挡', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', '仅检查手机断点');
  const qrRequests = [];
  page.on('request', request => { if (request.url().includes('/api/qr')) qrRequests.push(request.url()); });
  await register(page); const code = await createRoom(page);
  await page.getByRole('button', { name: '1号座位，点击入座', exact: true }).click();
  await expect(page.locator('.seat.mine .name')).toHaveText('本局昵称');
  await expect(page.locator('.launch-caption')).toHaveText('已入座 1 / 9');
  for (const viewport of [{ width: 390, height: 707 }, { width: 375, height: 620 }, { width: 430, height: 740 }]) {
    await page.setViewportSize(viewport);
    const geometry = await page.evaluate(() => {
      const table = document.querySelector('.lobby-table').getBoundingClientRect();
      const invite = document.querySelector('.lobby-invite').getBoundingClientRect();
      const seats = [...document.querySelectorAll('.lobby-table .seat')];
      const launch = document.querySelector('.lobby-launch');
      return {
        tokensInside: seats.every(seat => {
          const token = seat.querySelector('.seat-no').getBoundingClientRect();
          return [token.left, token.right].every(x => [token.top, token.bottom].every(y =>
            ((x - table.left) / table.width * 2 - 1) ** 2
              + ((y - table.top) / table.height * 2 - 1) ** 2 < 1,
          ));
        }),
        touchTargetsFit: seats.every(seat => seat.clientWidth >= 44 && seat.clientHeight >= 44),
        inFlow: getComputedStyle(launch).position === 'static' && table.bottom < launch.getBoundingClientRect().top,
        inviteCentered: Math.abs(invite.left + invite.width / 2 - table.left - table.width / 2) < 1,
      };
    });
    expect(geometry).toEqual({ tokensInside: true, touchTargetsFit: true, inFlow: true, inviteCentered: true });
    await expect(page.locator('.lobby-invite')).toBeInViewport();
    await expect(page.getByRole('button', { name: '开始游戏' })).toBeInViewport({ ratio: 1 });
    await noOverflow(page);
  }
  expect(qrRequests).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 707 });
  await page.screenshot({ path: testInfo.outputPath('lobby-one-seated.png'), style: '.mode-badge, #toast { display: none; }' });
  const invite = page.getByRole('button', { name: '邀请好友' });
  await invite.click();
  const dialog = page.getByRole('dialog', { name: '邀请好友' });
  await expect(dialog.getByAltText('房间二维码')).toBeVisible();
  await expect(dialog).toContainText(`?room=${code}`);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(invite).toBeFocused();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '离开座位', exact: true })).toBeVisible();
  await noOverflow(page);
});

test('页面版本与服务端版本接口一致，版本响应不缓存', async ({ page, request }) => {
  const response = await request.get('/api/version');
  expect(response.ok()).toBe(true);
  expect(response.headers()['cache-control']).toBe('no-store');
  const release = await response.json();
  expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(typeof release.revision).toBe('string');
  await page.goto('/');
  await expect(page.locator('.edition')).toContainText(`v${release.version}`);
});

test('存储写入被浏览器拒绝时，收起引导仍有反馈且不阻塞操作', async ({ page }) => {
  await register(page); await createRoom(page);
  await page.locator('.lobby-details > summary').click();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error('storage unavailable'); };
    Storage.prototype.removeItem = () => { throw new Error('storage unavailable'); };
  });
  await page.getByRole('button', { name: '我知道了', exact: true }).click();
  await expect(page.locator('.quick-guide')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('引导已收起');
  await page.getByRole('button', { name: '1号座位，点击入座', exact: true }).click();
  await expect(page.locator('.seat.mine .seat-no')).toHaveText('1');
});
