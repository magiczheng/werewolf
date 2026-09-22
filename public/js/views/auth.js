// 未登录时的首页：登录 / 注册
import { el } from '../ui.js';
import { toast } from '../ui.js';
import { net, session, setPlayerName } from '../net.js';
import { brand } from '../components/brand.js';

let mode = 'login'; // 'login' | 'register'

// 测试账号：由服务端在 SEED_ACCOUNTS 开启时注入；普通部署下为 null，界面不受影响。
const testLogin = (() => {
  try {
    return (typeof window !== 'undefined' && window.__WW_TEST_LOGIN__) || null;
  } catch (_e) { return null; }
})();

export function renderAuth(root, onDone) {
  const emailInput = el('input', {
    class: 'input', type: 'email', placeholder: 'you@example.com',
    autocomplete: 'username', inputmode: 'email', draftKey: 'auth-email',
  });
  const passInput = el('input', {
    class: 'input', type: 'password', placeholder: '至少 6 位',
    autocomplete: 'current-password',
  });
  const nameInput = el('input', {
    class: 'input', type: 'text', placeholder: '不填则用邮箱前缀', maxlength: 12, draftKey: 'auth-name',
  });

  let busy = false;
  async function submit() {
    if (busy) return;
    const email = emailInput.value.trim();
    const password = passInput.value;
    if (!email || !password) return toast('请输入邮箱和密码', true);
    busy = true;
    btn.disabled = true;
    try {
      if (mode === 'login') await net.login(email, password);
      else await net.register(email, password, nameInput.value.trim());
      setPlayerName(session().name || '');
      toast(`欢迎，${session().name || email}`);
      onDone();
    } catch (e) {
      toast(e.message, true);
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  const fields = [
    el('div', { class: 'field' }, [el('label', {}, '邮箱'), emailInput]),
    el('div', { class: 'field' }, [el('label', {}, '密码'), passInput]),
    mode === 'register'
      ? el('div', { class: 'field' }, [el('label', {}, '昵称（可选）'), nameInput])
      : null,
  ];

  // 回车提交：整个表单监听 submit，移动端键盘「前往」也能直接提交
  const btn = el('button', { class: 'btn-primary btn-big', type: 'submit' },
    mode === 'login' ? '登录' : '创建账号');

  // 测试账号一键登录：只为省去开 8 个标签页时手打 8 次邮箱密码
  async function quickLogin(email) {
    if (busy) return;
    emailInput.value = email;
    passInput.value = testLogin.password;
    await submit();
  }

  const testRow = testLogin && testLogin.accounts.length
    ? el('div', { class: 'test-login' }, [
      el('div', { class: 'test-login-label' }, '测试账号一键登录'),
      el('div', { class: 'test-login-row' }, testLogin.accounts.map((email) => el('button', {
        class: 'test-chip', type: 'button', title: `${email} / ${testLogin.password}`,
        click: () => quickLogin(email),
      }, email.split('@')[0]))),
    ])
    : null;

  const form = el('form', {
    class: 'card glass col auth-card',
    submit: (e) => { e.preventDefault(); submit(); },
  }, [
    ...fields,
    btn,
    el('div', { class: 'hint' }, '创建或加入房间需要先登录，同一账号跨设备身份一致'),
    testRow,
  ]);

  root.appendChild(el('div', { class: 'view auth-view' }, [
    brand(),
    el('div', { class: 'tabs glass' }, [
      el('button', {
        class: 'tab' + (mode === 'login' ? ' active' : ''), type: 'button',
        click: () => { mode = 'login'; onDone(); },
      }, '登录'),
      el('button', {
        class: 'tab' + (mode === 'register' ? ' active' : ''), type: 'button',
        click: () => { mode = 'register'; onDone(); },
      }, '注册'),
    ]),
    form,
  ]));
}

export function resetAuthMode() { mode = 'login'; }
