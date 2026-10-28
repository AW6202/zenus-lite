// 学习机 Lite — 静态 PWA：内容来自 pack.json，进度存本地，AI 直连 OpenAI 兼容接口
'use strict';

const LS = {
  progress: 'zenus.progress.v1',
  settings: 'zenus.settings.v1',
  chat: 'zenus.chat.v1',
};

const DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  key: '',
  dailyNew: 10,
};

const state = {
  pack: null,
  courseId: null,
  tab: 'review',
  queue: [],
  current: null,
  revealed: false,
  picked: null,
  chat: [],
  busy: false,
};

const $ = (s) => document.querySelector(s);
const view = $('#view');

// ── 存储 ──────────────────────────────────────────────
function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

let progress = loadJSON(LS.progress, {});
let settings = { ...DEFAULT_SETTINGS, ...loadJSON(LS.settings, {}) };
state.chat = loadJSON(LS.chat, []);

// ── 调度（SM-2 简化版）────────────────────────────────
const DAY = 86400000;
function entry(id) {
  return progress[id] || { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0 };
}
function schedule(id, rating) {
  const e = { ...entry(id) };
  const now = Date.now();
  e.last = now;
  e.reps += 1;
  if (rating === 'again') {
    e.lapses += 1; e.interval = 0; e.ease = Math.max(1.3, e.ease - 0.2);
    e.due = now + 10 * 60000;
  } else if (rating === 'hard') {
    e.interval = e.interval < 1 ? 1 : Math.max(1, Math.round(e.interval * 1.2));
    e.ease = Math.max(1.3, e.ease - 0.05);
    e.due = now + e.interval * DAY;
  } else if (rating === 'good') {
    e.interval = e.interval < 1 ? 1 : Math.round(e.interval * e.ease);
    e.due = now + e.interval * DAY;
  } else {
    e.interval = e.interval < 1 ? 2 : Math.round(e.interval * e.ease * 1.3);
    e.ease = Math.min(3.2, e.ease + 0.15);
    e.due = now + e.interval * DAY;
  }
  progress[id] = e;
  saveJSON(LS.progress, progress);
}

// ── 数据 ──────────────────────────────────────────────
async function loadPack() {
  const res = await fetch('pack.json?v=' + Date.now());
  if (!res.ok) throw new Error('pack.json 拉取失败: ' + res.status);
  state.pack = await res.json();
  const saved = loadJSON('zenus.course.v1', null);
  state.courseId = state.pack.courses.some((c) => c.id === saved)
    ? saved
    : state.pack.courses[0]?.id;
}

function course() {
  return state.pack?.courses.find((c) => c.id === state.courseId) || null;
}
function allCards() { return course()?.cards || []; }

function dueQueue() {
  const now = Date.now();
  const cards = allCards();
  const due = cards.filter((c) => entry(c.id).reps > 0 && entry(c.id).due <= now);
  const fresh = cards.filter((c) => entry(c.id).reps === 0).slice(0, settings.dailyNew);
  return [...due, ...fresh];
}

// ── 渲染 ──────────────────────────────────────────────
function renderHeader() {
  const sel = $('#courseSel');
  sel.innerHTML = (state.pack?.courses || [])
    .map((c) => `<option value="${c.id}"${c.id === state.courseId ? ' selected' : ''}>${c.title}</option>`)
    .join('');
  sel.onchange = () => {
    state.courseId = sel.value;
    saveJSON('zenus.course.v1', state.courseId);
    state.queue = [];
    render();
  };
}

function render() {
  if (!state.pack) return;
  document.querySelectorAll('.tabbar button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === state.tab);
  });
  if (state.tab === 'review') return renderReview();
  if (state.tab === 'browse') return renderBrowse();
  if (state.tab === 'chat') return renderChat();
  if (state.tab === 'settings') return renderSettings();
}

function statsBar() {
  const cards = allCards();
  const now = Date.now();
  const n = cards.filter((c) => entry(c.id).reps > 0 && entry(c.id).due <= now).length;
  const fresh = cards.filter((c) => entry(c.id).reps === 0).length;
  return `<div class="meta"><span>待复习 ${n} · 未学 ${fresh}</span><span>共 ${cards.length} 张</span></div>`;
}

