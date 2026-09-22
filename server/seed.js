// 测试账号种子：确保 1@qq.com … N@qq.com（N = TEST_ACCOUNT_COUNT） 存在且密码就是 111111。
//
// 只在 SEED_ACCOUNTS 开启时由 index.js 调用，普通运行完全不会执行。
//
// 为什么是「确保」而不只是「不存在才创建」：这两个不是一回事。
// 如果只做「已存在就跳过」，而这些邮箱早就被别人/自己用别的密码注册过，
// 那么开关显示成功、实际却登录不上——一个会静默说谎的测试开关比没有更糟。
// 因此这里会校验密码，不一致就重置（并显式记录），保证「密码都是 111111」为真。
//
// 走 createAuth() 而不是直接写 SQL——密码哈希路径与真实注册完全一致
// （scrypt 加盐），不会出现「种子建得出、登录登不上」的偏差。
// 不传 ip 参数，因此不触发登录限频。
import { createAuth } from './auth.js';
import {
  TEST_ACCOUNT_COUNT, TEST_ACCOUNT_PASSWORD, testAccountEmail, SEED_RESET_PASSWORD,
} from './config.js';

/**
 * @param {object} db
 * @param {object} [opts]
 *   count / password  覆盖默认的账号数与密码
 *   resetPassword     已存在但密码不符时是否重置（默认 true）。
 *                     置 false 则只报告不修改，适合不想被动过既有账号的场合。
 * @returns {{ created, reset, ok, mismatched, failed }}
 */
export function seedTestAccounts(db, opts = {}) {
  const count = opts.count ?? TEST_ACCOUNT_COUNT;
  const password = opts.password ?? TEST_ACCOUNT_PASSWORD;
  const resetPassword = opts.resetPassword !== false;
  const auth = createAuth(db);

  const created = [];
  const reset = [];
  const ok = [];
  const mismatched = [];
  const failed = [];

  for (let i = 1; i <= count; i++) {
    const email = testAccountEmail(i);
    // 昵称就用序号，方便在座位表里对上号
    const res = auth.register(email, password, String(i));

    if (!res.error) { created.push(email); continue; }

    if (!res.error.includes('已注册')) {
      failed.push({ email, error: res.error });
      continue;
    }

    // 账号已存在：确认密码是否就是我们要的那个
    if (auth.passwordMatches(email, password)) {
      ok.push(email);
      continue;
    }

    if (!resetPassword) {
      mismatched.push(email);
      continue;
    }

    const r = auth.setPassword(email, password);
    if (r.error) failed.push({ email, error: r.error });
    else reset.push(email);
  }

  return { created, reset, ok, mismatched, failed };
}

/** 启动时调用：把结果打到日志，让人清楚知道种子到底做了什么。 */
export function seedAndLog(db, log = console.log) {
  const { created, reset, ok, mismatched, failed } =
    seedTestAccounts(db, { resetPassword: SEED_RESET_PASSWORD });

  if (created.length) {
    log(`🧪 已创建测试账号 ${created.length} 个：${created[0]} … ${created[created.length - 1]}`);
  }
  if (reset.length) {
    log(`🔑 已把 ${reset.length} 个既有账号的密码重置为 ${TEST_ACCOUNT_PASSWORD}：${reset.join('、')}`);
    log('   （这些账号在你启用测试模式前就存在，密码与 111111 不符，为保证一键登录可用而重置）');
  }
  if (mismatched.length) {
    log(`⚠️  有 ${mismatched.length} 个账号已存在但密码不是 ${TEST_ACCOUNT_PASSWORD}，且未重置：${mismatched.join('、')}`);
    log('   （SEED_RESET_PASSWORD=0 时不改动既有账号——一键登录对它们不可用）');
  }
  if (ok.length && !created.length && !reset.length) {
    log(`🧪 测试账号已就绪 ${ok.length} 个（${ok[0]} … ${ok[ok.length - 1]}），密码 ${TEST_ACCOUNT_PASSWORD}`);
  }
  if (failed.length) {
    log(`❌ 测试账号有 ${failed.length} 个处理失败：${failed.map((f) => `${f.email}(${f.error})`).join('、')}`);
  }
  return { created, reset, ok, mismatched, failed };
}
