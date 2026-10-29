// 学习机 Lite — 静态 PWA：内容来自 pack.json，进度存本地，AI 直连 OpenAI 兼容接口
'use strict';

const BUILD = '2026-10-29.6';

const LS = {
  progress: 'zenus.progress.v1',
  log: 'zenus.log.v1',
  settings: 'zenus.settings.v1',
  chat: 'zenus.chat.v1',
  known: 'zenus.known.v1',
  userCards: 'zenus.usercards.v1',
  readpos: 'zenus.readpos.v1',
};

const DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  key: '',
  dailyNew: 10,
  ttsRate: 0.9,
  ctxMsgs: 12,
  syncToken: '',
  syncRepo: 'AW6202/zenus-state',
  syncDevice: '',
  ttsVoice: '',
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
let known = loadJSON(LS.known, {});   // 已掌握词表：下次抓生词时跳过
let userCards = loadJSON(LS.userCards, []);  // 阅读时自己存的卡
let reviewLog = loadJSON(LS.log, []);
let settings = { ...DEFAULT_SETTINGS, ...loadJSON(LS.settings, {}) };
state.chat = loadJSON(LS.chat, []);

// ── 朗读（Web Speech API，不花流量、不依赖任何服务）──────────
function pickVoice(lang) {
  const vs = window.speechSynthesis?.getVoices?.() || [];
  if (!vs.length) return null;
  if (settings.ttsVoice) {
    const exact = vs.find((v) => v.name === settings.ttsVoice);
    if (exact) return exact;
  }
  const base = lang.slice(0, 2).toLowerCase();
  return vs.find((v) => v.lang?.toLowerCase().startsWith(base)) || null;
}