function renderReview() {
  if (!state.queue.length) {
    state.queue = dueQueue();
    state.current = null;
    state.revealed = false;
  }
  if (!state.queue.length) {
    view.innerHTML = `${statsBar()}
      <div class="empty">今天这一课清空了 👍<br><span class="sub">换一门课，或明天再来</span></div>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="againAll">再来一遍（全部重排）</button>
      </div>`;
    $('#againAll').onclick = () => {
      for (const c of allCards()) delete progress[c.id];
      saveJSON(LS.progress, progress);
      state.queue = dueQueue(); render();
    };
    return;
  }
  if (!state.current) {
    state.current = state.queue[0];
    state.revealed = false;
    state.picked = null;
  }
  const c = state.current;
  const e = entry(c.id);
  const isQuiz = Array.isArray(c.options) && c.options.length;

  let body = `<div class="front">${esc(c.front)}</div>`;
  if (c.hint && !state.revealed) body += `<div class="sub">${esc(c.hint)}</div>`;

  if (isQuiz) {
    body += `<div class="opts">${c.options.map((o, i) =>
      `<button data-i="${i}" class="${optClass(c, i)}">${esc(o)}</button>`).join('')}
    </div>`;
  }

  if (state.revealed) {
    const correct = isQuiz ? c.options.indexOf(c.back) === state.picked : null;
    body += `<div class="back">${esc(c.back)}</div>`;
    if (isQuiz) {
      body += `<div class="sub" style="color:${correct ? 'var(--ok)' : 'var(--bad)'}">
        ${correct ? '✓ 答对了' : '✗ 再想想'}</div>`;
    }
    if (c.explain) body += `<div class="explain">${esc(c.explain)}</div>`;
    body += `<div class="row" style="width:100%;margin-top:4px">
      <button class="btn ghost" id="askAI">问 AI 讲讲这道</button>
    </div>`;
  }

  const rates = `<div class="rates">
    <button data-r="again">忘了</button>
    <button data-r="hard">模糊</button>
    <button data-r="good">记得</button>
    <button data-r="easy">简单</button>
  </div>`;

  view.innerHTML = `${statsBar()}
    <div class="card" id="cardBox">${body}</div>
    ${state.revealed ? rates : `<div class="row" style="margin-top:12px">
      <button class="btn primary" id="reveal">${isQuiz ? '看答案' : '翻面'}</button></div>`}`;

  const box = $('#cardBox');
  box.onclick = (ev) => {
    if (ev.target.closest('button')) return;
    if (!state.revealed && !isQuiz) { state.revealed = true; renderReview(); }
  };
  const rv = $('#reveal');
  if (rv) rv.onclick = () => { state.revealed = true; renderReview(); };
  view.querySelectorAll('.opts button').forEach((b) => {
    b.onclick = () => {
      if (state.revealed) return;
      state.picked = Number(b.dataset.i);
      state.revealed = true;
      renderReview();
    };
  });
  view.querySelectorAll('.rates button').forEach((b) => {
    b.onclick = () => {
      schedule(c.id, b.dataset.r);
      state.queue.shift();
      state.current = null;
      state.revealed = false;
      state.picked = null;
      renderReview();
    };
  });
  const ask = $('#askAI');
  if (ask) ask.onclick = () => askAbout(c);

  // 显示下次复习间隔，给出反馈感
  if (state.revealed) {
    const label = e.reps ? `上次间隔 ${e.interval} 天` : '新卡';
    $('#cardBox').insertAdjacentHTML('beforeend',
      `<div class="sub" style="margin-top:2px">${label}</div>`);
  }
}

function optClass(c, i) {
  if (!state.revealed) return state.picked === i ? 'sel' : '';
  if (c.options[i] === c.back) return 'right';
  if (i === state.picked) return 'wrong';
  return '';
}

function renderBrowse() {
  const now = Date.now();
  const items = allCards().map((c) => {
    const e = entry(c.id);
    const tag = e.reps === 0 ? '未学' : e.due <= now ? '到期' : `${Math.ceil((e.due - now) / DAY)} 天后`;
    return `<div class="it"><span>${esc(c.front)}</span><small>${tag}</small></div>`;
  }).join('');
  view.innerHTML = `<h2>${esc(course()?.title || '')} · ${allCards().length} 张</h2>
    <div class="list">${items || '<div class="empty">这门课还没有卡片</div>'}</div>`;
}

function renderChat() {
  const msgs = state.chat.map((m) =>
    `<div class="msg ${m.role === 'user' ? 'me' : m.role === 'system' ? 'sys' : 'ai'}">${esc(m.content || '')}</div>`
  ).join('');
  view.innerHTML = `<div class="chat" id="chatBox">${msgs || '<div class="empty">问点什么：这个词怎么用？这道题为什么错？</div>'}</div>
    <div class="composer">
      <textarea id="input" placeholder="输入问题…"></textarea>
      <button id="send">发送</button>
    </div>`;
  const box = $('#chatBox');
  box.scrollTop = box.scrollHeight;
  $('#send').onclick = sendChat;
  $('#input').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  };
}

