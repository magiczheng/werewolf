// 入口：HTTP 静态服务 + 二维码接口 + Socket.IO 实时层
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import {
  PORT, PUBLIC_URL, MULTI_ACCOUNT, SEED_ACCOUNTS, SKIP_ROLE_REVEAL,
  TEST_ACCOUNT_COUNT, TEST_ACCOUNT_PASSWORD, testAccountEmail,
} from './config.js';
import { initSocket } from './socket.js';
import { db } from './db.js';
import { seedAndLog } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '../public/index.html');

const app = express();
const server = http.createServer(app);

// 测试账号列表：只在种子开启时下发给前端，供登录页做「一键切账号」。
// 内容由配置推导（邮箱规则固定），不依赖种子是否已跑完——服务端要先 listen
// 才可能有人访问，那时种子早已执行完毕。
const testLogin = SEED_ACCOUNTS
  ? {
      accounts: Array.from({ length: TEST_ACCOUNT_COUNT }, (_, i) => testAccountEmail(i + 1)),
      password: TEST_ACCOUNT_PASSWORD,
    }
  : null;

// 首页：把服务端开关与测试账号注入到页面。
// 必须注册在 express.static 之前，否则会先被静态中间件用原始 index.html 接管。
// 模板只读一次并缓存，避免每个请求都碰磁盘。
const indexTemplate = fs.readFileSync(INDEX_HTML, 'utf8');
const indexHtml = indexTemplate.replace('</head>', `<script>
window.__WW_MULTI__=${MULTI_ACCOUNT ? 'true' : 'false'};
window.__WW_SKIP_REVEAL__=${SKIP_ROLE_REVEAL ? 'true' : 'false'};
window.__WW_TEST_LOGIN__=${testLogin ? JSON.stringify(testLogin) : 'null'};
</script>
</head>`);
app.get('/', (_req, res) => {
  res.type('html').set('Cache-Control', 'no-cache').send(indexHtml);
});

app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders(res, filePath) {
    // Service Worker 必须每次回源校验，否则改了 sw.js 用户要等很久才生效
    // （浏览器自身还有 24 小时上限，这里显式声明更稳妥）。
    // 其余静态资源保持 express 默认的 ETag 校验——零构建项目不能给 JS 设长缓存，
    // 否则部署后会新旧模块错配。
    if (/\.(?:js|css|html)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// 生成房间分享二维码/链接
// 分享地址基于请求 Host 推导：公网部署时是域名，局域网时是本机 IP，二者通用。
app.get('/api/qr', async (req, res) => {
  const room = String(req.query.room || '').toUpperCase().trim();
  if (!/^[A-Z2-9]{6}$/.test(room)) return res.status(400).json({ error: '房间号无效' });
  const host = PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${host}/?room=${room}`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 320, margin: 1 });
    res.json({ url, qr });
  } catch (e) {
    res.status(500).json({ error: '二维码生成失败' });
  }
});

// 健康检查
app.get('/api/health', (_req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); }
  catch (_) { res.status(503).json({ ok: false }); }
});

// Recoverable command errors are isolated in socket.js. Fatal process errors stop accepting
// work and exit; the supervisor restarts the service and restores committed room snapshots.
let stopping = false;
function shutdown(reason, error) {
  if (stopping) return;
  stopping = true;
  const log = error ? console.error : console.log;
  log(JSON.stringify({ level: error ? 'error' : 'info', event: reason, message: error?.message }));
  const exitCode = error ? 1 : 0;
  setTimeout(() => process.exit(exitCode), 5000).unref();
  runtime.io.close(() => { db.close(); process.exit(exitCode); });
}
process.on('uncaughtException', e => shutdown('uncaught_exception', e));
process.on('unhandledRejection', e => shutdown('unhandled_rejection', e instanceof Error ? e : new Error(String(e))));
process.on('SIGTERM', () => shutdown('sigterm'));
process.on('SIGINT', () => shutdown('sigint'));
server.on('error', e => { console.error(JSON.stringify({ level: 'error', event: 'listen_failed', code: e.code })); process.exit(1); });

const runtime = initSocket(server);

// 测试账号种子：必须在 listen 之前跑完，否则首批访问可能遇到「账号还没建好」
if (SEED_ACCOUNTS) seedAndLog(db);

server.listen(PORT, () => {
  console.log(`🐺 狼人杀平台已启动: http://localhost:${PORT}`);
  if (SEED_ACCOUNTS) {
    console.log(`   ⚠️  测试模式：登录页提供 1@qq.com … ${TEST_ACCOUNT_COUNT}@qq.com 一键登录（密码 ${TEST_ACCOUNT_PASSWORD}）`);
  }
});
