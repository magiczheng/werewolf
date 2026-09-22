// 已登录首页：创建房间 / 加入房间
import { el, esc, toast, clearDraft } from '../ui.js';
import { net, session, setPlayerName, playerName, store } from '../net.js';
import { buildSettingsForm } from '../components/settingsForm.js';
import { brand } from '../components/brand.js';
import { DEFAULT_BOARDS, DEFAULT_RULES, DEFAULT_PLAYER_COUNT } from '../constants.js';

let tab = null; // 'create' | 'join'，null 表示按 URL 推断

export function renderHome(root, { onLogout }) {
  const acct = session();
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (tab === null) tab = urlRoom ? 'join' : 'create';

  const nameInput = el('input', {
    class: 'input', type: 'text', maxlength: 12, placeholder: '其他人看到的名字',
    value: playerName() || acct.name || '', draftKey: 'home-name',
  });
  const joinCode = el('input', {
    class: 'input input-code', type: 'text', maxlength: 6, placeholder: 'ABC123',
    value: urlRoom, draftKey: 'home-room', autocapitalize: 'characters', spellcheck: false,
  });

  const settingsForm = buildSettingsForm({
    playerCount: DEFAULT_PLAYER_COUNT,
    judgeMode: false,
    roles: { ...DEFAULT_BOARDS[DEFAULT_PLAYER_COUNT] },
    rules: { ...DEFAULT_RULES },
  });

  let busy = false;
  async function createRoom() {
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) return toast('请输入昵称', true);
    busy = true;
    setPlayerName(name);
    try {
      const res = await net.emit('createRoom', { settings: settingsForm.getConfig() });
      store.set('ww_last_room', res.roomCode);
    } catch (e) { toast(e.message, true); } finally { busy = false; }
  }

  async function joinRoom() {
    if (busy) return;
    const name = nameInput.value.trim();
    const code = joinCode.value.trim().toUpperCase();
    if (!name) return toast('请输入昵称', true);
    if (!code) return toast('请输入房间号', true);
    busy = true;
    setPlayerName(name);
    try {
      await net.emit('joinRoom', { code });
      store.set('ww_last_room', code);
      clearDraft('home-room');
    } catch (e) { toast(e.message, true); } finally { busy = false; }
  }

  function buildPanel() {
    const form = tab === 'join'
      ? el('form', { class: 'card glass col', submit: (e) => { e.preventDefault(); joinRoom(); } }, [
        el('div', { class: 'field' }, [el('label', {}, '昵称'), nameInput]),
        el('div', { class: 'field' }, [el('label', {}, '房间号'), joinCode]),
        el('button', { class: 'btn-primary btn-big', type: 'submit' }, '进入房间'),
        el('div', { class: 'hint' }, '扫房主分享的二维码，或手动输入 6 位房间号'),
      ])
      : el('form', { class: 'card glass col', submit: (e) => { e.preventDefault(); createRoom(); } }, [
        el('div', { class: 'field' }, [el('label', {}, '你的昵称'), nameInput]),
        settingsForm.root,
        createBtn,
      ]);
    return form;
  }

  // 板子人数不匹配时直接禁用创建按钮，而不是等他点下去再被服务端拒绝
  const createBtn = el('button', { class: 'btn-primary btn-big', type: 'submit' }, '创建房间');
  settingsForm.onChange = ({ ok }) => {
    createBtn.disabled = !ok;
    createBtn.textContent = ok ? '创建房间' : '角色配置不合法';
  };
  settingsForm.onChange({ ok: settingsForm.valid });

  root.appendChild(el('div', { class: 'view home-view' }, [
    brand({ compact: true }),
    el('div', { class: 'account-bar glass' }, [
      el('span', { class: 'account-name' }, `👤 ${esc(acct.name || acct.email)}`),
      el('button', { class: 'link-btn', type: 'button', click: onLogout }, '退出登录'),
    ]),
    el('div', { class: 'tabs glass' }, [
      el('button', {
        class: 'tab' + (tab === 'create' ? ' active' : ''), type: 'button',
        click: () => { tab = 'create'; rerender(); },
      }, '创建房间'),
      el('button', {
        class: 'tab' + (tab === 'join' ? ' active' : ''), type: 'button',
        click: () => { tab = 'join'; rerender(); },
      }, '加入房间'),
    ]),
    buildPanel(),
  ]));

  // 切 Tab 时保留已输入的昵称，避免重新输入
  function rerender() {
    root.innerHTML = '';
    renderHome(root, { onLogout });
  }
}

export function resetHomeTab() { tab = null; }