function renderSettings() {
  view.innerHTML = `
    <h2>AI 接口</h2>
    <label class="f">API Base</label>
    <input class="t" id="s-base" value="${esc(settings.apiBase)}" placeholder="https://api.deepseek.com/v1">
    <label class="f">模型</label>
    <input class="t" id="s-model" value="${esc(settings.model)}" placeholder="deepseek-chat">
    <label class="f">API Key（只存在本机）</label>
    <input class="t" id="s-key" type="password" value="${esc(settings.key)}" placeholder="sk-...">
    <label class="f">每天新卡上限</label>
    <input class="t" id="s-new" type="number" min="0" max="100" value="${settings.dailyNew}">
    <div class="row" style="margin-top:16px"><button class="btn primary" id="saveSettings">保存</button></div>

    <h2>进度</h2>
    <div class="hint">进度只保存在这台手机上。导出后放进 git 或网盘，换手机时导入。</div>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="exportProg">导出进度</button>
      <button class="btn" id="importProg">导入进度</button>
    </div>
    <input type="file" id="fileProg" accept="application/json" style="display:none">

    <h2>关于</h2>
    <div class="hint">内容包版本：${esc(state.pack?.version || '-')}<br>
    共 ${state.pack?.courses?.length || 0} 门课。内容在电脑上生成后推到这里，手机刷新即更新。</div>
  `;
  $('#saveSettings').onclick = () => {
    settings.apiBase = $('#s-base').value.trim().replace(/\/$/, '');
    settings.model = $('#s-model').value.trim();
    settings.key = $('#s-key').value.trim();
    settings.dailyNew = Math.max(0, Number($('#s-new').value) || 0);
    saveJSON(LS.settings, settings);
    toast('设置已保存');
  };
  $('#exportProg').onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, progress }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `zenus-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#importProg').onclick = () => $('#fileProg').click();
  $('#fileProg').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = data.progress || data;
      let n = 0;
      for (const [id, v] of Object.entries(incoming)) {
        // 同一条记录取「复习次数更多 / 更晚到期」的那份，避免旧版覆盖新版
        const cur = progress[id];
        if (!cur || (v.reps || 0) > (cur.reps || 0) || (v.due || 0) > (cur.due || 0)) {
          progress[id] = v; n++;
        }
      }
      saveJSON(LS.progress, progress);
      toast(`已合并 ${n} 条进度`);
      render();
    } catch (err) { toast('文件读不出来：' + err.message); }
  };
}

// ── AI ────────────────────────────────────────────────
function aiReady() {
  if (!settings.key) { toast('先在「设置」里填 API Key'); return false; }
  return true;
}

async function streamChat(messages, onDelta) {
  const res = await fetch(`${settings.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
    body: JSON.stringify({ model: settings.model, messages, stream: true, temperature: 0.6 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const j = JSON.parse(payload);
        const d = j.choices?.[0]?.delta?.content;
        if (d) onDelta(d);
      } catch { /* 半包丢弃 */ }
    }
  }
}

const SYS = '你是一位耐心的一对一老师，用简体中文回答。学生 40 多岁，在自学英语/日语/数学。'
  + '回答要短，先给结论再给一句原因；讲解题目时分 2-4 步；不要复述题目；不要客套。';

async function askAbout(card) {
  if (!aiReady() || state.busy) return;
  const q = `请讲讲这张卡：\n正面：${card.front}\n背面：${card.back}`
    + (card.explain ? `\n已有讲解：${card.explain}` : '')
    + '\n用两三句话说清楚为什么会这样，给一个能记住的诀窍。';
  state.tab = 'chat';
  render();
  await pushChat('user', q);
}

async function pushChat(role, content) {
  state.chat.push({ role, content });
  saveJSON(LS.chat, state.chat.slice(-60));
  renderChat();
  const box = $('#chatBox');
  if (box) box.scrollTop = box.scrollHeight;
  if (role === 'user') await reply();
}

async function reply() {
  if (!aiReady()) return;
  state.busy = true;
  const ctx = course()
    ? `当前课程：${course().title}。`
    : '';
  const msgs = [
    { role: 'system', content: SYS + ctx },
    ...state.chat.slice(-12).map(({ role, content }) => ({ role, content })),
  ];
  const bubble = document.createElement('div');
  bubble.className = 'msg ai';
  bubble.textContent = '…';
  $('#chatBox')?.appendChild(bubble);
  let acc = '';
  try {
    await streamChat(msgs, (d) => {
      acc += d;
      bubble.textContent = acc;
      const b = $('#chatBox'); if (b) b.scrollTop = b.scrollHeight;
    });
    state.chat.push({ role: 'assistant', content: acc });
    saveJSON(LS.chat, state.chat.slice(-60));
  } catch (err) {
    bubble.textContent = '出错了：' + err.message;
    bubble.classList.add('sys');
  } finally {
    state.busy = false;
  }
}

async function sendChat() {
  const el = $('#input');
  const text = el.value.trim();
  if (!text || state.busy) return;
  el.value = '';
  await pushChat('user', text);
}

// ── 工具 ──────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function toast(msg) {
  const d = document.createElement('div');
  d.textContent = msg;
  d.style.cssText = 'position:fixed;left:50%;bottom:calc(72px + env(safe-area-inset-bottom,0px));'
    + 'transform:translateX(-50%);background:#2a2f3a;color:#fff;padding:10px 16px;border-radius:10px;'
    + 'font-size:14px;z-index:99;max-width:80vw;text-align:center';
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

// ── 启动 ──────────────────────────────────────────────
document.querySelectorAll('.tabbar button').forEach((b) => {
  b.onclick = () => { state.tab = b.dataset.tab; render(); };
});

(async function init() {
  try {
    await loadPack();
    renderHeader();
    render();
  } catch (err) {
    view.innerHTML = `<div class="empty">内容包加载失败<br><span class="sub">${esc(err.message)}</span></div>`;
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