function speak(text, lang = 'en-US') {
  if (!text) return;
  if (!('speechSynthesis' in window)) { toast('这台设备不支持朗读'); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(String(text));
  u.lang = lang;
  u.rate = Number(settings.ttsRate) || 0.9;
  const v = pickVoice(lang);
  if (v) u.voice = v;
  window.speechSynthesis.speak(u);
}

// 把一句话拆成可点的词：#每个词单独成 span，点哪个读哪个
function speakable(text) {
  return esc(text).replace(/([A-Za-z][A-Za-z'’\-]*)/g,
    '<span class="tapw" data-w="$1">$1</span>');
}

if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = () => { /* 触发一次加载 */ };
}

// ── 已知词表（抓生词时用来跳过）──────────────────────
function normWord(w) {
  return String(w || '').toLowerCase().trim().replace(/[’']/g, "'").replace(/\s+/g, ' ');
}
function isKnown(w) { return !!known[normWord(w)]; }
function markKnown(w, why) {
  if (!w) return;
  known[normWord(w)] = { ts: Date.now(), why: why || 'manual' };
  saveJSON(LS.known, known);
}
function unmarkKnown(w) {
  const k = normWord(w);
  if (known[k]) { delete known[k]; saveJSON(LS.known, known); }
}
// 判定：间隔 ≥21 天、复习 ≥3 次、最近 3 次都是「记得/简单」→ 视为已掌握
function maybePromote(id, word, e) {
  const last3 = reviewLog.filter((x) => x.id === id).slice(-3);
  const solid = e.interval >= 21 && e.reps >= 3 && last3.length >= 3
    && last3.every((x) => x.r === 'good' || x.r === 'easy');
  if (solid) markKnown(word, 'review');
}

// ── 调度（SM-2 简化版）────────────────────────────────
const DAY = 86400000;
function entry(id) {
  return progress[id] || { due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0 };
}
function schedule(id, rating, word) {
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

  // 只追加的复习流水：换调度算法（SM-2 → FSRS）或换 App 都不丢历史
  reviewLog.push({ id, r: rating, ts: now });
  if (reviewLog.length > 5000) reviewLog = reviewLog.slice(-5000);
  saveJSON(LS.log, reviewLog);

  scheduleSync();

  // 复习结果联动已知词表：答错就退回「不认识」，答得稳就升级
  if (word) {
    if (rating === 'again') unmarkKnown(word);
    else maybePromote(id, word, e);
  }
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

const MINE_ID = 'mine';
function course() {
  if (state.courseId === MINE_ID) {
    return { id: MINE_ID, title: '我的生词（阅读时存的）', kind: 'vocab', lang: 'en-US', cards: userCards };
  }
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
  const list = [...(state.pack?.courses || [])];
  if (userCards.length) list.unshift({ id: MINE_ID, title: `我的生词（${userCards.length}）` });
  sel.innerHTML = list
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
  view.addEventListener('scroll', onViewScroll, { passive: true });

document.querySelectorAll('.tabbar button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === state.tab);
  });
  if (state.tab === 'review') return renderReview();
  if (state.tab === 'browse') return renderBrowse();
  if (state.tab === 'reader') return renderReader();
  if (state.tab === 'quiz') return renderQuizTab();
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

function courseLang() {
  const c = course();
  if (c?.lang) return c.lang;
  return (c?.id || '').startsWith('jp') ? 'ja-JP' : 'en-US';
}

function renderReview() {
  if (!state.queue.length) {
    state.queue = dueQueue();
    state.current = null;
    state.revealed = false;
  }
  if (!state.queue.length) {
    view.innerHTML = `${statsBar()}
      <div class="empty">今天这一课清空了 👍<br><span class="sub">换一门课，或让 AI 出几道新题</span></div>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" id="aiQuizBtn">做 10 道测验题</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="againAll">再来一遍（全部重排）</button>
      </div>`;
    $('#againAll').onclick = () => {
      for (const c of allCards()) delete progress[c.id];
      saveJSON(LS.progress, progress);
      state.queue = dueQueue(); render();
    };
    $('#aiQuizBtn').onclick = () => { state.tab = 'quiz'; state.quiz = null; render(); };
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

  const lang = courseLang();
  const speech = !lang.startsWith('zh');
  let body = `<div class="front">${speech ? speakable(c.front) : esc(c.front)}
    ${speech ? `<button class="spk" data-full="${esc(c.front)}" aria-label="朗读">🔊</button>` : ''}</div>`;
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
    if (c.example) {
      body += `<div class="eg">${speech ? speakable(c.example) : esc(c.example)}
        ${speech ? `<button class="spk" data-full="${esc(c.example)}" aria-label="朗读例句">🔊</button>` : ''}</div>`;
      if (c.exampleCN) body += `<div class="egcn">${esc(c.exampleCN)}</div>`;
    }
    if (c.explain) body += `<div class="explain">${esc(c.explain)}</div>`;
    body += `<div class="row" style="width:100%;margin-top:4px">
      <button class="btn ghost" id="askAI">问 AI 讲讲这道</button>
    </div>
    <div class="sub" style="margin-top:6px">
      <a href="javascript:void 0" id="toggleKnown" style="color:var(--dim)">
        ${isKnown(c.front) ? '✓ 已在「已掌握」里，点此移除' : '标记为已掌握（以后抓生词会跳过）'}
      </a>
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
    const w = ev.target.closest('.tapw');
    if (w && state.revealed) {        // 翻面后才点词朗读
      ev.stopPropagation();
      speak(w.dataset.w, lang);
      return;
    }
    if (!state.revealed && !isQuiz) { state.revealed = true; renderReview(); }
  };
  const spk = view.querySelector('.spk');
  if (spk) spk.onclick = (ev) => { ev.stopPropagation(); speak(spk.dataset.full, lang); };
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
      schedule(c.id, b.dataset.r, c.front);
      state.queue.shift();
      state.current = null;
      state.revealed = false;
      state.picked = null;
      renderReview();
    };
  });
  const ask = $('#askAI');
  if (ask) ask.onclick = () => askAbout(c);
  const tk = $('#toggleKnown');
  if (tk) tk.onclick = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    if (isKnown(c.front)) { unmarkKnown(c.front); toast('已移出「已掌握」'); }
    else { markKnown(c.front, 'manual'); toast('已标记为掌握，下次抓词会跳过'); }
    renderReview();
  };

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
    const tag = isKnown(c.front) ? '✓ 已掌握'
      : e.reps === 0 ? '未学' : e.due <= now ? '到期' : `${Math.ceil((e.due - now) / DAY)} 天后`;
    return `<div class="it"><span>${esc(c.front)}</span><small>${tag}</small></div>`;
  }).join('');
  view.innerHTML = `<div class="row" style="margin:6px 0 4px">
      <button class="btn primary" id="aiQuizBtn2">做测验</button>
    </div>
    <h2>${esc(course()?.title || '')} · ${allCards().length} 张</h2>
    <div class="list">${items || '<div class="empty">这门课还没有卡片</div>'}</div>`;
  $('#aiQuizBtn2').onclick = () => { state.tab = 'quiz'; state.quiz = null; render(); };
}

function renderChat() {
  const msgs = state.chat.map((m) =>
    `<div class="msg ${m.role === 'user' ? 'me' : m.role === 'system' ? 'sys' : 'ai'}">${esc(m.content || '')}</div>`
  ).join('');
  view.innerHTML = `<div class="meta">
      <span>携带最近 ${settings.ctxMsgs} 条 · 共 ${state.chat.length} 条</span>
      <span><a href="javascript:void 0" id="clearChat" style="color:var(--acc)">新对话</a></span>
    </div>
    <div class="chat" id="chatBox">${msgs || '<div class="empty">问点什么：这个词怎么用？这道题为什么错？</div>'}</div>
    <div class="composer">
      <textarea id="input" placeholder="输入问题…"></textarea>
      <button id="send">发送</button>
    </div>`;
  const box = $('#chatBox');
  box.scrollTop = box.scrollHeight;
  $('#send').onclick = sendChat;
  const cc = $('#clearChat');
  if (cc) cc.onclick = (ev) => {
    ev.preventDefault();
    if (!state.chat.length) return toast('本来就是空的');
    state.chat = [];
    saveJSON(LS.chat, []);
    renderChat();
    toast('已开新对话，之前的不再带入');
  };
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
    <label class="f">AI 对话携带上下文条数（0 = 每条独立问）</label>
    <input class="t" id="s-ctx" type="number" min="0" max="40" value="${settings.ctxMsgs}">
    <label class="f">朗读语速（0.5 慢 – 1.2 快）</label>
    <input class="t" id="s-rate" type="number" step="0.1" min="0.5" max="1.2" value="${settings.ttsRate}">
    <div class="row" style="margin-top:10px">
      <button class="btn" id="testSpeak">试听一句</button>
    </div>
    <div class="row" style="margin-top:16px"><button class="btn primary" id="saveSettings">保存</button></div>

    <h2>跨设备同步</h2>
    <div class="hint">私有仓库 ${esc(settings.syncRepo)}；本机设备号 ${esc(deviceId())}。
    每台设备只写自己的文件，打开时合并，写操作不会互相覆盖。</div>
    <label class="f">GitHub Token（只给这个仓库 contents 读写）</label>
    <input class="t" id="s-gh" type="password" value="${esc(settings.syncToken)}" placeholder="github_pat_...">
    <label class="f">仓库</label>
    <input class="t" id="s-repo" value="${esc(settings.syncRepo)}">
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="doSync">立即同步</button>
      <button class="btn" id="saveSync">保存</button>
    </div>

    <h2>已掌握词表</h2>
    <div class="hint">共 ${Object.keys(known).length} 条。复习稳（间隔≥21天且连续答对）会自动加入，答错自动移出；抓生词时会跳过这些。</div>
    <div class="row" style="margin-top:8px"><button class="btn" id="clearKnown">清空词表</button></div>

    <h2>进度</h2>
    <div class="hint">进度只保存在这台手机上。导出后放进 git 或网盘，换手机时导入。</div>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="exportProg">导出进度</button>
      <button class="btn" id="importProg">导入进度</button>
    </div>
    <input type="file" id="fileProg" accept="application/json" style="display:none">

    <h2>关于</h2>
    <div class="row" style="margin-bottom:8px"><button class="btn" id="checkUpdate">检查更新</button></div>
    <div class="row" style="margin-bottom:8px">
      <a class="btn" href="demo.html" style="display:block;text-align:center;text-decoration:none;color:var(--text)">看「要点 → 题 → 重写」试验</a>
    </div>
    <div class="hint">构建 ${esc(BUILD)} · 内容包 ${esc(state.pack?.version || '-')}<br>
    共 ${state.pack?.courses?.length || 0} 门课。内容在电脑上生成后推到这里，手机刷新即更新。</div>
  `;
  $('#saveSettings').onclick = () => {
    settings.apiBase = $('#s-base').value.trim().replace(/\/$/, '');
    settings.model = $('#s-model').value.trim();
    settings.key = $('#s-key').value.trim();
    settings.dailyNew = Math.max(0, Number($('#s-new').value) || 0);
    settings.ctxMsgs = Math.max(0, Math.min(40, Number($('#s-ctx').value) || 0));
    settings.ttsRate = Math.min(1.2, Math.max(0.5, Number($('#s-rate').value) || 0.9));
    saveJSON(LS.settings, settings);
    toast('设置已保存');
  };
  const tst = $('#testSpeak');
  if (tst) tst.onclick = () => {
    settings.ctxMsgs = Math.max(0, Math.min(40, Number($('#s-ctx').value) || 0));
    settings.ttsRate = Math.min(1.2, Math.max(0.5, Number($('#s-rate').value) || 0.9));
    speak('This is how it sounds. Tap any word to hear it again.');
  };
  const ds = $('#doSync');
  if (ds) ds.onclick = async () => {
    settings.syncToken = $('#s-gh').value.trim();
    settings.syncRepo = $('#s-repo').value.trim() || settings.syncRepo;
    saveJSON(LS.settings, settings);
    await syncNow();
    renderSettings();
  };
  const ss = $('#saveSync');
  if (ss) ss.onclick = () => {
    settings.syncToken = $('#s-gh').value.trim();
    settings.syncRepo = $('#s-repo').value.trim() || settings.syncRepo;
    saveJSON(LS.settings, settings);
    toast('已保存');
  };
  const ck = $('#clearKnown');
  if (ck) ck.onclick = () => {
    if (!Object.keys(known).length) return toast('本来就是空的');
    known = {}; saveJSON(LS.known, known); renderSettings(); toast('已清空');
  };
  const cu = $('#checkUpdate');
  if (cu) cu.onclick = async () => {
    try {
      if (settings.syncToken) setTimeout(() => syncNow({ quiet: true }), 1500);
  if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      toast('已清理缓存，正在重新加载…');
      setTimeout(() => location.replace(location.pathname + '?v=' + Date.now()), 600);
    } catch (err) { toast('更新失败：' + err.message); }
  };
  $('#exportProg').onclick = () => {
    const blob = new Blob([JSON.stringify({ version: 1, progress, log: reviewLog }, null, 2)],
      { type: 'application/json' });
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
    ...state.chat.slice(-Math.max(0, Number(settings.ctxMsgs) || 0)).map(({ role, content }) => ({ role, content })),
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

// ── 测验：本地出题（不联网）+ AI 出题（可选）──────────
function shuffle(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function localQuiz(kind = 'mixed', n = 10) {
  const cards = allCards().filter((c) => c.front && c.back);
  if (cards.length < 4) return [];
  const qs = [];
  shuffle(cards).forEach((c, i) => {
    if (qs.length >= n) return;
    // 例句填空：句子来自卡片自带的 example；混合模式下约 4 成是填空
    const wantCloze = kind === 'cloze' || (kind === 'mixed' && i % 5 < 2);
    if (wantCloze && c.example && new RegExp(escRe(c.front), 'i').test(c.example)) {
      qs.push({
        type: 'cloze',
        q: c.example.replace(new RegExp(escRe(c.front), 'gi'), '____'),
        answer: c.front,
        hint: `提示：${c.back}`,
        explain: `${c.front} — ${c.back}`,
      });
      return;
    }
    if (kind === 'cloze') return;
    const toCn = i % 2 === 0;                       // 交替：看词选义 / 看义选词
    const answer = toCn ? c.back : c.front;
    const pool = shuffle(cards
      .filter((x) => x.id !== c.id)
      .map((x) => (toCn ? x.back : x.front))
      .filter((v) => v && v !== answer));
    const options = shuffle([answer, ...pool.slice(0, 3)]);
    if (options.length < 3) return;
    qs.push({
      type: 'mcq',
      q: toCn ? c.front : c.back,
      options,
      answer,
      explain: c.example ? `${c.example}${c.exampleCN ? '\n' + c.exampleCN : ''}` : '',
    });
  });
  return qs;
}

function startQuiz(qs) {
  if (!qs.length) { toast('这门课卡片太少，出不了题'); return; }
  state.quiz = { qs, idx: 0, right: 0, picked: null, revealed: false, typed: '' };
  renderQuiz();
}

function renderQuizTab() {
  if (state.quiz) return renderQuiz();
  const hasKey = !!settings.key;
  view.innerHTML = `<h2>${esc(course()?.title || '')} · ${allCards().length} 张</h2>
    ${hasKey ? `<div class="hint">AI 会按这门课的内容另编题，更贴近实际用法。</div>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="qAi">✨ 让 AI 出 5 道新题</button></div>
    <h2>离线自测（不联网、不花钱）</h2>` : `<div class="hint">先在「设置」填 API Key，就能让 AI 按课程内容另编题；下面这些不联网也能用。</div>`}
    <div class="row" style="margin-top:12px"><button class="btn ${hasKey ? '' : 'primary'}" id="qMix">混合 10 题</button></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="qMcq">只做选择题</button></div>
    <div class="row" style="margin-top:8px"><button class="btn" id="qCloze">只做例句填空</button></div>`;
  $('#qMix').onclick = () => startQuiz(localQuiz('mixed'));
  $('#qMcq').onclick = () => startQuiz(localQuiz('mcq'));
  $('#qCloze').onclick = () => startQuiz(localQuiz('cloze'));
  const aiBtn = $('#qAi');
  if (aiBtn) aiBtn.onclick = () => startAiQuiz();
}

async function startAiQuiz() {
  if (!aiReady() || state.busy) return;
  const cards = allCards();
  if (cards.length < 4) { toast('这门课卡片太少，先加点内容'); return; }
  state.busy = true;
  view.innerHTML = '<div class="empty">AI 正在出题…<div class="spin" style="margin:12px auto"></div></div>';
  const sample = shuffle(cards).slice(0, 15).map((c) => `- ${c.front} = ${c.back}`).join('\n');
  const prompt = `课程：${course().title}\n卡片：\n${sample}\n\n`
    + '出 5 道题，覆盖这些内容：3 道单选（4 个选项，只有 1 个正确），2 道填空（答案是词或短语）。\n'
    + '只返回 JSON，不要解释：{"questions":['
    + '{"type":"mcq","q":"题干","options":["A","B","C","D"],"answer":"正确选项原文","explain":"一句中文解释"},'
    + '{"type":"cloze","q":"含 ___ 的句子","answer":"答案","explain":"一句中文解释"}]}';
  try {
    const res = await fetch(`${settings.apiBase}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.key}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: '你是出题老师，只输出 JSON。' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const data = JSON.parse(j.choices[0].message.content);
    const qs = (data.questions || []).slice(0, 5);
    if (!qs.length) throw new Error('模型没给出题目');
    state.quiz = { qs, idx: 0, right: 0, picked: null, revealed: false, typed: '' };
    state.tab = 'quiz';
    renderQuiz();
  } catch (err) {
    toast('出题失败：' + err.message);
    state.tab = 'quiz'; state.quiz = null; render();
  } finally {
    state.busy = false;
  }
}

function renderQuiz() {
  const z = state.quiz;
  if (!z) { renderQuizTab(); return; }
  if (z.idx >= z.qs.length) {
    const pct = Math.round((z.right / z.qs.length) * 100);
    view.innerHTML = `<div class="empty">做完啦 🎉<br>
      <span class="sub">答对 ${z.right} / ${z.qs.length}（${pct}%）</span></div>
      <div class="row" style="margin-top:16px">
        <button class="btn primary" id="qAgain">再来一组</button>
      </div>
      <div class="row" style="margin-top:8px">
        <button class="btn" id="qBack">挑别的题型</button>
      </div>`;
    $('#qAgain').onclick = () => startQuiz(localQuiz('mixed'));
    $('#qBack').onclick = () => { state.quiz = null; render(); };
    if (!z.done) {
      z.done = true;
      reviewLog.push({ id: 'quiz-' + Date.now(), r: pct >= 80 ? 'good' : 'again', ts: Date.now() });
      saveJSON(LS.log, reviewLog.slice(-5000));
    }
    return;
  }
  const q = z.qs[z.idx];
  const head = `<div class="meta"><span>第 ${z.idx + 1} / ${z.qs.length} 题</span>
    <span>答对 ${z.right}</span></div>`;
  let body = `<div class="front" style="font-size:19px">${esc(q.q)}</div>`;
  if (q.hint && !z.revealed) body += `<div class="sub">${esc(q.hint)}</div>`;

  if (q.type === 'mcq' && Array.isArray(q.options)) {
    body += `<div class="opts">${q.options.map((o, i) => {
      let cls = '';
      if (z.revealed) {
        if (o === q.answer) cls = 'right';
        else if (i === z.picked) cls = 'wrong';
      } else if (i === z.picked) cls = 'sel';
      return `<button data-i="${i}" class="${cls}">${esc(o)}</button>`;
    }).join('')}</div>`;
  } else {
    body += `<input class="t" id="clozeIn" placeholder="填答案" ${z.revealed ? 'disabled' : ''}
      value="${z.revealed ? esc(z.typed || '') : ''}">`;
  }

  if (z.revealed) {
    body += `<div class="back" style="margin-top:12px">答案：${esc(q.answer)}</div>`;
    if (q.explain) body += `<div class="explain">${esc(q.explain)}</div>`;
  }

  view.innerHTML = head + `<div class="card">${body}</div>` + (z.revealed
    ? '<div class="row" style="margin-top:12px"><button class="btn primary" id="qNext">下一题</button></div>'
    : q.type === 'cloze'
      ? '<div class="row" style="margin-top:12px"><button class="btn primary" id="qSubmit">提交</button></div>'
      : '');

  view.querySelectorAll('.opts button').forEach((b) => {
    b.onclick = () => {
      if (z.revealed) return;
      z.picked = Number(b.dataset.i);
      z.revealed = true;
      if (q.options[z.picked] === q.answer) z.right++;
      renderQuiz();
    };
  });
  const sub = $('#qSubmit');
  if (sub) {
    sub.onclick = () => {
      const v = ($('#clozeIn')?.value || '').trim();
      z.typed = v;
      z.revealed = true;
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9一-龥 ]/g, '').trim();
      if (norm(v) === norm(q.answer)) z.right++;
      renderQuiz();
    };
  }
  const next = $('#qNext');
  if (next) next.onclick = () => { z.idx++; z.picked = null; z.revealed = false; z.typed = ''; renderQuiz(); };
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



// ── 跨设备同步（GitHub 私有仓，按设备分文件）──────────
// 每个设备只写 devices/<自己>.json，读取时合并 → 写操作永不冲突
function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function deviceId() {
  if (!settings.syncDevice) {
    settings.syncDevice = 'dev-' + Math.random().toString(36).slice(2, 8);
    saveJSON(LS.settings, settings);
  }
  return settings.syncDevice;
}

function ghHeaders() {
  return {
    Authorization: 'Bearer ' + settings.syncToken,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(path) {
  const r = await fetch('https://api.github.com/repos/' + settings.syncRepo + '/contents/' + path,
    { headers: ghHeaders(), cache: 'no-store' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
  return r.json();
}

async function ghPut(path, obj, sha) {
  const body = { message: 'sync ' + new Date().toISOString(), content: b64encode(JSON.stringify(obj)) };
  if (sha) body.sha = sha;
  const r = await fetch('https://api.github.com/repos/' + settings.syncRepo + '/contents/' + path, {
    method: 'PUT',
    headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('写入失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}

function localState() {
  return { device: deviceId(), updatedAt: Date.now(), progress, log: reviewLog, known, userCards };
}

function mergeState(remote) {
  let changed = 0;
  // 进度：取「复习次数更多 / 到期更晚」
  for (const [id, v] of Object.entries(remote.progress || {})) {
    const cur = progress[id];
    if (!cur || (v.reps || 0) > (cur.reps || 0) || (v.due || 0) > (cur.due || 0)) {
      progress[id] = v; changed++;
    }
  }
  // 复习流水：按 (id, ts) 求并集
  const seen = new Set(reviewLog.map((x) => x.id + '@' + x.ts));
  for (const e of remote.log || []) {
    if (!seen.has(e.id + '@' + e.ts)) { reviewLog.push(e); seen.add(e.id + '@' + e.ts); changed++; }
  }
  reviewLog.sort((a, b) => a.ts - b.ts);
  if (reviewLog.length > 5000) reviewLog = reviewLog.slice(-5000);
  // 已掌握：并集，取更新的时间戳
  for (const [k, v] of Object.entries(remote.known || {})) {
    if (!known[k] || (v.ts || 0) > (known[k].ts || 0)) { known[k] = v; changed++; }
  }
  // 自己存的卡：按正面去重
  const fronts = new Set(userCards.map((c) => String(c.front).toLowerCase()));
  for (const c of remote.userCards || []) {
    if (c && c.front && !fronts.has(String(c.front).toLowerCase())) {
      userCards.unshift(c); fronts.add(String(c.front).toLowerCase()); changed++;
    }
  }
  if (changed) {
    saveJSON(LS.progress, progress);
    saveJSON(LS.log, reviewLog);
    saveJSON(LS.known, known);
    saveJSON(LS.userCards, userCards);
    renderHeader();
  }
  return changed;
}

async function syncNow(opts) {
  const quiet = opts && opts.quiet;
  if (!settings.syncToken) {
    if (!quiet) toast('先在设置里填 GitHub token');
    return null;
  }
  try {
    if (!quiet) toast('同步中…');
    // 1) 拉所有设备的文件并合并
    const dir = await ghGet('devices');
    let pulled = 0, files = 0;
    for (const f of (Array.isArray(dir) ? dir : [])) {
      if (!f.name.endsWith('.json') || f.name === deviceId() + '.json') continue;
      const one = await ghGet('devices/' + f.name);
      if (!one || !one.content) continue;
      pulled += mergeState(JSON.parse(b64decode(one.content)));
      files++;
    }
    // 2) 推自己的文件
    const own = await ghGet('devices/' + deviceId() + '.json');
    await ghPut('devices/' + deviceId() + '.json', localState(), own && own.sha);
    if (!quiet) toast('同步完成：合并 ' + files + ' 台设备，更新 ' + pulled + ' 条');
    return pulled;
  } catch (err) {
    if (!quiet) toast('同步失败：' + err.message);
    return null;
  }
}

let syncTimer = null;
function scheduleSync() {
  if (!settings.syncToken) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow({ quiet: true }), 60000);
}


// ── 阅读器（pdf.js，本地解析，文件不上传）────────────
const RDR = {
  pdf: null, page: 1, total: 0, name: '', scale: 1, rendering: false,
  kind: null, book: null, ch: 0, urls: [], assets: {},
};

const scriptOnce = {};
function loadScript(src) {
  if (scriptOnce[src]) return scriptOnce[src];           // 并发/重复调用共用一次加载
  scriptOnce[src] = new Promise((res, rej) => {
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => res();
    el.onerror = () => { delete scriptOnce[src]; el.remove(); rej(new Error('加载失败 ' + src)); };
    document.head.appendChild(el);
  }).catch((e) => { delete scriptOnce[src]; throw e; });
  return scriptOnce[src];
}

// 关键：脚本「加载完了」不等于「全局变量挂上了」（缓存里存过坏响应时，
// onload 照样触发，但 window.JSZip 是 undefined —— 2026-10-29 用户手机上就报这个）。
// 所以加载后必须验全局，失败就用带版本号的 URL 再取一次（绕开坏缓存）。
async function ensureLib(url, globalName) {
  if (window[globalName]) return window[globalName];
  for (let attempt = 0; attempt < 2; attempt++) {
    const src = attempt === 0 ? url : url + '?v=' + encodeURIComponent(BUILD);
    try { await loadScript(src); } catch (err) { if (attempt === 1) throw new Error('取不到 ' + url + '（' + err.message + '）'); }
    if (window[globalName]) return window[globalName];
  }
  throw new Error(globalName + ' 没加载成功，请再点一次「选择文件」');
}

async function ensurePdfJs() {
  await ensureLib('vendor/pdf.min.js', 'pdfjsLib');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
}

async function openBookFile(ev) {
  const f = ev.target.files && ev.target.files[0];
  if (!f) return;
  const name = f.name.toLowerCase();
  if (name.endsWith('.epub')) return openEpubBook(f);
  if (name.endsWith('.docx')) return openDocxBook(f);
  if (name.endsWith('.txt') || name.endsWith('.md')) return openTextBook(f);
  return openPdfFile(f);
}

async function openTextBook(f) {
  resetBook();
  const txt = decodeText(await f.arrayBuffer());
  RDR.pdf = null;
  if (/\.md$/i.test(f.name)) {
    RDR.kind = 'md';
    RDR.book = { name: f.name, chapters: mdChapters(txt) };
  } else {
    RDR.kind = 'text';
    RDR.book = { name: f.name, chapters: chunkText(txt, 6000) };
  }
  RDR.key = docKey(f);
  RDR.ch = 0;
  const ratio = applyReadPos();
  renderReader();
  if (ratio) requestAnimationFrame(() => scrollToRatio(ratio));
}

// Markdown：按一级标题切章（没有 h1 退到 h1/h2，再没有就按长度切）；每章渲染成 HTML
function mdChapters(txt, size = 6000) {
  const t = String(txt).replace(/\r\n?/g, '\n');
  // 先按一级标题切（一篇笔记一章）；没有 h1 再退到 h1/h2；都没有就按长度切
  let sections = t.split(/\n(?=#[ \t])/).map((x) => x.trim()).filter(Boolean);
  if (sections.length <= 1) sections = t.split(/\n(?=#{1,2}[ \t])/).map((x) => x.trim()).filter(Boolean);
  if (sections.length <= 1) sections = chunkText(t, size).map((c) => c.text);
  const chapters = [];
  for (const sec of sections) {
    const head = /^#{1,2}[ \t]+(.+)$/m.exec(sec);
    const pieces = sec.length > size * 1.5 ? chunkText(sec, size).map((c) => c.text) : [sec];
    for (const piece of pieces) {
      const html = mdToHtml(piece);
      chapters.push({
        title: head ? head[1].trim().slice(0, 40) : ('第 ' + (chapters.length + 1) + ' 节'),
        text: htmlToText(html),
        html: html,
      });
    }
  }
  return chapters.length ? chapters
    : chunkText(t, size).map((c) => ({ title: c.title, text: c.text, html: mdToHtml(c.text) }));
}

// 只做「读得下去」所需的那一层 Markdown：标题/段落/列表/引用/代码/强调/分隔线。
// 链接和图片只留文字——离线取词场景里点不动也加载不了。
function mdToHtml(md) {
  const fences = [];
  let s = String(md).replace(/\r\n?/g, '\n').replace(/```[^\n]*\n([\s\S]*?)```/g, (m, code) => {
    fences.push(code.replace(/\n$/, ''));
    return '\u0000F' + (fences.length - 1) + '\u0000';
  });

  const inline = (t) => {
    let x = esc(t);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    x = x.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    x = x.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1<em>$2</em>');
    return x;
  };

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  const lines = s.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\u0000F(\d+)\u0000\s*$/.exec(line.trim());
    if (fence) { closeList(); out.push('<pre><code>' + esc(fences[+fence[1]]) + '</code></pre>'); continue; }
    if (!line.trim()) { closeList(); continue; }

    const h = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (h) {
      closeList();
      const n = Math.min(6, h[1].length);
      out.push('<h' + n + '>' + inline(h[2]) + '</h' + n + '>');
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }

    if (/^\s*>/.test(line)) {
      closeList();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      i--;
      out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>');
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>');
      continue;
    }

    closeList();
    out.push('<p>' + inline(line) + '</p>');   // md 一行一段（中文笔记几乎都是这么写的）
  }
  closeList();
  return out.join('\n');
}

// 纯文本解码：UTF-8 失败就按 GB18030 再试（中文 txt 小说大量是 GBK），UTF-16 靠 BOM
function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 1 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (b.length > 1 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gb18030').decode(buf); } catch { /* 老浏览器没有 */ }
    return new TextDecoder('utf-8').decode(buf);
  }
}

// 按段落把纯文本切成「章」：空行分段；没有空行的（txt 小说常见）按行分段；超长段硬切
function chunkText(txt, size) {
  const t = String(txt).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  let paras = t.split(/\n[ \t]*\n/).map((x) => x.trim()).filter(Boolean);
  if (paras.length <= 2) paras = t.split('\n').map((x) => x.trim()).filter(Boolean);

  const chapters = [];
  let cur = [];
  let len = 0;
  const flush = () => { if (cur.length) { chapters.push(cur); cur = []; len = 0; } };
  for (let p of paras) {
    while (p.length > size) {          // 一整块没有分段的超长文本
      flush();
      chapters.push([p.slice(0, size)]);
      p = p.slice(size);
    }
    if (len + p.length > size) flush();
    cur.push(p);
    len += p.length;
  }
  flush();
  return chapters.map((ps, i) => {
    const head = ps[0].split('\n')[0].trim();
    const title = head && head.length <= 30 ? head : '第 ' + (i + 1) + ' 段';
    return { title: title, text: ps.join('\n\n') };
  });
}

async function openEpubBook(f) {
  view.innerHTML = '<div class="empty">正在解析 EPUB…</div>';
  try {
    await ensureJSZip();
    resetBook();
    const zip = await JSZip.loadAsync(await f.arrayBuffer());
    const chapters = await parseEpub(zip);
    if (!chapters.length) throw new Error('没找到可读的章节');
    RDR.kind = 'epub';
    RDR.pdf = null;
    RDR.book = { name: f.name, chapters: chapters };
    RDR.key = docKey(f);
    RDR.ch = 0;
    const ratio = applyReadPos();
    renderReader();
    if (ratio) requestAnimationFrame(() => scrollToRatio(ratio));
  } catch (err) {
    view.innerHTML = '<div class="empty">打不开这个 EPUB<br><span class="sub">' + esc(err.message) + '</span></div>';
  }
}

// 换书 / 关书：把上一本生成的图片 blob URL 释放掉，否则内存只涨不落
function resetBook() {
  // 注意：PDF 也必须在这里清掉。之前只清 book/kind，导致「关闭这份 PDF」按钮点了没反应
  // （renderReader 看到 RDR.pdf 还在，又渲染回 PDF 视图）——2026-10-29 用户报的 bug G。
  if (RDR.pdf && typeof RDR.pdf.destroy === 'function') {
    try { RDR.pdf.destroy(); } catch { /* 已销毁 */ }
  }
  RDR.pdf = null;
  RDR.page = 1;
  RDR.total = 0;
  RDR.rendering = false;
  (RDR.urls || []).forEach((u) => { try { URL.revokeObjectURL(u); } catch { /* 已释放 */ } });
  RDR.urls = [];
  RDR.assets = {};
  RDR.book = null;
  RDR.kind = null;
  RDR.fontFix = false;
  if (RDR.srcUrl) { try { URL.revokeObjectURL(RDR.srcUrl); } catch { /* 已释放 */ } }
  RDR.srcUrl = null;
  RDR.fontRisk = false;
  RDR.textLines = [];
  RDR.textMode = false;
  RDR.key = null;
}

function scrollToRatio(ratio) {
  const max = Math.max(0, view.scrollHeight - view.clientHeight);
  view.scrollTop = Math.max(0, Math.min(1, ratio)) * max;
}

// 滚动就记位置（节流），顺手过滤掉「恢复位置时滚动自己触发的那一次」
let posTimer = null;
function onViewScroll() {
  if (RDR.restoring || !RDR.key || !(RDR.book || RDR.pdf)) return;
  clearTimeout(posTimer);
  posTimer = setTimeout(saveReadPos, 700);
}

// ── 阅读进度：同一个文件再打开，回到上次读到的地方 ────────────
let readPositions = loadJSON(LS.readpos, {});

function docKey(f) { return f.name + '|' + (f.size || 0); }

function saveReadPos() {
  if (!RDR.key || !(RDR.pdf || RDR.book)) return;
  const r = { at: Date.now() };
  if (RDR.pdf) { r.page = RDR.page; r.scale = RDR.scale; }
  if (RDR.book) {
    r.ch = RDR.ch;
    const max = Math.max(1, view.scrollHeight - view.clientHeight);
    r.ratio = Math.max(0, Math.min(1, view.scrollTop / max));
  }
  readPositions[RDR.key] = r;
  const keys = Object.keys(readPositions);
  if (keys.length > 50) {                       // 只留最近 50 个文件
    keys.sort((a, b) => (readPositions[a].at || 0) - (readPositions[b].at || 0));
    for (const k of keys.slice(0, keys.length - 50)) delete readPositions[k];
  }
  saveJSON(LS.readpos, readPositions);
}

// 恢复位置，返回「之前滚到的比例」（文字类才需要）
function applyReadPos() {
  const r = RDR.key ? readPositions[RDR.key] : null;
  if (!r) return 0;
  RDR.restoring = true;
  if (RDR.pdf) {
    if (r.scale) RDR.scale = r.scale;
    if (r.page && r.page > 1) RDR.page = Math.min(r.page, Math.max(1, RDR.total));
    if (RDR.page > 1) toast('回到上次读的第 ' + RDR.page + ' 页');
    setTimeout(() => { RDR.restoring = false; }, 800);
    return 0;
  }
  if (RDR.book) {
    RDR.ch = Math.max(0, Math.min(r.ch || 0, RDR.book.chapters.length - 1));
    setTimeout(() => { RDR.restoring = false; }, 800);
    if (RDR.ch > 0) toast('回到上次读的第 ' + (RDR.ch + 1) + ' 节');
    return r.ratio || 0;
  }
  RDR.restoring = false;
  return 0;
}

async function ensureJSZip() {
  await ensureLib('vendor/jszip.min.js', 'JSZip');
}

function htmlToText(html) {
  let h = html.replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<head[\s\S]*?<\/head>/gi, '');
  h = h.replace(/<(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, '\n');
  h = h.replace(/<[^>]+>/g, '');
  h = h.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  h = h.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  return h.trim();
}

function firstHeading(html) {
  const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html);
  if (!m) return '';
  return htmlToText(m[1]).replace(/\s+/g, ' ').slice(0, 40);
}

async function parseEpub(zip) {
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new Error('不是标准 EPUB（缺 container.xml）');
  const container = await containerFile.async('string');
  const opfMatch = /full-path="([^"]+)"/.exec(container);
  if (!opfMatch) throw new Error('找不到 package.opf');
  const opfPath = opfMatch[1];
  const opf = await zip.file(opfPath).async('string');
  const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(opf))) {
    const tag = m[0];
    const id = /id="([^"]+)"/.exec(tag);
    const href = /href="([^"]+)"/.exec(tag);
    const type = /media-type="([^"]+)"/.exec(tag);
    if (id && href) manifest[id[1]] = { href: href[1], type: type ? type[1] : '' };
  }

  const order = [];
  const refRe = /<itemref\b[^>]*idref="([^"]+)"/gi;
  while ((m = refRe.exec(opf))) {
    const it = manifest[m[1]];
    if (it && (!it.type || it.type.indexOf('html') >= 0)) order.push(it.href);
  }

  const chapters = [];
  for (const href of order) {
    const path = zipPath(baseDir, href);
    const f = zip.file(path);
    if (!f) continue;
    const raw = await f.async('string');
    const ch = await epubChapter(raw, zip, baseDir);
    // 只丢「彻底空的页」（封面/空白页）。原来是 <60 字就丢——会把短章节静默吞掉。
    if (!ch || (ch.text.length < 10 && !ch.imgs)) continue;
    chapters.push({
      title: firstHeading(raw) || ('第 ' + (chapters.length + 1) + ' 节'),
      text: ch.text,
      html: ch.html,
    });
  }
  return chapters;
}

// 一章 XHTML → 可渲染的干净 HTML + 纯文本
async function epubChapter(rawHtml, zip, baseDir) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const body = doc.body;
  if (!body) return null;
  body.querySelectorAll('script,style,head,title,link,meta,iframe,object,embed,form,noscript,audio,video')
    .forEach((n) => n.remove());

  // 图片：书里的相对路径去 zip 里捞，转成本地 blob URL；取不到就删掉，别留破图
  for (const img of [...body.querySelectorAll('img')]) {
    const url = await epubAsset(img.getAttribute('src'), zip, baseDir);
    if (!url) { img.remove(); continue; }
    img.setAttribute('src', url);
    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
  }

  // 只留结构：去掉书自带的 class/id/style、事件属性、尺寸属性
  const drop = ['class', 'id', 'style', 'srcset', 'width', 'height', 'align', 'bgcolor', 'border', 'cellpadding', 'cellspacing'];
  for (const el of body.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const v = String(a.value || '');
      if (drop.includes(n) || /^on[a-z]+$/.test(n)) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src') && /^\s*(javascript|vbscript)/i.test(v)) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') { el.removeAttribute('href'); el.removeAttribute('target'); } // 站内链接点不走，留文字
    if (el.tagName === 'SVG') el.remove();
  }

  const html = body.innerHTML.trim();
  const text = htmlToText(html);
  return { html: html, text: text, imgs: body.querySelectorAll('img').length };
}

// "EPUB/Images/a b.png" 这类相对路径 → zip 内的规范路径（处理 ../ 与 %20）
function zipPath(baseDir, src) {
  const clean = String(src || '').split(/[?#]/)[0];
  if (!clean) return '';
  let p = clean;
  try { p = decodeURIComponent(clean); } catch { /* % 编码不合法，按原样找 */ }
  const out = [];
  for (const seg of (baseDir + p).split('/')) {
    if (seg === '..') out.pop();
    else if (seg && seg !== '.') out.push(seg);
  }
  return out.join('/');
}

const IMG_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
};

async function epubAsset(src, zip, baseDir) {
  if (!src) return null;
  if (/^data:/i.test(src)) return src;
  if (/^(https?:)?\/\//i.test(src)) return src;      // 远程图交给浏览器，挂了会被隐藏
  const path = zipPath(baseDir, src);
  if (!path) return null;
  if (RDR.assets[path]) return RDR.assets[path];
  const f = zip.file(path);
  if (!f) return null;
  const type = IMG_MIME[(path.split('.').pop() || '').toLowerCase()];
  if (!type) return null;                             // 只认位图，字体/CSS 一律跳过
  const u8 = await f.async('uint8array');
  const url = URL.createObjectURL(new Blob([u8], { type: type }));
  RDR.assets[path] = url;
  RDR.urls.push(url);
  return url;
}

// ── DOCX（JSZip + word/document.xml，不依赖任何转换服务）────────
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function openDocxBook(f) {
  view.innerHTML = '<div class="empty">正在解析 DOCX…</div>';
  try {
    await ensureJSZip();
    resetBook();
    const zip = await JSZip.loadAsync(await f.arrayBuffer());
    const chapters = await parseDocx(zip);
    if (!chapters.length) throw new Error('没找到可读的段落');
    RDR.kind = 'docx';
    RDR.pdf = null;
    RDR.book = { name: f.name, chapters: chapters };
    RDR.key = docKey(f);
    RDR.ch = 0;
    const ratio = applyReadPos();
    renderReader();
    if (ratio) requestAnimationFrame(() => scrollToRatio(ratio));
  } catch (err) {
    view.innerHTML = '<div class="empty">打不开这个 DOCX<br><span class="sub">' + esc(err.message) + '</span></div>';
  }
}

// styles.xml：把 Word 的「样式 ID」翻成标题级别（中文 Word 的 ID 常是数字，名字才是 heading N）
async function docxHeadingMap(zip) {
  const map = {};
  const f = zip.file('word/styles.xml');
  if (!f) return map;
  const dom = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  for (const st of dom.getElementsByTagNameNS(W_NS, 'style')) {
    const id = st.getAttributeNS(W_NS, 'styleId') || st.getAttribute('w:styleId');
    const nameEl = st.getElementsByTagNameNS(W_NS, 'name')[0];
    const name = nameEl ? (nameEl.getAttributeNS(W_NS, 'val') || nameEl.getAttribute('w:val') || '') : '';
    if (!id) continue;
    const lv = /^(?:heading|标题)\s*([1-9])$/i.exec(name.trim()) || /^title$/i.exec(name.trim());
    if (lv) map[id] = lv[1] ? Number(lv[1]) : 1;
  }
  return map;
}

// 图片：document.xml 里只有 rId，真正的文件在 word/media/，靠 rels 对上号
async function docxRels(zip) {
  const map = {};
  const f = zip.file('word/_rels/document.xml.rels');
  if (!f) return map;
  const dom = new DOMParser().parseFromString(await f.async('string'), 'application/xml');
  for (const rel of dom.getElementsByTagNameNS('*', 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target') || '';
    if (!id || !target) continue;
    if (/^https?:/i.test(target)) { map[id] = target; continue; }
    const path = zipPath('word/', target);
    const type = IMG_MIME[(path.split('.').pop() || '').toLowerCase()];
    const file = type && zip.file(path);
    if (!file) continue;
    const u8 = await file.async('uint8array');
    const url = URL.createObjectURL(new Blob([u8], { type: type }));
    RDR.assets[path] = url;
    RDR.urls.push(url);
    map[id] = url;
  }
  return map;
}

function docxKids(el, name) { return [...el.children].filter((c) => c.localName === name); }
function docxWAttr(el, name) {
  return el.getAttributeNS(W_NS, name) || el.getAttribute('w:' + name) || '';
}

// 一段里的所有 run → HTML（粗/斜/换行/制表/图片/域代码/修订）
function docxRuns(el, imgMap) {
  let out = '';
  for (const node of [...el.childNodes]) {
    if (node.nodeType !== 1) continue;
    const ln = node.localName;
    if (ln === 'r') {
      let inner = docxRuns(node, imgMap);
      const rPr = docxKids(node, 'rPr')[0];
      if (rPr && inner) {
        const b = docxKids(rPr, 'b')[0];
        const i = docxKids(rPr, 'i')[0];
        if (b && docxWAttr(b, 'val') !== '0' && docxWAttr(b, 'val') !== 'false') inner = '<strong>' + inner + '</strong>';
        if (i && docxWAttr(i, 'val') !== '0' && docxWAttr(i, 'val') !== 'false') inner = '<em>' + inner + '</em>';
      }
      out += inner;
    } else if (ln === 't') {
      out += esc(node.textContent);
    } else if (ln === 'br' || ln === 'cr') {
      out += '<br>';
    } else if (ln === 'tab') {
      out += '&nbsp;&nbsp;&nbsp;&nbsp;';
    } else if (ln === 'drawing' || ln === 'pict') {
      out += docxImages(node, imgMap);
    } else if (ln === 'del' || ln === 'instrText' || ln === 'delText' || ln === 'footnoteReference') {
      /* 修订删除 / 域代码 / 脚注引用：不显示 */
    } else {
      out += docxRuns(node, imgMap);
    }
  }
  return out;
}

function docxImages(el, imgMap) {
  let out = '';
  for (const blip of el.getElementsByTagNameNS('*', 'blip')) {
    const rid = blip.getAttributeNS(R_NS, 'embed') || blip.getAttribute('r:embed') || '';
    if (imgMap[rid]) out += '<img src="' + imgMap[rid] + '" alt="">';
  }
  return out;
}

function docxParaBlock(p, imgMap, headingMap) {
  const pPr = docxKids(p, 'pPr')[0];
  const styleEl = pPr && docxKids(pPr, 'pStyle')[0];
  const styleId = styleEl ? docxWAttr(styleEl, 'val') : '';
  const html = docxRuns(p, imgMap).trim();
  if (!html) return null;
  const level = headingMap[styleId] || 0;
  if (level) {
    const tag = level <= 3 ? level : 3;
    return { html: '<h' + tag + '>' + html + '</h' + tag + '>', level: level };
  }
  // Word 自动编号只用来补符号：正文自带「4.1」「(1)」的，再加符号就成了双编号
  const text = htmlToText(html).trim();
  const selfNumbered = /^\s*([0-9]+([.．][0-9]+)*[.．、)]|[（(][0-9一二三四五六七八九十]+[)）]|[一二三四五六七八九十]+[、.])/.test(text);
  const numbered = !!(pPr && docxKids(pPr, 'numPr').length);
  return { html: '<p>' + (numbered && !selfNumbered ? '• ' : '') + html + '</p>', level: 0 };
}

function docxCellBlocks(tc, imgMap, headingMap) {
  const out = [];
  for (const c of [...tc.children]) {
    if (c.localName === 'p') {
      const b = docxParaBlock(c, imgMap, headingMap);
      if (b) out.push(b);
    } else if (c.localName === 'tbl') {
      out.push(...docxTableBlocks(c, imgMap, headingMap));
    } else if (c.localName === 'sdt' || c.localName === 'sdtContent' || c.localName === 'customXml') {
      out.push(...docxCellBlocks(c, imgMap, headingMap));
    }
  }
  return out;
}

// 数据表（≤4 列、每格都有内容）保留表格；版式表格（表单/边框排版）拍平成段落流——
// 手机上把「一个格子一个字」的表硬渲染成表格，是没法读的（2026-10-29 用真实控制程序验证）
function docxTableBlocks(tbl, imgMap, headingMap) {
  const rows = docxKids(tbl, 'tr').map((tr) => docxKids(tr, 'tc'));
  const cells = rows.flat();
  if (!cells.length) return [];
  const cols = Math.max(...rows.map((r) => r.length));
  const allFilled = cells.every((tc) => docxRuns(tc, imgMap).trim().length > 0);
  if (rows.length >= 2 && cols >= 2 && cols <= 4 && allFilled) {
    const body = rows.map((r) => '<tr>' + r.map((tc) => {
      const inner = docxCellBlocks(tc, imgMap, headingMap).map((b) => b.html).join('<br>');
      return '<td>' + inner + '</td>';
    }).join('') + '</tr>').join('');
    return [{ html: '<table>' + body + '</table>', level: 0 }];
  }
  return cells.flatMap((tc) => docxCellBlocks(tc, imgMap, headingMap));
}

async function parseDocx(zip) {
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('不是标准 DOCX（缺 word/document.xml）');
  const headingMap = await docxHeadingMap(zip);
  const imgMap = await docxRels(zip);
  const dom = new DOMParser().parseFromString(await docFile.async('string'), 'application/xml');
  const bodyEl = dom.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!bodyEl) throw new Error('DOCX 里没有正文');

  const chapters = [];
  let cur = { title: '', blocks: [] };
  const flush = () => {
    const html = cur.blocks.join('\n');
    const text = htmlToText(html);
    if (text.trim() || /<img/.test(html)) {
      chapters.push({ title: cur.title || ('第 ' + (chapters.length + 1) + ' 节'), text: text, html: html, blocks: cur.blocks.slice() });
    }
    cur = { title: '', blocks: [] };
  };
  const emit = (b, top) => {
    if (b.level && top) {          // 只让「顶层」标题切章：表内标题常被滥用（正文也用 heading 样式），切开就是碎片
      flush();
      cur.title = htmlToText(b.html).replace(/\s+/g, ' ').trim().slice(0, 40);
    }
    cur.blocks.push(b.html);
  };
  const walkTop = (container) => {
    for (const el of [...container.children]) {
      const ln = el.localName;
      if (ln === 'p') { const b = docxParaBlock(el, imgMap, headingMap); if (b) emit(b, true); }
      else if (ln === 'tbl') docxTableBlocks(el, imgMap, headingMap).forEach((b) => emit(b, false));
      else if (ln === 'sdt' || ln === 'sdtContent' || ln === 'customXml') walkTop(el);
    }
  };
  walkTop(bodyEl);
  flush();
  // 整篇没有可切章的标题（表单型文档常见）→ 按长度切，别让一章拖到 6 万字
  return chapters.length === 1 ? splitBySize(chapters[0], 12000) : chapters;
}

function splitBySize(ch, limit) {
  if (!ch.blocks || ch.text.length <= limit) return [{ title: ch.title, text: ch.text, html: ch.html }];
  const groups = [];
  let group = [];
  let len = 0;
  for (const b of ch.blocks) {
    const bl = htmlToText(b).length;
    if (len + bl > limit && group.length) { groups.push(group); group = []; len = 0; }
    group.push(b);
    len += bl;
  }
  if (group.length) groups.push(group);
  return groups.map((g, i) => {
    const html = g.join('\n');
    return { title: '第 ' + (i + 1) + ' 节', text: htmlToText(html), html: html };
  });
}

// 「字体没嵌入 + 中文 CID 编码」这两条凑齐时，浏览器没有字形可画 → 整块中文空白
// （2026-10-29 用户的全电发票：SimSun/KaiTi 全未嵌入、UniGB-UCS2-H、连 ToUnicode 都没有）
function pdfFontRisk(buf) {
  try {
    const s = new TextDecoder('latin1').decode(new Uint8Array(buf));
    if (/\/FontFile[23]?/.test(s)) return false;                 // 有嵌入字体 → 能画
    const cjk = /UniGB|UniCNS|UniJIS|UniKS|GBK-EUC|B5pc|KSCms-UHC/.test(s);
    const type0 = /\/Subtype\s*\/Type0/.test(s) || /CIDFontType2/.test(s);
    return cjk && type0;
  } catch { return false; }
}

// ── E：缺字体 PDF 的文字重建 ─────────────────────────────
// 有些 PDF 把文字直接写成 UTF-16BE（UniGB-UCS2-H 这类中文 CID 编码），但字体没嵌入：
// pdf.js 既画不出字形，也取不到文字（getTextContent 里中文是空串）。
// 这里自己解压内容流、按文本操作符还原成「行」，做成可读的文字视图（能读/能选中/能存卡）。
// 只处理顶层 stream + 常见文本操作符，够对付发票、公文这类文件；不追求版式。

async function inflateBytes(u8) {
  if (typeof DecompressionStream === 'undefined') return null;
  // endstream 前面常带换行符，留着会让解压直接失败
  let end = u8.length;
  while (end > 0 && (u8[end - 1] === 10 || u8[end - 1] === 13 || u8[end - 1] === 9 || u8[end - 1] === 32)) end--;
  const body = u8.subarray(0, end);
  for (const fmt of (body[0] === 0x78 ? ['deflate', 'deflate-raw'] : ['deflate-raw', 'deflate'])) {
    try {
      const stream = new Blob([body]).stream().pipeThrough(new DecompressionStream(fmt));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch { /* 换一种格式再试 */ }
  }
  return null;
}

// 在原始字节里切出每个 "stream … endstream"（latin1 视角下 PDF 结构是纯 ASCII）
function pdfRawStreams(bytes) {
  const s = new TextDecoder('latin1').decode(bytes);
  const out = [];
  let pos = 0;
  while (pos < s.length) {
    const end = s.indexOf('endstream', pos);
    if (end < 0) break;
    const st = s.lastIndexOf('stream', end);
    if (st < 0) break;
    let start = st + 6;
    if (s[start] === '\r') start++;
    if (s[start] === '\n') start++;
    if (start < end) out.push(bytes.subarray(start, end));
    pos = end + 9;
  }
  return out;
}

function decodeUtf16be(u8) {
  let s = '';
  for (let i = 0; i + 1 < u8.length; i += 2) s += String.fromCharCode((u8[i] << 8) | u8[i + 1]);
  return s;
}

// 一段字节到底是 UTF-16BE 还是 GBK？用「可读字符得多少分」投票，别猜编码
function textScore(s) {
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) score += 3;
    else if (c >= 0x20 && c < 0x7f) score += 1;
    else if (ch === '�') score -= 6;
    else if (c < 0x20) score -= 3;
    else score += 0.5;
  }
  return score;
}

function bestDecode(u8) {
  if (!u8 || !u8.length) return '';
  const cands = [];
  if (u8.length % 2 === 0) cands.push(decodeUtf16be(u8));
  try { cands.push(new TextDecoder('gb18030').decode(u8)); } catch { /* 老浏览器 */ }
  cands.push(new TextDecoder('latin1').decode(u8));
  let best = '';
  let bestScore = -Infinity;
  for (const s of cands) {
    const sc = textScore(s);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  return best;
}

// PDF 内容流 → 行数组（按 y 变化断行，按 x 间隙决定要不要补空格）
function pdfContentLines(src) {
  const lines = [];
  let cur = '';
  let x = 0;
  let y = 0;
  let curY = null;
  let fontSize = 12;
  let lastEndX = null;
  const stack = [];

  const estWidth = (t, fs) => {
    let w = 0;
    for (const ch of t) w += ch.codePointAt(0) > 0x2e80 ? fs : fs * 0.52;
    return w;
  };
  const flush = () => {
    const t = cur.replace(/[ \t]+/g, ' ').trim();
    if (t) lines.push(t);
    cur = '';
    lastEndX = null;
  };
  const maybeBreak = () => {
    if (curY === null) { curY = y; return; }
    if (Math.abs(y - curY) > Math.max(1.5, fontSize * 0.5)) { flush(); curY = y; }
  };
  const show = (u8) => {
    const t = bestDecode(u8);
    if (!t) return;
    if (lastEndX !== null && x - lastEndX > Math.max(1.2, fontSize * 0.28)) cur += ' ';
    cur += t;
    lastEndX = x + estWidth(t, fontSize);
    x = lastEndX;
  };
  const nums = () => stack.splice(0, stack.length).filter((a) => a.t === 'num').map((a) => a.v);

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '%') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') { i++; continue; }

    if (ch === '(') {
      const out = [];
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        const c = src[j];
        if (c === '\\') {
          const nx = src[j + 1];
          if (nx === 'n') out.push(10);
          else if (nx === 'r') out.push(13);
          else if (nx === 't') out.push(9);
          else if (nx === '(' || nx === ')' || nx === '\\') out.push(nx.charCodeAt(0));
          else if (nx >= '0' && nx <= '7') {
            let oct = nx;
            let k = j + 2;
            while (k < n && oct.length < 3 && src[k] >= '0' && src[k] <= '7') { oct += src[k]; k++; }
            out.push(parseInt(oct, 8) & 0xff);
            j = k - 2;
          } else out.push(nx ? nx.charCodeAt(0) : 0);
          j += 2;
          continue;
        }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (!depth) break; }
        out.push(c.charCodeAt(0) & 0xff);
        j++;
      }
      stack.push({ t: 'str', v: new Uint8Array(out) });
      i = j + 1;
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') { i += 2; continue; }
    if (ch === '>' && src[i + 1] === '>') { i += 2; continue; }
    if (ch === '<') {
      const end = src.indexOf('>', i);
      if (end < 0) break;
      const hex = src.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      const b = new Uint8Array(hex.length >> 1);
      for (let k = 0; k < b.length; k++) b[k] = parseInt(hex.substr(k * 2, 2), 16);
      stack.push({ t: 'str', v: b });
      i = end + 1;
      continue;
    }
    if (ch === '[') { stack.push({ t: 'arr', v: [] }); i++; continue; }
    if (ch === ']') {
      const items = [];
      while (stack.length && stack[stack.length - 1].t !== 'arr') items.unshift(stack.pop());
      if (stack.length) stack.pop();
      stack.push({ t: 'arr', v: items });
      i++;
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/[\s\/\[\]<>()%{}]/.test(src[j])) j++;
      stack.push({ t: 'name', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[0-9+\-.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9+\-.]/.test(src[j])) j++;
      const v = parseFloat(src.slice(i, j));
      stack.push({ t: 'num', v: isFinite(v) ? v : 0 });
      i = j;
      continue;
    }

    let j = i;
    while (j < n && /[A-Za-z'"*]/.test(src[j])) j++;
    if (j === i) { i++; continue; }
    const op = src.slice(i, j);
    i = j;

    if (op === 'BT') { x = 0; y = 0; curY = null; flush(); }
    else if (op === 'Tf') {
      const a = nums();
      const size = a.length ? Math.abs(a[a.length - 1]) : 0;
      if (size > 0) fontSize = size;
    } else if (op === 'Td' || op === 'TD') {
      const a = nums();
      x += a[0] || 0;
      y += a[1] || 0;
      maybeBreak();
    } else if (op === 'Tm') {
      const a = nums();
      x = a[4] || 0;
      y = a[5] || 0;
      maybeBreak();
    } else if (op === 'T*') {
      flush();
      curY = null;
    } else if (op === 'Tj' || op === "'" || op === '"') {
      if (op !== 'Tj') { flush(); curY = null; }
      const args = stack.splice(0, stack.length);
      const s = args.filter((a) => a.t === 'str').pop();
      if (s) show(s.v);
    } else if (op === 'TJ') {
      const args = stack.splice(0, stack.length);
      const arr = args.filter((a) => a.t === 'arr').pop();
      if (arr) {
        for (const item of arr.v) {
          if (item.t === 'str') show(item.v);
          else if (item.t === 'num' && item.v < -180) { if (cur && !cur.endsWith(' ')) cur += ' '; }
        }
      }
    } else {
      stack.length = 0;
    }
  }
  flush();
  return lines;
}

async function extractPdfText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length > 60 * 1024 * 1024) return [];       // 太大会卡，直接放弃
  const out = [];
  for (const raw of pdfRawStreams(bytes)) {
    let src = null;
    const inflated = await inflateBytes(raw);
    if (inflated) src = new TextDecoder('latin1').decode(inflated);
    else src = new TextDecoder('latin1').decode(raw);
    if (src.indexOf('BT') < 0) continue;                // 不是内容流（图片/字体/元数据）
    const lines = pdfContentLines(src);
    // 图像等二进制里也偶有 "BT"：解出来的行如果几乎不可读，就当噪声丢掉
    // 过滤：乱码（CJK 扩展区 A 多半是解错了编码）和几乎不可读的行
    const good = lines.filter((l) => {
      if (textScore(l) <= l.length * 0.6) return false;
      let weird = 0;
      for (const ch of l) { const c = ch.codePointAt(0); if (c >= 0x3400 && c <= 0x4dbf) weird++; }
      return weird * 2 <= l.length;
    });
    if (good.length) out.push(...good);
  }
  return mergeFragments(out);
}

// 印章/日期/金额这类文字在原文件里是一个字一个定位，按 y 解出来就成了「一列单字」。
// 连着几个短行就拼回一行，读起来才像话（宁可挤，也不能一个字一行占满屏幕）。
function mergeFragments(lines) {
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  for (const line of lines) {
    if (line.length <= 2) {                    // 只有「单字/两字」这种碎片才拼
      if (buf.length + line.length > 16) flush();
      buf += line;
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

async function openPdfFile(f) {
  view.innerHTML = '<div class="empty">正在打开 PDF…</div>';
  try {
    await ensurePdfJs();
    resetBook();
    const buf = await f.arrayBuffer();
    RDR.fontRisk = pdfFontRisk(buf);
    RDR.srcUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    RDR.textLines = [];
    RDR.textMode = false;
    if (RDR.fontRisk) {
      // 字体没嵌入时 pdf.js 取不到字，但我们能从内容流里自己解（见 extractPdfText）
      try { RDR.textLines = await extractPdfText(buf); } catch { RDR.textLines = []; }
      RDR.textMode = RDR.textLines.length > 0;
    }
    // cMaps + 标准字体必须给：中文/日文 PDF 常用 CID 字体（GBK-EUC-H / Identity-H），
    // 没有 cMaps 时这类字体整块渲染成空白——2026-10-29 用户报「发票有的字不显示」。
    RDR.pdf = await pdfjsLib.getDocument({
      data: buf,
      cMapUrl: 'vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'vendor/standard_fonts/',
    }).promise;
    RDR.total = RDR.pdf.numPages;
    RDR.page = 1;
    RDR.name = f.name;
    RDR.scale = 1;
    RDR.key = docKey(f);
    applyReadPos();
    renderReader();
  } catch (err) {
    view.innerHTML = '<div class="empty">打不开这个 PDF<br><span class="sub">' + esc(err.message) + '</span></div>';
  }
}

// 文字视图：字体缺失时把内容流里解出来的文字排成可读的一段段
function renderPdfText() {
  const lines = RDR.textLines || [];
  view.innerHTML =
    '<div class="meta"><span>' + esc(RDR.name) + '</span><span>文字视图</span></div>'
    + '<div class="notice" id="pdfFontWarn">这份 PDF 的字体没嵌入，原样渲染是空白。下面是直接从文件里解出来的文字：'
    + '能读、能选中、能存卡，但版式（表格线、盖章位置）会丢。'
    + '<div class="row" style="margin-top:8px">'
    + '<button class="btn ghost" id="showCanvas" style="padding:7px 10px;font-size:13px">看原图</button>'
    + '<button class="btn ghost" id="openSys" style="padding:7px 10px;font-size:13px">用系统阅读器打开</button>'
    + '</div></div>'
    + '<div class="bookText plain" id="pdfTextBox">' + lines.map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>'
    + '<div class="row" style="margin-top:4px"><button class="btn ghost" id="closePdf">关闭这份 PDF</button></div>';
  document.getElementById('showCanvas').onclick = () => { RDR.textMode = false; renderReader(); };
  document.getElementById('closePdf').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  const sys = document.getElementById('openSys');
  if (sys) sys.onclick = () => openWithSystemReader();
  view.scrollTop = 0;
}

function openWithSystemReader() {
  if (!RDR.srcUrl) return;
  const a = document.createElement('a');
  a.href = RDR.srcUrl;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function renderReader() {
  if (RDR.kind === 'epub' || RDR.kind === 'text' || RDR.kind === 'md' || RDR.kind === 'docx') return renderTextBook();
  if (RDR.textMode && RDR.textLines && RDR.textLines.length) return renderPdfText();
  if (!RDR.pdf && !RDR.book) {
    view.innerHTML = '<div class="empty">选一本书，直接在页面里读。<br>'
      + '<span class="sub">选中任意文字 → 朗读 / 存卡 / 问 AI。文件不上传，全在本机解析。</span>'
      + '<div class="row" style="margin-top:16px"><button class="btn primary" id="pickPdf">选择文件</button></div>'
      + '<div class="sub" style="margin-top:10px">支持 PDF · EPUB · DOCX · TXT · Markdown</div></div>'
      + '<input type="file" id="pdfFile" accept=".pdf,.epub,.docx,.txt,.md,application/pdf,application/epub+zip,'
      + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" style="display:none">';
    document.getElementById('pickPdf').onclick = () => document.getElementById('pdfFile').click();
    document.getElementById('pdfFile').onchange = openBookFile;
    return;
  }
  view.innerHTML =
    '<div class="meta"><span>' + esc(RDR.name) + '</span><span id="pgLabel">' + RDR.page + ' / ' + RDR.total + '</span></div>'
    + (RDR.fontRisk ? '<div class="notice" id="pdfFontWarn">这份 PDF 没嵌入字体，浏览器画不出其中一些字。'
      + '可改用手机自带的阅读器打开（能正常显示，但不能取词）。'
      + '<div class="row" style="margin-top:8px"><button class="btn ghost" id="openSys" style="padding:7px 10px;font-size:13px">用系统阅读器打开</button>'
      + '<button class="btn ghost" id="dismissWarn" style="padding:7px 10px;font-size:13px">知道了</button></div></div>' : '')
    + '<div id="readerWrap"><canvas id="pdfCanvas"></canvas><div class="textLayer" id="textLayer"></div></div>'
    + '<div class="pager">'
    + '<button id="prevPage">◀</button><button id="zoomOut">－</button><button id="zoomIn">＋</button><button id="nextPage">▶</button>'
    + '</div>'
    + '<div class="row" style="margin-top:4px">'
    + (RDR.textLines && RDR.textLines.length ? '<button class="btn ghost" id="showText">文字视图</button>' : '')
    + '<button class="btn ghost" id="closePdf">关闭这份 PDF</button></div>';
  const st = document.getElementById('showText');
  if (st) st.onclick = () => { RDR.textMode = true; renderReader(); };
  document.getElementById('prevPage').onclick = () => gotoPage(RDR.page - 1);
  document.getElementById('nextPage').onclick = () => gotoPage(RDR.page + 1);
  document.getElementById('zoomIn').onclick = () => { RDR.scale = Math.min(3, RDR.scale * 1.2); drawPage(); saveReadPos(); };
  document.getElementById('zoomOut').onclick = () => { RDR.scale = Math.max(0.5, RDR.scale / 1.2); drawPage(); saveReadPos(); };
  document.getElementById('closePdf').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  const sysBtn = document.getElementById('openSys');
  if (sysBtn) sysBtn.onclick = openWithSystemReader;
  const dis = document.getElementById('dismissWarn');
  if (dis) dis.onclick = () => { const w = document.getElementById('pdfFontWarn'); if (w) w.remove(); };
  drawPage();
}

// EPUB / MD 走「结构渲染」；TXT 走「段落 + 保留换行」
function plainToHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => '<p>' + esc(p.replace(/\n+$/, '')) + '</p>').join('');
}

function renderTextBook() {
  const b = RDR.book;
  if (!b || !b.chapters || !b.chapters.length) { resetBook(); return renderReader(); }
  RDR.ch = Math.max(0, Math.min(b.chapters.length - 1, RDR.ch));
  const ch = b.chapters[RDR.ch];
  const isHtml = !!ch.html;
  const html = isHtml ? ch.html : plainToHtml(ch.text);
  // 书里自己就带标题（<h1> 开头）时，别再叠一行同样的标题
  const ownHeading = /^\s*<h[1-4][\s>]/i.test(html);
  view.innerHTML =
    '<div class="meta"><span>' + esc(b.name) + '</span><span>' + (RDR.ch + 1) + ' / ' + b.chapters.length + '</span></div>'
    + (ownHeading ? '' : '<h2 class="chTitle">' + esc(ch.title) + '</h2>')
    + '<div class="bookText' + (isHtml ? '' : ' plain') + '" id="bookText">' + html + '</div>'
    + '<div class="pager"><button id="prevCh">◀</button><button id="nextCh">▶</button></div>'
    + '<div class="row" style="margin-top:4px"><button class="btn ghost" id="closeBook">关闭这本书</button></div>';
  // 远程图挂了就把位置收起来，别留一个破图标
  view.querySelectorAll('#bookText img').forEach((img) => img.addEventListener('error', () => img.remove()));
  document.getElementById('prevCh').onclick = () => gotoChapter(RDR.ch - 1);
  document.getElementById('nextCh').onclick = () => gotoChapter(RDR.ch + 1);
  document.getElementById('closeBook').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  view.scrollTop = 0;
}

function gotoChapter(n) {
  const b = RDR.book;
  if (!b) return;
  RDR.ch = Math.max(0, Math.min(b.chapters.length - 1, n));
  renderTextBook();
  saveReadPos();
}

function gotoPage(n) {
  if (!RDR.pdf) return;
  const p = Math.max(1, Math.min(RDR.total, n));
  if (p === RDR.page) return;
  RDR.page = p;
  drawPage();
  saveReadPos();
}

async function drawPage() {
  if (!RDR.pdf || RDR.rendering) return;
  RDR.rendering = true;
  const canvas = document.getElementById('pdfCanvas');
  const tl = document.getElementById('textLayer');
  if (!canvas || !tl) { RDR.rendering = false; return; }
  try {
    const page = await RDR.pdf.getPage(RDR.page);
    const base = page.getViewport({ scale: 1 });
    const avail = (view.clientWidth || 360) - 28;
    const scale = (avail / base.width) * RDR.scale;
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;

    tl.innerHTML = '';
    tl.style.width = vp.width + 'px';
    tl.style.height = vp.height + 'px';
    tl.style.setProperty('--scale-factor', String(vp.scale));
    const tc = await page.getTextContent();
    await pdfjsLib.renderTextLayer({
      textContentSource: tc,
      textContent: tc,
      container: tl,
      viewport: vp,
      textDivs: [],
    }).promise;
    const lb = document.getElementById('pgLabel');
    if (lb) lb.textContent = RDR.page + ' / ' + RDR.total;

    // 结构检测可能误报（字体藏在压缩对象流里）：真取到中文了就把提示撤掉
    if (RDR.fontRisk && tc.items.some((it) => /[㐀-鿿]/.test(it.str))) {
      RDR.fontRisk = false;
      const w = document.getElementById('pdfFontWarn');
      if (w) w.remove();
    }

    // 字体是异步注册的：手机上个别字（常用另一套子集字体）会晚到 → 画布上留下空白。
    // 等 document.fonts 全部就绪后补画一次当前页；每份文档只补一次。
    if (!RDR.fontFix && document.fonts && document.fonts.status === 'loading') {
      RDR.fontFix = true;
      document.fonts.ready.then(() => {
        if (RDR.pdf && document.getElementById('pdfCanvas')) drawPage();
      });
    }
  } catch (err) {
    /* 翻页过快会 abort，忽略 */
  } finally {
    RDR.rendering = false;
  }
}

// ── 选中文字 → 朗读 / 存卡 / 问 AI ────────────────────
function addCardFromSelection(text) {
  const front = String(text).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!front) return;
  if (userCards.some((c) => c.front.toLowerCase() === front.toLowerCase())) {
    toast('已经在「我的生词」里了');
    return;
  }
  const card = { id: 'mine-' + Date.now(), front: front, back: '', level: '', topic: '阅读生词' };
  userCards.unshift(card);
  saveJSON(LS.userCards, userCards);
  renderHeader();
  toast('已加入「我的生词」');
  if (settings.key) fillCardMeaning(card);
}

async function fillCardMeaning(card) {
  try {
    const res = await fetch(settings.apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.key },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: '你是英语词典，只输出 JSON。' },
          { role: 'user', content: '词或短语：' + card.front
            + '\n返回 JSON：{"back":"简体中文释义，短语给出用法","phonetic":"英式音标，短语留空","example":"一个自然例句","exampleCN":"例句中文"}' },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const d = JSON.parse(j.choices[0].message.content);
    card.back = d.back || '';
    card.hint = d.phonetic || '';
    card.example = d.example || '';
    card.exampleCN = d.exampleCN || '';
    saveJSON(LS.userCards, userCards);
    toast('释义已补上');
  } catch (err) {
    toast('释义没取到：' + err.message);
  }
}

function askFromSelection(t) {
  state.tab = 'chat';
  render();
  pushChat('user', '我读到「' + t + '」，请解释它在这里的意思、用法，并给一个例句。');
}

(function selectionTools() {
  let bar = null;
  const remove = () => { if (bar) { bar.remove(); bar = null; } };

  // 弹框默认贴在被选文字的「下方」——手机 Edge 自带的选区菜单永远浮在上方，
  // 放上方必被它盖住（2026-10-29 用户反馈）。只有下面真的没地方了才翻到上面。
  function place(rect) {
    const bw = bar.offsetWidth || 150;
    const bh = bar.offsetHeight || 40;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 20;                       // 避开选区手柄
    const roomBelow = vh - rect.bottom - gap;
    const roomAbove = rect.top - gap;
    let top = rect.bottom + gap;
    if (roomBelow < bh + 8 && roomAbove > roomBelow) top = rect.top - bh - gap;
    top = Math.max(8, Math.min(vh - bh - 10, top));
    const left = Math.max(8, Math.min(vw - bw - 8, rect.left + rect.width / 2 - bw / 2));
    bar.style.top = Math.round(top) + 'px';
    bar.style.left = Math.round(left) + 'px';
  }

  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || text.length > 300 || !sel.rangeCount) return remove();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return remove();
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'selTools';
      bar.innerHTML = '<button data-a="say">🔊</button><button data-a="card">＋卡</button><button data-a="ask">问AI</button>';
      bar.addEventListener('click', (ev) => {
        const a = ev.target.dataset && ev.target.dataset.a;
        if (!a) return;
        ev.preventDefault();
        ev.stopPropagation();
        const t = bar.dataset.text || '';
        if (a === 'say') speak(t);
        if (a === 'card') addCardFromSelection(t);
        if (a === 'ask') askFromSelection(t);
        remove();
      });
      document.body.appendChild(bar);
    }
    bar.dataset.text = text;
    place(rect);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#selTools')) remove(); });
})();

// ── 启动 ──────────────────────────────────────────────
view.addEventListener('scroll', onViewScroll, { passive: true });

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
  if (settings.syncToken) setTimeout(() => syncNow({ quiet: true }), 1500);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
