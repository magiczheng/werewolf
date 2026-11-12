// 已登录首页：创建房间 / 加入房间
import { el, toast, clearDraft, setPending } from '../ui.js';
import { net, session, setPlayerName, playerName, store } from '../net.js';
import { buildSettingsForm } from '../components/settingsForm.js';
import { atmosphere, pageIntro } from '../components/atmosphere.js';
import { DEFAULT_BOARDS, DEFAULT_RULES, DEFAULT_PLAYER_COUNT } from '../constants.js';

let tab = null; // 'create' | 'join'，null 表示按 URL 推断

export function renderHome(root, { onLogout }) {
  const acct = session();
  const urlRoom = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  if (tab === null) tab = urlRoom ? 'join' : 'create';

  const nameInput = el('input', {
    class: 'input', type: 'text', maxlength: 12, placeholder: '其他人看到的名字',
    value: playerName() || acct.name || '', draftKey: 'home-name', id: 'home-name',
  });
  const joinCode = el('input', {
    class: 'input input-code', type: 'text', maxlength: 6, placeholder: 'ABC123',
    value: urlRoom, draftKey: 'home-room', id: 'home-room', autocapitalize: 'characters', spellcheck: false,
  });

  let initialSettings = { playerCount: DEFAULT_PLAYER_COUNT, judgeMode: false,
    roles: { ...DEFAULT_BOARDS[DEFAULT_PLAYER_COUNT] }, rules: { ...DEFAULT_RULES } };
  try {
    const saved = JSON.parse(store.get('ww_last_settings') || 'null');
    if (saved && DEFAULT_BOARDS[saved.playerCount] && saved.roles && saved.rules) initialSettings = saved;
  } catch (_e) { /* Invalid saved preferences fall back to the standard board. */ }
  const settingsForm = buildSettingsForm(initialSettings);

  let busy = false;
  async function createRoom() {
    if (busy) return;
    const name = nameInput.value.trim();
    if (!name) return toast('请输入昵称', true);
    busy = true;
    setPending(tab === 'join' ? joinBtn : createBtn, true);
    setPlayerName(name);
    try {
      const res = await net.emit('createRoom', { name, settings: settingsForm.getConfig() });
      store.set('ww_last_room', res.roomCode);
    } catch (e) { toast(e.message, true); } finally { busy = false; setPending(tab === 'join' ? joinBtn : createBtn, false); createBtn.disabled = !settingsForm.valid; }
  }

  async function joinRoom() {
    if (busy) return;
    const name = nameInput.value.trim();
    const code = joinCode.value.trim().toUpperCase();
    if (!name) return toast('请输入昵称', true);
    if (!code) return toast('请输入房间号', true);
    busy = true;
    setPending(tab === 'join' ? joinBtn : createBtn, true);
    setPlayerName(name);
    try {
      await net.emit('joinRoom', { code, name });
      store.set('ww_last_room', code);
      clearDraft('home-room');
    } catch (e) { toast(e.message, true); } finally { busy = false; setPending(tab === 'join' ? joinBtn : createBtn, false); createBtn.disabled = !settingsForm.valid; }
  }

  function buildPanel() {
    const form = tab === 'join'
      ? el('form', { class: 'card glass col join-form', submit: (e) => { e.preventDefault(); joinRoom(); } }, [
        el('div', { class: 'form-section-head' }, [el('span', { class: 'section-number' }, '↗'), el('div', {}, [el('h3', {}, '赴一场月夜邀约'), el('p', { class: 'hint' }, '输入朋友分享的 6 位房间号。')])]),
        el('div', { class: 'field' }, [el('label', { for: 'home-name' }, '昵称'), nameInput]),
        el('div', { class: 'field' }, [el('label', { for: 'home-room' }, '房间号'), joinCode]),
        joinBtn,
        el('div', { class: 'hint' }, '扫房主分享的二维码，或手动输入 6 位房间号'),
      ])
      : el('form', { class: 'card glass col create-form', submit: (e) => { e.preventDefault(); createRoom(); } }, [
        el('div', { class: 'form-section-head' }, [el('span', { class: 'section-number' }, '01'), el('div', {}, [el('h3', {}, '设定今晚的游戏'), el('p', { class: 'hint' }, '选好人数和板子，就可以邀请朋友了。')])]),
        el('div', { class: 'field' }, [el('label', { for: 'home-name' }, '你的昵称'), nameInput]),
        settingsForm.root,
        el('div', { class: 'create-dock' }, [el('div', { class: 'create-dock-copy' }, [el('span', { class: 'eyebrow' }, 'READY FOR TONIGHT'), createSummary]), createBtn]),
      ]);
    return form;
  }

  // 板子人数不匹配时直接禁用创建按钮，而不是等他点下去再被服务端拒绝
  const createSummary = el('span', { class: 'create-summary' }, `${initialSettings.playerCount} 人局 · ${initialSettings.judgeMode ? '法官模式' : '自动模式'}`);
  const joinBtn = el('button', { class: 'btn-primary btn-big', type: 'submit' }, '进入房间');
  const createBtn = el('button', { class: 'btn-primary btn-big', type: 'submit' }, '创建房间');
  settingsForm.onChange = ({ ok }) => {
    if (ok) store.set('ww_last_settings', JSON.stringify(settingsForm.getConfig()));
    const cfg = settingsForm.getConfig();
    createSummary.textContent = `${cfg.playerCount} 人局 · ${cfg.judgeMode ? '法官模式' : '自动模式'}`;
    createBtn.disabled = !ok;
    createBtn.textContent = ok ? '创建房间' : '角色配置不合法';
  };
  settingsForm.onChange({ ok: settingsForm.valid });

  root.appendChild(el('div', { class: 'view home-view view-enter' }, [
    atmosphere({ compact: true }),
    el('section', { class: 'home-content' }, [
    el('div', { class: 'account-bar glass' }, [
      el('span', { class: 'account-name' }, `👤 ${acct.name || acct.email}`),
      el('button', { class: 'link-btn', type: 'button', click: onLogout }, '退出登录'),
    ]),
    pageIntro('GATHER YOUR PEOPLE', '今晚，组一局。', '创建专属房间，或加入朋友的月夜邀约。'),
    el('div', { class: 'tabs glass' }, [
      el('button', {
        class: 'tab' + (tab === 'create' ? ' active' : ''), type: 'button', 'aria-pressed': String(tab === 'create'),
        click: () => { if (busy) return; tab = 'create'; rerender(); },
      }, '创建房间'),
      el('button', {
        class: 'tab' + (tab === 'join' ? ' active' : ''), type: 'button', 'aria-pressed': String(tab === 'join'),
        click: () => { if (busy) return; tab = 'join'; rerender(); },
      }, '加入房间'),
    ]),
    buildPanel(),
    ]),
  ]));

  // 切 Tab 时保留已输入的昵称，避免重新输入
  function rerender() {
    root.innerHTML = '';
    renderHome(root, { onLogout });
  }
}

export function resetHomeTab() { tab = null; }
