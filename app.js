// 学习机 Lite — 静态 PWA：内容来自 pack.json，进度存本地，AI 直连 OpenAI 兼容接口
'use strict';

const BUILD = '2026-10-29.23';

const LS = {
  progress: 'zenus.progress.v1',
  log: 'zenus.log.v1',
  settings: 'zenus.settings.v1',
  chat: 'zenus.chat.v1',
  known: 'zenus.known.v1',
  userCards: 'zenus.usercards.v1',
  readpos: 'zenus.readpos.v1',
  kpoints: 'zenus.kpoints.v1',
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
  searchKey: '',
  visionBase: 'https://api.siliconflow.cn/v1',
  visionModel: 'Qwen/Qwen3-VL-8B-Instruct',
  visionKey: '',
  readFont: 16,
  readLine: 1.8,
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

// 安装到主屏幕：浏览器给出提示时先接住，之后由设置页的按钮显式触发
let installEvent = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
window.addEventListener('appinstalled', () => { installEvent = null; toast('已安装到主屏幕'); });
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

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (RDR.pdf) relayoutPdf();
    else if (RDR.paged && RDR.book) {
      const ratio = RDR.pages > 1 ? (RDR.pageIdx || 0) / (RDR.pages - 1) : 0;
      layoutPages(ratio);
    }
  }, 180);
});
window.addEventListener('orientationchange', () => setTimeout(() => { if (RDR.pdf) relayoutPdf(); }, 300));


// 工具条上点了按钮就重新计时（正在缩放/翻页时不要自己收掉）
document.addEventListener('click', (e) => {
  if (RDR.toolsVisible && e.target.closest && e.target.closest('.floating')) scheduleHideTools();
});

document.querySelectorAll('.tabbar button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === state.tab);
  });
  document.body.classList.toggle('reader-mode', state.tab === 'reader');
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
    <label class="f">视觉模型 Base（用于「看图出题」，OpenAI 兼容即可）</label>
    <input class="t" id="s-vbase" value="${esc(settings.visionBase || '')}" placeholder="https://api.siliconflow.cn/v1">
    <label class="f">视觉模型名</label>
    <input class="t" id="s-vmodel" value="${esc(settings.visionModel || '')}" placeholder="Qwen/Qwen3-VL-8B-Instruct">
    <label class="f">视觉模型 Key（只存本机）</label>
    <input class="t" id="s-vkey" type="password" value="${esc(settings.visionKey || '')}" placeholder="sk-...">
    <label class="f">搜索 API Key（博查 bochaai.com，用于「找教材」全网搜；只存本机）</label>
    <input class="t" id="s-bocha" type="password" value="${esc(settings.searchKey || '')}" placeholder="sk-...">
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

    <h2>显示</h2>
    <div class="hint">加到主屏幕后是全屏运行（没有地址栏）。想让状态栏也收起来，用下面的全屏按钮。</div>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="btnInstall">安装到主屏幕</button>
      <button class="btn" id="btnFull">全屏</button>
    </div>
    <div class="hint" id="installHint"></div>

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
    settings.searchKey = ($('#s-bocha') || {}).value ? $('#s-bocha').value.trim() : settings.searchKey;
    if ($('#s-vbase')) settings.visionBase = $('#s-vbase').value.trim() || settings.visionBase;
    if ($('#s-vmodel')) settings.visionModel = $('#s-vmodel').value.trim() || settings.visionModel;
    if ($('#s-vkey')) settings.visionKey = $('#s-vkey').value.trim();
    settings.dailyNew = Math.max(0, Number($('#s-new').value) || 0);
    settings.ctxMsgs = Math.max(0, Math.min(40, Number($('#s-ctx').value) || 0));
    settings.ttsRate = Math.min(1.2, Math.max(0.5, Number($('#s-rate').value) || 0.9));
    saveJSON(LS.settings, settings);
    toast('设置已保存');
  };
  const bi = $('#btnInstall');
  const ih = $('#installHint');
  if (bi && ih) {
    const standalone = window.matchMedia('(display-mode: standalone)').matches
      || window.matchMedia('(display-mode: fullscreen)').matches
      || navigator.standalone;
    if (standalone) {
      ih.textContent = '已经在独立窗口里运行了。';
      bi.style.display = 'none';
    } else if (installEvent) {
      ih.textContent = '点上面的按钮，浏览器会弹安装确认。';
      bi.onclick = async () => {
        const ev = installEvent;
        installEvent = null;
        ev.prompt();
        const r = await ev.userChoice;
        ih.textContent = r && r.outcome === 'accepted' ? '装好了，回桌面找「学习机」图标。' : '取消了安装。';
      };
    } else {
      bi.onclick = () => {
        ih.textContent = 'Edge：右下角「…」→ 添加到手机 → 安装。Chrome：右上角「⋮」→ 添加到主屏幕。';
      };
    }
  }
  const bf = $('#btnFull');
  if (bf) bf.onclick = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (err) { toast('这个浏览器不支持全屏：' + err.message); }
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
  kind: null, book: null, ch: 0, urls: [], assets: {}, toolsVisible: false,
  paged: true, pageIdx: 0, pages: 1, pdfScroll: false, spread: false, outline: null,
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
  if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) return openImageFile(f);
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
    x = x.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)[^)]*\)/g,
      '<img src="$2" alt="$1" referrerpolicy="no-referrer" loading="lazy">');
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
    RDR.ch = firstReadableChapter(chapters);
    const ratio = applyReadPos();
    renderReader();
    if (ratio) requestAnimationFrame(() => scrollToRatio(ratio));
  } catch (err) {
    view.innerHTML = '<div class="empty">打不开这个 EPUB<br><span class="sub">' + esc(err.message) + '</span></div>';
  }
}

// 换书 / 关书：把上一本生成的图片 blob URL 释放掉，否则内存只涨不落
// 打开时跳到第一段有正文的章（封面/扉页只有图，停在上面像打不开）
function firstReadableChapter(chapters) {
  for (let i = 0; i < chapters.length; i++) {
    if ((chapters[i].text || '').trim().length > 50) return i;
  }
  return 0;
}

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
  RDR.outline = null;
  RDR.key = null;
  if (RDR.scrollIO) { try { RDR.scrollIO.disconnect(); } catch { /* 已断开 */ } RDR.scrollIO = null; }
  if (view) { view.onscroll = null; view.scrollTop = 0; }
  RDR.kpCache = {};
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
    if (RDR.paged) {
      r.ratio = RDR.pages > 1 ? (RDR.pageIdx || 0) / (RDR.pages - 1) : 0;
    } else {
      const max = Math.max(1, view.scrollHeight - view.clientHeight);
      r.ratio = Math.max(0, Math.min(1, view.scrollTop / max));
    }
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
    RDR.pendingRatio = r.ratio || 0;
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
    RDR.ch = firstReadableChapter(chapters);
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

// ── A：翻页手势（左右点击 / 横滑翻页，中间点击呼出工具条）────────
// 只在「没选中文字、没点在按钮上」时生效，免得和取词、点按钮打架。
const FLIP_HINT = 'zenus.tip.flip';

function bindFlipGestures(container, handlers) {
  RDR.handle = handlers;                     // 每次渲染只换处理函数，监听器永远只绑一次
  if (container.dataset.flipBound) return;   // 否则一次点击会把整章/整页翻好几次
  container.dataset.flipBound = '1';
  let sx = 0, sy = 0, st = 0, down = false;
  const isInteractive = (target) => !!(target && target.closest
    && target.closest('button, a, input, select, textarea, #selTools'));

  const onDown = (x, y) => { sx = x; sy = y; st = Date.now(); down = true; };
  const onUp = (x, y, target) => {
    if (!down) return;
    down = false;
    const h = RDR.handle;                    // 用当前这次渲染的处理函数
    if (!h) return;
    if (Date.now() - st > 700) return;                       // 长按（选字）不翻页
    if (isInteractive(target)) return;
    const sel = window.getSelection();
    if (sel && String(sel).trim()) return;                    // 有选区 → 这是取词，不翻页
    const dx = x - sx;
    const dy = y - sy;

    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {   // 横滑
      if (dx < 0) h.next(); else h.prev();
      return;
    }
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {                   // 轻点
      const x0 = sx + dx;
      const x = x0 / window.innerWidth;
      if (x < 0.28) h.prev();
      else if (x > 0.72) h.next();
      else h.middle();
    }
  };

  // 触屏：pointer 事件在可滚动容器里会被浏览器 cancel 掉（横滑永远判不出来），改用 touch
  if ('ontouchstart' in window) {
    container.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { down = false; return; }
      onDown(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    container.addEventListener('touchend', (e) => {
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) { down = false; return; }
      onUp(t.clientX, t.clientY, e.target);
    }, { passive: true });
    container.addEventListener('touchcancel', () => { down = false; }, { passive: true });
  } else {
    container.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      onDown(e.clientX, e.clientY);
    }, { passive: true });
    container.addEventListener('pointerup', (e) => onUp(e.clientX, e.clientY, e.target), { passive: true });
    container.addEventListener('pointercancel', () => { down = false; }, { passive: true });
  }
}

function flipHintOnce() {
  if (loadJSON(FLIP_HINT, false)) return;
  saveJSON(FLIP_HINT, true);
  toast('点屏幕左右两边翻页，点中间显示工具条');
}

let toolsTimer = null;
function syncTools() {
  document.querySelectorAll('.floating').forEach((el) => el.classList.toggle('show', !!RDR.toolsVisible));
}
function hideTools() {
  RDR.toolsVisible = false;
  syncTools();
  clearTimeout(toolsTimer);
}
function scheduleHideTools() {
  clearTimeout(toolsTimer);
  toolsTimer = setTimeout(hideTools, 3500);      // 弹出来不点就自己收，别赖在屏幕上
}
function toggleTools() {
  RDR.toolsVisible = !RDR.toolsVisible;
  syncTools();
  if (RDR.toolsVisible) scheduleHideTools();
  else clearTimeout(toolsTimer);
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
  bindFlipGestures(view, {
    prev: () => { const r = RDR.pdf; if (r && RDR.page > 1) gotoPage(RDR.page - 1); },
    next: () => { if (RDR.pdf) gotoPage(RDR.page + 1); },
    middle: toggleTools,
  });
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
  if (RDR.kind === 'image') return renderImage();
  if (RDR.kind === 'epub' || RDR.kind === 'text' || RDR.kind === 'md' || RDR.kind === 'docx') return renderTextBook();
  if (RDR.textMode && RDR.textLines && RDR.textLines.length) return renderPdfText();
  if (RDR.pdf && RDR.pdfScroll) return renderPdfScroll();
  if (!RDR.pdf && !RDR.book) {
    view.innerHTML = '<div class="empty">选一本书，直接在页面里读。<br>'
      + '<span class="sub">选中任意文字 → 朗读 / 存卡 / 问 AI。文件不上传，全在本机解析。</span>'
      + '<div class="row" style="margin-top:16px"><button class="btn primary" id="pickPdf">选择文件</button></div>'
      + '<div class="row" style="margin-top:8px"><button class="btn" id="findBooks">找教材</button></div>'
      + '<div class="sub" style="margin-top:10px">支持 PDF · EPUB · DOCX · TXT · Markdown · 图片</div></div>'
      + '<input type="file" id="pdfFile" accept=".pdf,.epub,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,image/*,application/pdf,application/epub+zip,'
      + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" style="display:none">';
    document.getElementById('pickPdf').onclick = () => document.getElementById('pdfFile').click();
    document.getElementById('findBooks').onclick = () => renderFind();
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
    + '<div class="floating pager' + (RDR.toolsVisible ? ' show' : '') + '" id="pdfTools">'
    + '<button id="prevPage">◀</button><button id="zoomOut">－</button><button id="zoomIn">＋</button><button id="nextPage">▶</button>'
    + '<button id="tocBtn" class="t-close">目录</button>'
    + '<button id="spreadBtn" class="t-close">' + (RDR.spread ? '单页' : '双页') + '</button>'
    + '<button id="ocrBtn" class="t-close">识别文字</button>'
    + '<button id="kpBtn" class="t-close">知识点</button>'
    + '<button id="vizBtn" class="t-close">看图出题</button>'
    + '<button id="toggleScroll" class="t-close">滚动</button>'
    + '<button id="closePdf" class="t-close">关闭</button>'
    + (RDR.textLines && RDR.textLines.length ? '<button id="showText" class="t-close">文字视图</button>' : '')
    + '</div>';
  const st = document.getElementById('showText');
  if (st) st.onclick = () => { RDR.textMode = true; renderReader(); };
  document.getElementById('prevPage').onclick = () => gotoPage(RDR.page - 1);
  document.getElementById('nextPage').onclick = () => gotoPage(RDR.page + 1);
  document.getElementById('zoomIn').onclick = () => { RDR.scale = Math.min(3, RDR.scale * 1.2); drawPage(); saveReadPos(); };
  document.getElementById('zoomOut').onclick = () => { RDR.scale = Math.max(0.5, RDR.scale / 1.2); drawPage(); saveReadPos(); };
  document.getElementById('closePdf').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  const sysBtn = document.getElementById('openSys');
  if (sysBtn) sysBtn.onclick = openWithSystemReader;
  const ocrb = document.getElementById('ocrBtn');
  if (ocrb) ocrb.onclick = () => { hideTools(); ocrCurrentPage(); };
  const ts = document.getElementById('toggleScroll');
  if (ts) ts.onclick = () => { RDR.pdfScroll = true; renderReader(); };
  const tb = document.getElementById('tocBtn');
  if (tb) tb.onclick = () => showOutline();
  const sb = document.getElementById('spreadBtn');
  if (sb) sb.onclick = toggleSpread;
  const kpb2 = document.getElementById('kpBtn');
  if (kpb2) kpb2.onclick = () => { hideTools(); showPoints(); };
  const viz = document.getElementById('vizBtn');
  if (viz) viz.onclick = () => { hideTools(); visionFromPdfPage(); };
  const dis = document.getElementById('dismissWarn');
  if (dis) dis.onclick = () => { const w = document.getElementById('pdfFontWarn'); if (w) w.remove(); };
  drawPage();
  bindFlipGestures(view, {
    prev: () => gotoPage(RDR.page - 1),
    next: () => gotoPage(RDR.page + 1),
    middle: toggleTools,
  });
  flipHintOnce();
}

// EPUB / MD 走「结构渲染」；TXT 走「段落 + 保留换行」
function plainToHtml(text) {
  return String(text || '').split(/\n{2,}/).map((p) => '<p>' + esc(p.replace(/\n+$/, '')) + '</p>').join('');
}

// ── F：扫描件 OCR（Tesseract.js，全部自托管，离线可用）──────────
// 只认「画面上有字但没有文字层」的 PDF（扫描件）。字体没嵌入那种画面本来就是空白，
// OCR 也认不出东西——那种走文字重建（extractPdfText）。

let ocrBusy = false;

async function ensureTesseract() {
  await ensureLib('vendor/ocr/tesseract.min.js', 'Tesseract');
  return window.Tesseract;
}

function ocrStatus(text) {
  let el = document.getElementById('ocrStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ocrStatus';
    el.className = 'notice';
    el.style.marginTop = '10px';
    const wrap = document.getElementById('readerWrap');
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(el, wrap.nextSibling);
    else return;
  }
  el.textContent = text;
}

async function ocrCurrentPage() {
  if (ocrBusy) return;
  const canvas = document.getElementById('pdfCanvas');
  if (!canvas || !canvas.width) return toast('先把这一页渲染出来');
  ocrBusy = true;
  try {
    ocrStatus('正在准备识别引擎（首次约 9MB，之后走缓存）…');
    const T = await ensureTesseract();
    const worker = await T.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: 'vendor/ocr/worker.min.js',
      corePath: 'vendor/ocr/tesseract-core-simd-lstm.wasm.js',
      langPath: 'vendor/ocr/',
      logger: (m) => {
        if (m.status === 'recognizing text') ocrStatus('识别中… ' + Math.round((m.progress || 0) * 100) + '%');
        else if (m.status) ocrStatus(m.status + '…');
      },
    });
    try {
      ocrStatus('渲染高清页…');
      // 屏幕上的画布只有 ~700px 宽，认字太糊；单独渲染一张 ~1800px 的给 OCR
      const page = await RDR.pdf.getPage(RDR.page);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.max(1.5, Math.min(4, 1800 / base.width));
      const vp = page.getViewport({ scale: scale });
      const hi = document.createElement('canvas');
      hi.width = Math.floor(vp.width);
      hi.height = Math.floor(vp.height);
      await page.render({ canvasContext: hi.getContext('2d'), viewport: vp }).promise;
      ocrStatus('识别中…');
      const { data } = await worker.recognize(hi);
      const lines = String(data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) throw new Error('这一页没认出文字');
      RDR.textLines = lines;
      RDR.textMode = true;
      const st = document.getElementById('ocrStatus');
      if (st) st.remove();
      renderReader();
      toast('识别完成：' + lines.length + ' 行');
    } finally {
      try { await worker.terminate(); } catch { /* 已结束 */ }
    }
  } catch (err) {
    ocrStatus('识别失败：' + err.message);
    toast('OCR 失败：' + err.message);
  } finally {
    ocrBusy = false;
  }
}

// ── 抓正文：多通道逐级降级 ────────────────────────────────
// 浏览器能不能读到跨域正文，取决于对方有没有开 CORS（跟翻不翻墙是两回事）。
// 所以按「最可能成功」的顺序挨个试，并在界面上标出这条材料是走哪条通道拿到的：
//   ① 维基类 → 官方 API 加 origin=*（维基显式允许跨域）
//   ② jina 阅读代理 → 把任意网页转成 markdown，响应放开了 CORS
//   ③ 直连 → GitHub raw、RFC、博查这类本身开了 CORS 的站
// 全失败就返回 null：那条材料只能当「仅摘要」，不许冒充正文。

const FULLTEXT_MIN = 400;      // 少于这个字数当没抓到

function wikiApiUrl(url) {
  try {
    const u = new URL(url);
    const m = /^\/wiki\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    const title = decodeURIComponent(m[1]);
    const host = u.hostname;
    if (/wikipedia\.org$/.test(host)) {
      return host.replace(/^[a-z-]+\./, 'zh.') === host
        ? 'https://' + host + '/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&origin=*&titles=' + encodeURIComponent(title)
        : null;
    }
    if (/wikisource\.org$/.test(host)) {
      return 'https://' + host + '/w/api.php?action=parse&prop=text&format=json&origin=*&page=' + encodeURIComponent(title);
    }
  } catch { /* 不是合法 URL */ }
  return null;
}

function absolutize(src, base) {
  try { return new URL(src, base).href; } catch { return ''; }
}

function htmlToReadableText(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,nav,header,footer,aside,form,iframe,noscript,svg').forEach((n) => n.remove());
  // 图片：换成 markdown 占位，不然"思维导图"这类材料抓完只剩空壳
  doc.querySelectorAll('img').forEach((img) => {
    const raw = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    const abs = raw ? absolutize(raw, baseUrl || doc.baseURI) : '';
    const holder = doc.createElement('span');
    holder.textContent = abs && /^https?:/i.test(abs) ? String.fromCharCode(10, 10) + '![](' + abs + ')' + String.fromCharCode(10, 10) : '';
    img.replaceWith(holder);
  });
  // 粗暴正文提取：取文字最多的那个块（比整页 innerText 干净得多）
  let best = doc.body;
  let bestLen = 0;
  doc.querySelectorAll('article, main, #content, .content, #main, .post, .article').forEach((el) => {
    const len = (el.textContent || '').length;
    if (len > bestLen) { bestLen = len; best = el; }
  });
  const text = (best ? best.textContent : doc.body ? doc.body.textContent : '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n');
  return text.trim();
}

async function fetchWindow(url, timeoutMs, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function tryWikiApi(url) {
  const api = wikiApiUrl(url);
  if (!api) return null;
  const raw = await fetchWindow(api, 12000);
  const j = JSON.parse(raw);
  if (j.query && j.query.pages) {
    const p = Object.values(j.query.pages)[0];
    if (p && p.extract && p.extract.length > FULLTEXT_MIN) return { text: p.extract, via: '维基 API' };
    return null;
  }
  if (j.parse && j.parse.text && j.parse.text['*']) {
    const t = htmlToReadableText(j.parse.text['*'], url);
    if (t.length > FULLTEXT_MIN) return { text: t, via: '维基文库 API', imgs: 0 };
  }
  return null;
}

async function tryJina(url) {
  const raw = await fetchWindow('https://r.jina.ai/' + url, 12000);
  // jina 会在开头加 Title / URL Source / Markdown Content 几行
  const t = raw.replace(/^(Title|URL Source|Published Time|Markdown Content):[^\n]*\n/gm, '').trim();
  const imgs = (t.match(/!\[[^\]]*\]\(https?:/g) || []).length;
  if (t.length > FULLTEXT_MIN || imgs >= 2) return { text: t, via: '阅读代理', imgs: imgs };
  return null;
}

async function tryDirect(url) {
  const raw = await fetchWindow(url, 9000);
  const isHtml = /<\/html>|<\/body>/i.test(raw.slice(0, 4000));
  const t = isHtml ? htmlToReadableText(raw, url) : raw.trim();
  const imgs = (t.match(/!\[[^\]]*\]\(https?:/g) || []).length;
  if (t.length > FULLTEXT_MIN || imgs >= 2) return { text: t, via: '直连', imgs: imgs };
  return null;
}

async function fetchFullText(url) {
  // 顺序讲成本：直连最快（CORS 没开就立刻失败），阅读代理最慢（要绕一圈转发）
  const channels = [
    ['维基 API', () => tryWikiApi(url)],
    ['直连', () => tryDirect(url)],
    ['阅读代理', () => tryJina(url)],
  ];
  for (const [name, run] of channels) {
    try {
      const r = await run();
      if (r) return r;
    } catch { /* 换下一条通道 */ }
  }
  return null;
}

// ── 开放书源：直接下载整本书（EPUB/TXT），而不是抓网页摘要 ──────
// 现实：中文教材/教辅的正文大多在文档站（付费墙+反爬），抓不到；
// 能拿到的是「开放书源」里现成的电子书文件。下载下来我们用解析器读，质量最高。

const FIND_SRC = { se: 'se', wikisource: 'wikisource', bocha: 'bocha' };

// ① Standard Ebooks：英文公版，CORS 开放，能直接下载 EPUB
async function searchStandardEbooks(q) {
  const html = await (await fetch('https://standardebooks.org/ebooks?query=' + encodeURIComponent(q))).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const seen = new Set();
  const out = [];
  doc.querySelectorAll('a[href^="/ebooks/"]').forEach((a) => {
    const href = a.getAttribute('href');
    const m = /^\/ebooks\/([a-z0-9-]+)\/([a-z0-9-]+)$/.exec(href);
    if (!m || seen.has(href)) return;
    seen.add(href);
    const pretty = (slug) => slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    out.push({
      name: pretty(m[2]),
      author: pretty(m[1]),
      url: 'https://standardebooks.org' + href,
      kind: 'epub',
    });
  });
  return out.slice(0, 12);
}


// ② 维基文库：中文公版（需能访问维基）。两条 API 都带 origin=* 显式允许跨域
async function searchWikisource(q) {
  const api = 'https://zh.wikisource.org/w/api.php?action=query&list=search&srlimit=10&format=json&origin=*'
    + '&srsearch=' + encodeURIComponent(q);
  const j = await (await fetch(api)).json();
  const hits = (j.query && j.query.search) || [];
  return hits.map((h) => ({ name: h.title, url: 'https://zh.wikisource.org/wiki/' + encodeURIComponent(h.title), kind: 'text' }));
}

async function wikisourceText(title) {
  const api = 'https://zh.wikisource.org/w/api.php?action=parse&prop=text&format=json&origin=*&page='
    + encodeURIComponent(title);
  const j = await (await fetch(api)).json();
  if (!j.parse || !j.parse.text) throw new Error('取不到条目正文');
  const text = htmlToReadableText(j.parse.text['*'], 'https://zh.wikisource.org/');
  if (text.length < 200) throw new Error('正文太短，可能只是目录页');
  return text;
}

// 打开下载好的 EPUB 直接进阅读器
async function importEbookFile(file) {
  hideTools();
  await openEpubBook(file);
}

// ── G：找网络教材 ────────────────────────────────────────
// 两条通道：
//   ① 开放书源白名单（公有领域/免费公开）→ 直接给搜索链接，用系统浏览器打开
//   ② 博查搜索 API（设置里填 key）→ 拿到 标题/链接/摘要，可勾选后当短文导入
// 说明：浏览器不能随便抓任意网站的正文（跨域限制），所以「导入」进去的是摘要正文，
// 或者只是链接；能抓到的站点才给全文。

const OPEN_SOURCES = [
  { name: '维基文库（中文，公有领域）', url: 'https://zh.wikisource.org/w/index.php?search={q}' },
  { name: 'Project Gutenberg（公版书）', url: 'https://www.gutenberg.org/ebooks/search/?query={q}' },
  { name: 'MIT OpenCourseWare（公开课）', url: 'https://ocw.mit.edu/search/?q={q}' },
  { name: '可汗学院（数学/科学）', url: 'https://zh.khanacademy.org/search?page_search_query={q}' },
  { name: '中国大学 MOOC', url: 'https://www.icourse163.org/search.htm?search={q}' },
  { name: 'GitHub 开源教材', url: 'https://github.com/search?q={q}&type=repositories' },
];

const FIND = { query: '', items: [], busy: false, note: '', judged: false, src: 'se' };

// 这些站的正文是 JS 动态加载的图片切片 + 付费墙（道客巴巴/豆丁/淘豆/Book118/百度文库…），
// 浏览器端抓不到，硬抓也涉及侵权 —— 在列表里直接标出来，别让用户白勾。
const DOC_SITES = /doc88|docin|taodocs|book118|jinchutou|renrendoc|360doc|wenku[.]baidu|mbalib/i;

async function bochaSearch(q) {
  const res = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.searchKey },
    body: JSON.stringify({ query: q, count: 10, summary: true }),
  });
  if (!res.ok) throw new Error('搜索 HTTP ' + res.status);
  const j = await res.json();
  const pages = (j && j.data && j.data.webPages && j.data.webPages.value) || [];
  return pages.map((p) => ({
    name: p.name || p.displayUrl || p.url,
    url: p.url,
    snippet: p.snippet || '',
    summary: p.summary || '',
  }));
}

// 让 AI 只看「标题+摘要」判一下值不值得读（不下载正文，很便宜）
async function judgeItems(items) {
  if (!settings.key || !items.length) return items;
  const brief = items.slice(0, 8).map((it, i) =>
    (i + 1) + '. 标题：' + it.name + '\n摘要：' + (it.summary || it.snippet || '').slice(0, 220)).join('\n\n');
  try {
    const res = await fetch(settings.apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.key },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: '你帮学习者挑材料，只输出 JSON。' },
          { role: 'user', content: '下面是搜索结果。逐条判断适不适合当学习材料：'
            + '能不能直接读（是不是正文而不是导航/广告/付费墙）、属于语言类还是技术类、大概难度。\n\n'
            + brief + '\n\n返回 JSON：{"items":[{"i":1,"usable":true 或 false,"kind":"language 或 tech","level":"入门/中级/进阶","why":"一句话理由"}]}' },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) return items;
    const j = await res.json();
    const d = JSON.parse(j.choices[0].message.content);
    for (const it of d.items || []) {
      const idx = (it.i || 0) - 1;
      if (items[idx]) Object.assign(items[idx], { usable: it.usable, kind: it.kind, level: it.level, why: it.why });
    }
  } catch { /* 判不了就照常列出来 */ }
  return items;
}

function renderFind() {
  const q = FIND.query;
  const srcLinks = OPEN_SOURCES.map((s) => {
    const url = s.url.replace('{q}', encodeURIComponent(q || '英语 精读'));
    return '<div class="it"><span>' + esc(s.name) + '</span>'
      + '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--acc);font-size:12px">打开</a></div>';
  }).join('');

  const items = FIND.items.map((it, i) => {
    if (FIND.src === 'se' || FIND.src === 'wikisource') {
      return '<div class="it"><div style="min-width:0"><b>' + esc(it.name) + '</b>'
        + (it.author ? ' <small class="sub">' + esc(it.author) + '</small>' : '')
        + '<div class="sub" style="margin-top:4px">' + esc(it.url.replace(/^https?:\/\//, '').slice(0, 56)) + '</div></div>'
        + '<button class="btn primary" data-get="' + i + '" style="width:auto;padding:8px 12px;font-size:13px;white-space:nowrap">'
        + (FIND.src === 'se' ? '打开书页' : '取正文并导入') + '</button></div>';
    }
    const docSite = DOC_SITES.test(it.url || '');
    if (docSite) it.usable = false;
    const label = docSite ? '🚫 文档站，抓不到正文'
      : it.usable === true ? '✅ 适合' : it.usable === false ? '⛔ 不建议' : '📄 待判';
    const meta = [it.kind === 'tech' ? '技术类' : it.kind === 'language' ? '语言类' : '', it.level || ''].filter(Boolean).join(' · ');
    return '<div class="it" style="align-items:flex-start;flex-direction:column;gap:6px">'
      + '<label style="display:flex;gap:8px;align-items:flex-start;width:100%">'
      + '<input type="checkbox" data-pick="' + i + '"' + (it.usable === false || docSite ? '' : ' checked') + ' style="margin-top:3px">'
      + '<span><b>' + esc(it.name) + '</b> <small>' + label + (meta ? ' · ' + esc(meta) : '') + '</small>'
      + '<div class="sub" style="margin-top:4px">' + esc((it.why || it.summary || it.snippet || '').slice(0, 180)) + '</div>'
      + '<a href="' + esc(it.url) + '" target="_blank" rel="noopener" style="color:var(--acc);font-size:12px">原网页</a>'
      + '</span></label></div>';
  }).join('');

  const tabBtn = (id, label) => '<button class="btn ' + (FIND.src === id ? 'primary' : 'ghost')
    + '" data-src="' + id + '" style="flex:1;padding:9px 6px;font-size:13px">' + label + '</button>';
  const srcHint = FIND.src === 'se' ? '英文公版书：这里只能搜+打开书页（站点禁止自动下载），下载后回「选择文件」导入'
    : FIND.src === 'wikisource' ? '中文公版（古籍/典籍），直接取正文导入'
    : '全网搜（博查）：多数站点抓不到正文，只作发现用';
  view.innerHTML =
    '<div class="meta"><span>找教材</span><span>' + (FIND.src === 'bocha'
      ? (settings.searchKey ? '博查已接' : '未填搜索 key') : '开放书源') + '</span></div>'
    + '<div class="row" style="margin:6px 0">' + tabBtn('se', 'Standard Ebooks')
    + tabBtn('wikisource', '维基文库') + tabBtn('bocha', '全网搜') + '</div>'
    + '<div class="hint">' + srcHint + '</div>'
    + (FIND.src === 'wikisource'
      ? '<div class="hint">中文教材/教辅的正版免费源是「国家中小学智慧教育平台」：在里面下载 PDF 后回「选择文件」导入（它需要登录，我这边不抓）。'
        + '<div class="row" style="margin:6px 0"><button class="btn ghost" id="eduOpen">打开国家中小学智慧教育平台</button></div></div>'
      : '')
    + '<div class="row" style="margin:6px 0"><input class="t" id="findQ" placeholder="想找什么？英文书名/作者，或中文典籍名" value="' + esc(q) + '">'
    + '<button class="btn primary" id="findGo" style="width:96px">搜索</button></div>'
    + (FIND.note ? '<div class="hint">' + esc(FIND.note) + '</div>' : '')
    + (FIND.busy ? '<div class="empty"><span class="spin"></span> 正在搜…</div>' : '')
    + (items ? '<h2>搜索结果</h2><div class="list">' + items + '</div>'
      + (FIND.src === 'bocha'
        ? '<div class="row" style="margin-top:10px"><button class="btn primary" id="findImport">把勾选的当短文导入</button></div>'
          + '<div class="hint">能抓到全文的才当教材；抓不到的只留链接。</div>'
        : '') : '')
    + '<h2>开放书源（公有领域 / 免费公开）</h2><div class="list">' + srcLinks + '</div>'
    + '<div class="row" style="margin-top:12px"><button class="btn ghost" id="findBack">← 回阅读</button></div>';

  document.getElementById('findBack').onclick = () => renderReader();
  const eduBtn = document.getElementById('eduOpen');
  if (eduBtn) eduBtn.onclick = () => window.open('https://basic.smartedu.cn/tchMaterial', '_blank', 'noopener');
  view.querySelectorAll('[data-src]').forEach((b) => {
    b.onclick = () => { FIND.src = b.dataset.src; FIND.items = []; FIND.note = ''; renderFind(); };
  });
  document.getElementById('findGo').onclick = async () => {
    const query = (document.getElementById('findQ').value || '').trim();
    if (!query) return toast('先写想搜什么');
    FIND.query = query;
    FIND.items = [];
    FIND.note = '';
    if (FIND.src === 'bocha' && !settings.searchKey) {
      FIND.note = '全网搜要先在设置里填博查 key；不然就用前两个开放书源。';
      return renderFind();
    }
    FIND.busy = true; renderFind();
    try {
      if (FIND.src === 'se') {
        FIND.items = await searchStandardEbooks(query);
        FIND.note = FIND.items.length ? '找到 ' + FIND.items.length + ' 本，点「打开书页」→ 在浏览器里下载 EPUB → 回来「选择文件」导入'
          : '没搜到，换个英文关键词试试';
      } else if (FIND.src === 'wikisource') {
        FIND.items = await searchWikisource(query);
        FIND.note = FIND.items.length ? '找到 ' + FIND.items.length + ' 条，点「取正文并导入」' : '没搜到（维基需要能访问 zh.wikisource.org）';
      } else {
        FIND.items = await bochaSearch(query);
        FIND.note = '找到 ' + FIND.items.length + ' 条，正在让 AI 判断哪些能用…';
        renderFind();
        FIND.items = await judgeItems(FIND.items);
        FIND.note = '判断完成。勾选要的，点下面导入（能抓到全文才当教材）。';
      }
    } catch (err) {
      FIND.note = '搜索失败：' + err.message;
    }
    FIND.busy = false;
    renderFind();
  };
  view.querySelectorAll('[data-get]').forEach((b) => {
    b.onclick = async () => {
      const it = FIND.items[Number(b.dataset.get)];
      if (!it) return;
      b.disabled = true;
      b.textContent = '处理中…';
      try {
        if (FIND.src === 'se') {
          // 站点明说「自动下载会封 IP 24 小时」→ 不代下载，打开书页让你自己点
          window.open(it.url, '_blank', 'noopener');
          b.disabled = false;
          b.textContent = '打开书页';
          FIND.note = '已用浏览器打开书页：在那儿点 EPUB 下载，下完回这里「选择文件」导入即可。';
          renderFind();
        } else {
          const text = await wikisourceText(it.name);
          importAsText([{ name: it.name, url: it.url, full: text, via: '维基文库 API' }], it.name, 1);
        }
      } catch (err) {
        b.disabled = false;
        b.textContent = FIND.src === 'se' ? '下载并导入' : '取正文并导入';
        FIND.note = '失败：' + err.message + (FIND.src === 'se' ? '（可能需要能访问 standardebooks.org）' : '（可能需要能访问 zh.wikisource.org）');
        renderFind();
      }
    };
  });
  const imp = document.getElementById('findImport');
  if (imp) imp.onclick = async () => {
    const picks = [...view.querySelectorAll('[data-pick]')].filter((c) => c.checked)
      .map((c) => FIND.items[Number(c.dataset.pick)]).filter(Boolean);
    if (!picks.length) return toast('先勾几条');
    imp.disabled = true;
    let full = 0;
    for (let i = 0; i < picks.length; i++) {
      imp.textContent = '正在抓正文 ' + (i + 1) + '/' + picks.length + '…';
      const got = await fetchFullText(picks[i].url);
      if (got) { picks[i].full = got.text; picks[i].via = got.via; full++; }
    }
    imp.disabled = false;
    importAsText(picks, FIND.query, full);
  };
}

function importAsText(items, query, fullCount) {
  const NL = String.fromCharCode(10);
  const body = items.map((it) => '## ' + it.name + NL + NL
    + (it.full
      ? it.full + NL + NL + '> 全文经「' + it.via + '」通道抓取'
      : '> ⚠️ 没抓到正文（跨域限制），下面只是搜索摘要，不要当教材。' + NL + NL
        + (it.summary || it.snippet || '（没有摘要）'))
    + NL + NL + '来源：' + it.url).join(NL + NL);
  const name = '找教材：' + (query || '未命名');
  RDR.kind = 'md';
  RDR.pdf = null;
  RDR.book = { name: name, chapters: mdChapters(body) };
  RDR.ch = 0;
  RDR.pageIdx = 0;
  RDR.key = name + '|' + body.length;
  RDR.textLines = [];
  renderReader();
  const n = fullCount == null ? items.filter((i) => i.full).length : fullCount;
  toast('导入 ' + items.length + ' 条：全文 ' + n + ' 条' + (n < items.length ? '，其余只有摘要' : ''));
}

// ── 视觉模型：真正"看懂图"（Qwen-VL / SiliconFlow，OpenAI 兼容接口）────
// OCR 只认字；几何图形、函数图像、思维导图这种要靠视觉模型。

const VISION_PROMPT = '这是一张学习材料的截图（可能是题目、教材页、图表或思维导图）。请：'
  + '① 一句话说清它讲什么；'
  + '② 提取要点——如果是几何/图表题，要说明图形与已知条件的关系，不要只抄文字；'
  + '③ 语言材料列出生词和固定搭配，理科材料列出公式/定理；'
  + '④ 出 3 道自测题（每题 4 个选项，给正确答案下标和解析）。'
  + '只输出 JSON：{"summary":"","points":[""],"words":[{"w":"","cn":"","note":""}],'
  + '"quiz":[{"q":"","options":["","","",""],"a":0,"why":""}]}';

function visionReady() {
  return !!(settings.visionKey && settings.visionBase && settings.visionModel);
}

// 从大模型返回里挖出 JSON（有些模型会包 ```json 或加前言）
function pickJson(text) {
  const t = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  const body = fence ? fence[1] : t;
  try { return JSON.parse(body); } catch { /* 再试找花括号 */ }
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(body.slice(s, e + 1)); } catch { /* 放弃 */ }
  }
  throw new Error('模型没按 JSON 回');
}

async function askVision(dataUrl) {
  const res = await fetch(settings.visionBase.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.visionKey },
    body: JSON.stringify({
      model: settings.visionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) throw new Error('视觉模型 HTTP ' + res.status);
  const j = await res.json();
  const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return pickJson(content);
}

// 把 <img> 缩到合适大小转 dataURL（太大既慢又贵）
function imageToDataUrl(img, maxW) {
  const w0 = img.naturalWidth || img.width || 800;
  const h0 = img.naturalHeight || img.height || 600;
  const scale = Math.min(1, (maxW || 1400) / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}

async function pdfPageDataUrl(n, maxW) {
  const page = await RDR.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, (maxW || 1400) / base.width);
  const vp = page.getViewport({ scale: scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  return c.toDataURL('image/jpeg', 0.85);
}

// 统一入口：dataUrl + 标题 → 走视觉模型 → 复用「知识点」面板渲染
async function showVisionPoints(dataUrl, title) {
  if (!visionReady()) {
    toast('先在设置里填视觉模型的 Key');
    state.tab = 'settings';
    return render();
  }
  const ch = { title: title || '看图', text: '' };
  renderPoints({ loading: true }, ch);
  try {
    const data = await askVision(dataUrl);
    rememberPoints(data);
    renderPoints(data, ch);
  } catch (err) {
    renderPoints({ error: err.message }, ch);
  }
}

async function visionFromImage() {
  const img = document.getElementById('imgView');
  if (!img) return;
  if (!img.complete) await new Promise((r) => { img.onload = r; });
  const url = imageToDataUrl(img, 1400);
  showVisionPoints(url, RDR.name || '看图');
}

async function visionFromPdfPage() {
  if (!RDR.pdf) return;
  toast('正在把这一页转成图片…');
  const url = await pdfPageDataUrl(RDR.page, 1400);
  showVisionPoints(url, RDR.name + ' · 第 ' + RDR.page + ' 页');
}

// ── 图片：直接看图 / OCR / 出题 ─────────────────────────
async function openImageFile(f) {
  resetBook();
  RDR.kind = 'image';
  RDR.name = f.name;
  RDR.srcUrl = URL.createObjectURL(f);
  RDR.key = docKey(f);
  RDR.textLines = [];
  RDR.page = 1;
  RDR.total = 1;
  renderReader();
}

async function ocrImage() {
  const img = document.getElementById('imgView');
  if (!img) return;
  if (!img.complete) await new Promise((r) => { img.onload = r; });
  ocrStatus('正在准备识别引擎（首次约 9MB，之后走缓存）…');
  try {
    const T = await ensureTesseract();
    const worker = await T.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: 'vendor/ocr/worker.min.js',
      corePath: 'vendor/ocr/tesseract-core-simd-lstm.wasm.js',
      langPath: 'vendor/ocr/',
      logger: (m) => { if (m.status === 'recognizing text') ocrStatus('识别中… ' + Math.round((m.progress || 0) * 100) + '%'); },
    });
    try {
      const { data } = await worker.recognize(img);
      const lines = String(data.text || '').split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
      RDR.textLines = lines;
      const st = document.getElementById('ocrStatus');
      if (st) st.remove();
      renderReader();
      toast(lines.length ? ('识别出 ' + lines.length + ' 行') : '这张图没认出文字');
    } finally { try { await worker.terminate(); } catch { /* 已结束 */ } }
  } catch (err) {
    ocrStatus('识别失败：' + err.message);
  }
}

function renderImage() {
  view.innerHTML =
    '<div class="meta"><span>' + esc(RDR.name) + '</span><span>图片</span></div>'
    + '<img id="imgView" src="' + RDR.srcUrl + '" alt="" style="max-width:100%;border-radius:8px;background:#fff">'
    + (RDR.textLines && RDR.textLines.length
      ? '<h2>识别出的文字</h2><div class="bookText plain" style="font-size:14px">'
        + RDR.textLines.map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>'
      : '<div class="hint" style="margin-top:10px">这是图片，没有文字层。点右侧「识别文字」做 OCR，之后就能取词、出知识点。</div>')
    + '<div class="floating' + (RDR.toolsVisible ? ' show' : '') + '" id="imgTools">'
    + '<button id="ocrBtn">识别文字</button>'
    + '<button id="vizBtn">看图出题</button>'
    + '<button id="kpBtn" class="t-close">知识点</button>'
    + '<button id="closeImg" class="t-close">关闭</button></div>';
  document.getElementById('ocrBtn').onclick = () => { hideTools(); ocrImage(); };
  document.getElementById('kpBtn').onclick = () => { hideTools(); showPoints(); };
  document.getElementById('vizBtn').onclick = () => { hideTools(); visionFromImage(); };
  document.getElementById('closeImg').onclick = () => { resetBook(); renderReader(); };
  bindFlipGestures(view, { prev: () => {}, next: () => {}, middle: toggleTools });
  flipHintOnce();
  view.scrollTop = 0;
}

// ── C：整章提知识点（只喂当前这一章，整本塞不进去）────────────
// 输出：一句话概括 + 要点 + 生词/搭配（可一键进「我的生词」）+ 3~5 道自测题

async function pdfPageTextOf(n) {
  try {
    const page = await RDR.pdf.getPage(n);
    const tc = await page.getTextContent();
    const t = tc.items.map((it) => it.str).join(' ').replace(/[ 	]+/g, ' ').trim();
    return t;
  } catch { return ''; }
}

// 当前「这一章/这一页/这张图」的文本：文字书取章，PDF 取页（有书签就取整章），图片取 OCR 结果
async function chapterText() {
  const ch = RDR.book && RDR.book.chapters[RDR.ch];
  if (ch) return { title: ch.title || ('第 ' + (RDR.ch + 1) + ' 节'), text: (ch.text || '').slice(0, 9000) };

  if (RDR.pdf) {
    // 有文字重建/OCR 结果就用它：缺字体或扫描件时 getTextContent 只剩零星数字，
    // 拿那个去出题等于基于半张纸瞎猜
    if (RDR.textLines && RDR.textLines.length) {
      return { title: '文字视图', text: RDR.textLines.join(String.fromCharCode(10)).slice(0, 9000) };
    }
    // 有书签：按书签区间取多页，凑到 9000 字为止
    let title = '第 ' + RDR.page + ' 页';
    let from = RDR.page;
    let to = RDR.page;
    const items = RDR.outline && RDR.outline.length ? RDR.outline : null;
    if (items) {
      let start = null;
      let next = null;
      for (const it of items) {
        if (!it.page) continue;
        if (it.page <= RDR.page) start = it;
        else if (next === null) next = it;
      }
      if (start && start.page) { from = start.page; title = start.title; }
      if (next && next.page) to = next.page - 1;
    }
    if (to < from) to = from;
    let text = '';
    for (let n = from; n <= to && text.length < 9000; n++) {
      const t = await pdfPageTextOf(n);
      if (t) text += (text ? String.fromCharCode(10, 10) : '') + t;
    }
    if (!text.trim() && RDR.textLines && RDR.textLines.length) {
      text = RDR.textLines.join(String.fromCharCode(10));
      title = '文字视图';
    }
    if (!text.trim()) return null;
    return { title: title, text: text.slice(0, 9000) };
  }

  if (RDR.textLines && RDR.textLines.length) {
    return { title: '图片文字', text: RDR.textLines.join(String.fromCharCode(10)).slice(0, 9000) };
  }
  return null;
}

async function askPoints(text) {
  const sys = '你在帮学习者把材料变成可复习的知识点。只输出 JSON，不要解释。'
    + '先判断材料类型：语言类（记叙/散文/新闻/对话）重点提生词和固定搭配；'
    + '技术类（规则/公式/步骤/流程）重点提要点、规则和公式。';
  const user = '材料：\n' + text + '\n\n'
    + '返回 JSON：{"kind":"language 或 tech","summary":"一句话概括这段材料",'
    + '"points":["要点，最多 8 条"],'
    + '"words":[{"w":"原词或搭配","cn":"中文释义","note":"用法/搭配要点"}],'
    + '"quiz":[{"q":"题干","options":["选项1","选项2","选项3","选项4"],"a":0,"why":"为什么是这个答案"}]}'
    + '。quiz 出 3 到 5 题，a 是正确选项的下标（从 0 开始）。语言类的 words 至少 6 条，技术类可以少。';
  const res = await fetch(settings.apiBase + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.key },
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' },
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  return JSON.parse(j.choices[0].message.content);
}

function kpKey() {
  const where = RDR.book ? 'c' + RDR.ch : 'p' + RDR.page;
  return (RDR.key || '') + '#' + where;
}

let kpStore = loadJSON(LS.kpoints, {});

function cachedPoints() {
  const k = kpKey();
  return (RDR.kpCache && RDR.kpCache[k]) || kpStore[k] || null;
}

function rememberPoints(data) {
  const k = kpKey();
  RDR.kpCache = RDR.kpCache || {};
  RDR.kpCache[k] = data;
  kpStore[k] = data;
  const keys = Object.keys(kpStore);
  if (keys.length > 120) {                      // 只留最近 120 条
    keys.slice(0, keys.length - 120).forEach((x) => delete kpStore[x]);
  }
  saveJSON(LS.kpoints, kpStore);
}

async function showPoints() {
  const ch = await chapterText();
  if (!ch) return toast('这一页没有可读的文字（扫描件先点「识别文字」）');
  if (!settings.key) { toast('先在「设置」里填 AI Key'); state.tab = 'settings'; return render(); }
  const hit = cachedPoints();
  if (hit) return renderPoints(hit, ch);
  renderPoints({ loading: true }, ch);
  try {
    const data = await askPoints(ch.text);
    rememberPoints(data);
    renderPoints(data, ch);
  } catch (err) {
    renderPoints({ error: err.message }, ch);
  }
}

function closePoints() {
  const o = document.getElementById('kpOverlay');
  if (o) o.remove();
}

// 知识点以「浮层抽屉」打开：阅读页不动，关掉就能接着读（原来整页被替换，位置就丢了）
function renderPoints(kp, ch) {
  let body = '';
  if (kp.loading) {
    body = '<div class="empty"><span class="spin"></span> 正在读这一章…</div>';
  } else if (kp.error) {
    body = '<div class="empty">没取到：' + esc(kp.error)
      + '<div class="row" style="margin-top:12px"><button class="btn ghost" id="kpRetry">重试</button></div></div>';
  } else {
    const kindLabel = kp.kind === 'tech' ? '技术类' : kp.kind === 'language' ? '语言类' : '';
    const points = (kp.points || []).map((p) => '<li>' + esc(p) + '</li>').join('');
    const words = (kp.words || []).map((w, i) =>
      '<div class="it"><div><b>' + esc(w.w) + '</b> <span class="sub">' + esc(w.cn || '') + '</span>'
      + (w.note ? '<div class="sub">' + esc(w.note) + '</div>' : '') + '</div>'
      + '<button class="btn ghost" style="width:auto;padding:6px 10px;font-size:12px" data-w="' + i + '">＋卡</button></div>').join('');
    const quiz = (kp.quiz || []).map((q, qi) =>
      '<div class="kpq" data-q="' + qi + '"><div style="margin:10px 0 6px">' + (qi + 1) + '. ' + esc(q.q) + '</div>'
      + '<div class="opts">' + (q.options || []).map((o, oi) =>
        '<button data-o="' + oi + '">' + esc(o) + '</button>').join('') + '</div>'
      + '<div class="sub kpwhy" style="display:none;margin-top:6px"></div></div>').join('');
    body = (kindLabel ? '<div class="tag">' + kindLabel + '</div>' : '')
      + (kp.summary ? '<div class="card" style="min-height:0;padding:14px;margin:8px 0 12px"><div style="text-align:left">' + esc(kp.summary) + '</div></div>' : '')
      + (points ? '<h2>要点</h2><ul class="kplist">' + points + '</ul>' : '')
      + (words ? '<h2>生词 / 搭配</h2><div class="list">' + words + '</div>' : '')
      + (quiz ? '<h2>自测</h2>' + quiz : '')
      + '<div class="hint" style="margin-top:14px">内容按「文件 + 这一章/这一页」缓存，再点开不再花钱。</div>';
  }

  let o = document.getElementById('kpOverlay');
  if (!o) {
    o = document.createElement('div');
    o.id = 'kpOverlay';
    o.className = 'kpsheet';
    document.body.appendChild(o);
  }
  o.innerHTML = '<div class="kpPanel"><div class="kpHead"><span>' + esc(ch.title || '知识点')
    + '</span><button id="kpClose">关闭</button></div><div class="kpBody">' + body + '</div></div>';

  document.getElementById('kpClose').onclick = closePoints;
  o.onclick = (e) => { if (e.target === o) closePoints(); };
  const retry = document.getElementById('kpRetry');
  if (retry) retry.onclick = () => {
    const k = kpKey();
    delete kpStore[k];
    if (RDR.kpCache) delete RDR.kpCache[k];
    saveJSON(LS.kpoints, kpStore);
    closePoints();
    showPoints();
  };
  o.querySelectorAll('[data-w]').forEach((b) => {
    b.onclick = () => {
      const w = kp.words[Number(b.dataset.w)];
      addCardFromSelection(w.w);
      b.textContent = '已加入';
      b.disabled = true;
    };
  });
  o.querySelectorAll('.kpq').forEach((box) => {
    const q = kp.quiz[Number(box.dataset.q)];
    box.querySelectorAll('button[data-o]').forEach((btn) => {
      btn.onclick = () => {
        const oi = Number(btn.dataset.o);
        box.querySelectorAll('button[data-o]').forEach((x) => { x.classList.remove('right', 'wrong', 'sel'); });
        btn.classList.add(oi === q.a ? 'right' : 'wrong');
        if (oi !== q.a) box.querySelector('button[data-o="' + q.a + '"]').classList.add('right');
        const why = box.querySelector('.kpwhy');
        why.style.display = 'block';
        why.textContent = (oi === q.a ? '对。' : '答案是「' + (q.options || [])[q.a] + '」。') + (q.why || '');
      };
    });
  });
  const kb = o.querySelector('.kpBody');
  if (kb) kb.scrollTop = 0;
}

// ── B：真分页（CSS 多栏 = 一屏一页）+ 字号/行距 ─────────────
// 思路跟 Koodo 一样：把整章内容排成"栏宽 = 屏宽"的多栏，横向平移一栏就是一页。
// 不用自己量段落高度，浏览器排版，翻页只是 transform。

function layoutPages(keepRatio) {
  const vp = document.getElementById('pageViewport');
  const box = document.getElementById('bookText');
  if (!vp || !box) return;
  const w = Math.max(240, view.clientWidth - 28);
  // 高度取「整行」的整数倍，否则每页最后一行会被切掉半个字
  const lh = Math.max(16, (settings.readFont || 16) * (settings.readLine || 1.8));
  const h = Math.max(240, Math.floor((view.clientHeight - 34) / lh) * lh);
  const gap = 28;
  const spread = !!RDR.spread;
  const colW = spread ? Math.max(160, (w - gap) / 2) : w;
  vp.style.width = w + 'px';
  vp.style.height = h + 'px';
  box.style.height = h + 'px';
  box.style.columnWidth = colW + 'px';
  box.style.columnGap = gap + 'px';
  box.style.fontSize = settings.readFont + 'px';
  box.style.lineHeight = String(settings.readLine);
  RDR.pageW = w;
  RDR.pageGap = gap;
  RDR.colW = colW;
  const cols = Math.max(1, Math.round((box.scrollWidth + gap) / (colW + gap)));
  RDR.cols = cols;
  RDR.pages = spread ? Math.max(1, Math.ceil(cols / 2)) : cols;
  if (keepRatio && RDR.pages > 1) {
    RDR.pageIdx = Math.min(RDR.pages - 1, Math.round(keepRatio * (RDR.pages - 1)));
  }
  RDR.pageIdx = Math.max(0, Math.min(RDR.pageIdx || 0, RDR.pages - 1));
  applyPageTransform();
}

function applyPageTransform() {
  const box = document.getElementById('bookText');
  if (!box) return;
  const offset = (RDR.pageIdx || 0) * ((RDR.pageW || 0) + (RDR.pageGap || 0));
  box.style.transform = 'translateX(' + (-offset) + 'px)';
  const lab = document.getElementById('pageLabel');
  if (lab) lab.textContent = (RDR.pageIdx + 1) + ' / ' + (RDR.pages || 1);
}

function flipPage(delta) {
  if (!RDR.paged) return false;
  const next = (RDR.pageIdx || 0) + delta;
  if (next < 0) { gotoChapter(RDR.ch - 1, 'last'); return true; }
  if (next >= (RDR.pages || 1)) { gotoChapter(RDR.ch + 1, 'first'); return true; }
  RDR.pageIdx = next;
  applyPageTransform();
  saveReadPos();
  return true;
}

function bumpFont(delta) {
  settings.readFont = Math.max(13, Math.min(26, (settings.readFont || 16) + delta));
  saveJSON(LS.settings, settings);
  if (RDR.paged) {
    const ratio = RDR.pages > 1 ? (RDR.pageIdx || 0) / (RDR.pages - 1) : 0;
    layoutPages(ratio);
    applyPageTransform();
  } else {
    renderTextBook();
  }
}

function bumpLine(delta) {
  settings.readLine = Math.max(1.4, Math.min(2.4, Math.round(((settings.readLine || 1.8) + delta) * 10) / 10));
  saveJSON(LS.settings, settings);
  if (RDR.paged) {
    const ratio = RDR.pages > 1 ? (RDR.pageIdx || 0) / (RDR.pages - 1) : 0;
    layoutPages(ratio);
    applyPageTransform();
  } else {
    renderTextBook();
  }
}

function togglePaged() {
  RDR.paged = !RDR.paged;
  RDR.pageIdx = 0;
  renderTextBook();
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
  const box = '<div class="bookText' + (isHtml ? '' : ' plain') + '" id="bookText"'
    + ' style="font-size:' + settings.readFont + 'px;line-height:' + settings.readLine + '">' + html + '</div>';
  view.innerHTML =
    '<div class="meta"><span>' + esc(b.name) + '</span><span id="pageLabel">'
    + (RDR.paged ? (RDR.pageIdx + 1) + ' / ' + (RDR.pages || 1) : (RDR.ch + 1) + ' / ' + b.chapters.length)
    + '</span></div>'
    + (ownHeading ? '' : '<h2 class="chTitle">' + esc(ch.title) + '</h2>')
    + (RDR.paged ? '<div id="pageViewport">' + box + '</div>' : box)
    + '<div class="floating pager' + (RDR.toolsVisible ? ' show' : '') + '" id="bookTools">'
    + '<button id="prevCh">◀</button><button id="nextCh">▶</button>'
    + '<button id="tocBtn">目录</button>'
    + '<div class="sep"></div>'
    + '<button id="fBig" title="字号">A+</button><button id="fSmall" title="字号">A-</button>'
    + '<button id="lLoose" title="行距">行+</button><button id="lTight" title="行距">行-</button>'
    + '<button id="spreadBtn">' + (RDR.spread ? '单页' : '双页') + '</button>'
    + '<div class="sep"></div>'
    + '<button id="kpBtn" class="t-close">知识点</button>'
    + '<button id="vizBtn" class="t-close">看图出题</button>'
    + '<button id="togglePaged" class="t-close">' + (RDR.paged ? '滚动' : '分页') + '</button>'
    + '<button id="closeBook" class="t-close">关闭</button></div>';
  // 远程图挂了就把位置收起来，别留一个破图标
  view.querySelectorAll('#bookText img').forEach((img) => img.addEventListener('error', () => img.remove()));
  document.getElementById('prevCh').onclick = () => { if (!flipPage(-1)) gotoChapter(RDR.ch - 1); };
  document.getElementById('nextCh').onclick = () => { if (!flipPage(1)) gotoChapter(RDR.ch + 1); };
  document.getElementById('fSmall').onclick = () => bumpFont(-1);
  document.getElementById('fBig').onclick = () => bumpFont(1);
  document.getElementById('lTight').onclick = () => bumpLine(-0.1);
  document.getElementById('lLoose').onclick = () => bumpLine(0.1);
  document.getElementById('togglePaged').onclick = togglePaged;
  document.getElementById('tocBtn').onclick = () => { hideTools(); showBookToc(); };
  document.getElementById('spreadBtn').onclick = () => toggleSpread();
  const kpb = document.getElementById('kpBtn');
  if (kpb) kpb.onclick = () => { hideTools(); showPoints(); };
  document.getElementById('closeBook').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  if (RDR.paged) {
    layoutPages(RDR.pendingRatio != null ? RDR.pendingRatio : 0);
    RDR.pendingRatio = null;
  } else if (!RDR.restoring) view.scrollTop = 0;
  bindFlipGestures(view, {
    prev: () => { if (!flipPage(-1)) gotoChapter(RDR.ch - 1); },
    next: () => { if (!flipPage(1)) gotoChapter(RDR.ch + 1); },
    middle: toggleTools,
  });
  flipHintOnce();
}

function gotoChapter(n, at) {
  const b = RDR.book;
  if (!b) return;
  RDR.ch = Math.max(0, Math.min(b.chapters.length - 1, n));
  RDR.pageIdx = 0;
  // 打开的"恢复到第几页"比例不能再套到新章节上，否则跳章会跳到该章中间
  RDR.pendingRatio = null;
  renderTextBook();
  if (RDR.paged && at === 'last') {
    RDR.pageIdx = Math.max(0, (RDR.pages || 1) - 1);
    applyPageTransform();
  }
  RDR.restoring = true;
  setTimeout(() => { RDR.restoring = false; }, 400);
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

// ── 目录导航（PDF 自带书签）+ 单/双页 ─────────────────────
// 教材类 PDF 一般带书签（pdf.js 的 getOutline 直接能读），几百页的书没目录根本没法翻。

async function outlinePageNo(dest) {
  try {
    let d = dest;
    if (typeof d === 'string') d = await RDR.pdf.getDestination(d);   // 命名目的
    if (!Array.isArray(d) || !d.length) return null;
    const ref = d[0];
    if (typeof ref === 'number') return Math.max(1, Math.floor(ref) + 1);  // 有些文件直接给 0 基页号
    const idx = await RDR.pdf.getPageIndex(ref);
    return idx + 1;
  } catch { return null; }
}

async function buildOutline(items, depth, out) {
  for (const it of items) {
    const page = await outlinePageNo(it.dest);
    out.push({ title: (it.title || '').trim() || '(未命名)', page: page, depth: depth });
    if (it.items && it.items.length) await buildOutline(it.items, depth + 1, out);
  }
  return out;
}

async function pdfOutline() {
  if (RDR.outline) return RDR.outline;
  let raw = null;
  try { raw = await RDR.pdf.getOutline(); } catch { raw = null; }
  RDR.outline = raw && raw.length ? await buildOutline(raw, 0, []) : [];
  return RDR.outline;
}

async function showOutline() {
  if (!RDR.pdf) return;
  hideTools();
  view.innerHTML = '<div class="empty"><span class="spin"></span> 正在读书签…</div>';
  const items = await pdfOutline();
  const cur = RDR.page;
  let html = '<div class="meta"><span>目录</span><span>' + (items.length ? items.length + ' 条' : '没有书签') + '</span></div>'
    + '<div class="row" style="margin:6px 0 10px"><button class="btn ghost" id="ocBack">← 回阅读</button>'
    + '<button class="btn ghost" id="ocPage">跳到第…页</button>'
    + (items.length ? '' : '<button class="btn ghost" id="ocOcr">OCR 生成目录</button>')
    + '</div>';
  if (items.length) {
    // 高亮「当前页之前最后一条」= 正在读的章节
    let active = -1;
    items.forEach((it, i) => { if (it.page && it.page <= cur) active = i; });
    html += '<div class="list">' + items.map((it, i) =>
      '<button class="tocItem' + (i === active ? ' on' : '') + '" data-i="' + i + '" style="padding-left:' + (12 + it.depth * 14) + 'px">'
      + '<span>' + esc(it.title) + '</span><small>' + (it.page ? 'p.' + it.page : '无页码') + '</small></button>').join('') + '</div>';
  } else {
    html += '<div class="hint">这份 PDF 没有书签（常见于扫描件）。可以用「跳到第…页」，或者用「OCR 生成目录」：'
      + '把目录页 OCR 出来，自动整理成可点的目录草案。</div>';
  }
  view.innerHTML = html;
  document.getElementById('ocBack').onclick = () => renderReader();
  document.getElementById('ocPage').onclick = () => {
    const n = Number(prompt('跳到第几页？（共 ' + RDR.total + ' 页）', String(RDR.page)));
    if (n && n >= 1) { goToPageEverywhere(n); }
  };
  const ocrBtn = document.getElementById('ocOcr');
  if (ocrBtn) ocrBtn.onclick = () => ocrOutlineDraft();
  view.querySelectorAll('.tocItem').forEach((b) => {
    b.onclick = () => {
      const it = items[Number(b.dataset.i)];
      if (it.page) goToPageEverywhere(it.page);
      else toast('这条书签没带页码（文件本身没写），用「跳到第…页」吧');
    };
  });
  view.scrollTop = 0;
}

// 跳出目录页后回到阅读并定位
function goToPageEverywhere(n) {
  if (RDR.textMode) {
    toast('现在是「文字视图」，不能按页跳；先点「看原图」');
    return;
  }
  const p = Math.max(1, Math.min(RDR.total || 1, n));
  RDR.page = p;
  toast('跳到第 ' + p + ' 页');
  if (RDR.pdfScroll) {
    renderReader();
    setTimeout(() => scrollToPdfPage(p), 120);
  } else {
    renderReader();
    drawPage();
  }
  saveReadPos();
}

// 扫描版没有书签：把「目录页」OCR 出来，抽成可点的目录草案
function parseTocLines(lines, total) {
  const out = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = String(raw).replace(/\s+/g, ' ').trim();
    if (line.length < 4 || line.length > 60) continue;
    const m = /^(.*?)[\s.·…•\-]{1,}(\d{1,4})$/.exec(line);
    if (m && m[1].trim().length >= 2) {
      const p = Number(m[2]);
      if (p >= 1 && p <= Math.max(total, 2000)) {
        const title = m[1].trim();
        if (!seen.has(title)) { seen.add(title); out.push({ title: title, page: p }); }
        continue;
      }
    }
    if (/^(第\s*[一二三四五六七八九十百\d]+\s*[章节讲篇部]|\d+(\.\d+)+)/.test(line)) {
      if (!seen.has(line)) { seen.add(line); out.push({ title: line, page: null }); }
    }
  }
  return out;
}

async function ocrPageToLines(worker, n) {
  const page = await RDR.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(1.5, Math.min(4, 1800 / base.width));
  const vp = page.getViewport({ scale: scale });
  const c = document.createElement('canvas');
  c.width = Math.floor(vp.width);
  c.height = Math.floor(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  const { data } = await worker.recognize(c);
  return String(data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function ocrOutlineDraft() {
  if (!RDR.pdf) return;
  const def = '1-' + Math.min(8, RDR.total);
  const range = prompt('目录通常在前面几页。OCR 哪几页？（共 ' + RDR.total + ' 页，格式 1-8）', def);
  if (!range) return;
  const m = /^(\d+)\s*[-~到]\s*(\d+)$/.exec(range.trim()) || /^(\d+)$/.exec(range.trim());
  if (!m) return toast('格式不对，像这样：1-8');
  const from = Math.max(1, Number(m[1]));
  const to = Math.min(RDR.total, Number(m[2] || m[1]));
  if (to < from) return toast('页码范围不对');
  if (to - from + 1 > 20) return toast('一次最多 20 页（OCR 很慢）');

  view.innerHTML = '<div class="empty"><span class="spin"></span> <span id="ocrTocTip">准备 OCR…</span></div>';
  try {
    const T = await ensureTesseract();
    const worker = await T.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: 'vendor/ocr/worker.min.js',
      corePath: 'vendor/ocr/tesseract-core-simd-lstm.wasm.js',
      langPath: 'vendor/ocr/',
    });
    const all = [];
    try {
      for (let n = from; n <= to; n++) {
        const tip = document.getElementById('ocrTocTip');
        if (tip) tip.textContent = '正在识别第 ' + n + ' / ' + to + ' 页…（每页十几秒）';
        try { all.push(...(await ocrPageToLines(worker, n))); } catch { /* 单页失败跳过 */ }
      }
    } finally {
      try { await worker.terminate(); } catch { /* 已结束 */ }
    }
    const items = parseTocLines(all, RDR.total);
    RDR.outline = items;
    renderOutlineDraft(items, all);
  } catch (err) {
    view.innerHTML = '<div class="empty">OCR 失败：' + esc(err.message)
      + '<div class="row" style="margin-top:12px"><button class="btn ghost" id="ocBack2">← 回阅读</button></div></div>';
    const b = document.getElementById('ocBack2');
    if (b) b.onclick = () => renderReader();
  }
}

function renderOutlineDraft(items, rawLines) {
  view.innerHTML =
    '<div class="meta"><span>目录草案（OCR）</span><span>' + items.length + ' 条</span></div>'
    + '<div class="row" style="margin:6px 0 10px"><button class="btn ghost" id="ocBack">← 回阅读</button></div>'
    + (items.length
      ? '<div class="hint">带页码的可以点；没页码的只列出来（OCR 没认到行尾数字）。条目不准属于正常，OCR 认表格和点线本来就弱。</div>'
        + '<div class="list">' + items.map((it, i) =>
          '<button class="tocItem" data-i="' + i + '"><span>' + esc(it.title) + '</span><small>'
          + (it.page ? 'p.' + it.page : '—') + '</small></button>').join('') + '</div>'
      : '<div class="hint">这几页没认出目录行。可以换个页码范围再试，或者直接用「跳到第…页」。</div>'
        + '<div class="bookText plain" style="font-size:13px">' + rawLines.slice(0, 40).map((l) => '<p>' + esc(l) + '</p>').join('') + '</div>');
  const back = document.getElementById('ocBack');
  if (back) back.onclick = () => renderReader();
  view.querySelectorAll('.tocItem').forEach((b) => {
    b.onclick = () => {
      const it = items[Number(b.dataset.i)];
      if (it && it.page) goToPageEverywhere(it.page);
    };
  });
  view.scrollTop = 0;
}

// ── 文字书的目录（就是章列表）：跳章 + 高亮当前章 ────────────
function showBookToc() {
  const b = RDR.book;
  if (!b) return;
  hideTools();
  const cur = RDR.ch;
  view.innerHTML =
    '<div class="meta"><span>目录</span><span>' + b.chapters.length + ' 节</span></div>'
    + '<div class="row" style="margin:6px 0 10px"><button class="btn ghost" id="tocBack">← 回正文</button>'
    + '<button class="btn ghost" id="tocJump">跳到第…节</button></div>'
    + '<div class="list">' + b.chapters.map((c, i) =>
      '<button class="tocItem' + (i === cur ? ' on' : '') + '" data-i="' + i + '">'
      + '<span>' + esc(c.title || ('第 ' + (i + 1) + ' 节')) + '</span>'
      + '<small>' + (i + 1) + '</small></button>').join('') + '</div>';
  document.getElementById('tocBack').onclick = () => renderTextBook();
  document.getElementById('tocJump').onclick = () => {
    const n = Number(prompt('跳到第几节？（共 ' + b.chapters.length + ' 节）', String(cur + 1)));
    if (n && n >= 1) { RDR.pageIdx = 0; gotoChapter(n - 1, 'first'); }
  };
  view.querySelectorAll('.tocItem').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.i);
      RDR.pageIdx = 0;
      gotoChapter(i, 'first');
      toast('跳到第 ' + (i + 1) + ' 节');
    };
  });
  view.scrollTop = 0;
}

// ── 单页 / 双页（横屏读教材更像书）──────────────────────
function toggleSpread() {
  RDR.spread = !RDR.spread;
  RDR.pageIdx = 0;
  renderReader();
  if (RDR.book && RDR.paged) {
    setTimeout(() => { layoutPages(0); applyPageTransform(); }, 30);
  }
}

// ── PDF：滚动模式（连续纵向翻页）+ 尺寸自适应 ───────────────
// 扫描件往往比 A4 长，逐页翻看不方便；给一个「滚动」模式：所有页纵向排开，滚到哪画到哪。

function pdfFitScale(page, base) {
  const w = Math.max(240, (view.clientWidth || 360) - 28);
  return w / base.width;
}

async function renderScrollPage(el) {
  if (!RDR.pdf || el.dataset.done) return;
  el.dataset.done = '1';
  const n = Number(el.dataset.page);
  try {
    const page = await RDR.pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: pdfFitScale(page, base) * (RDR.scale || 1) });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width * dpr);
    c.height = Math.floor(vp.height * dpr);
    await page.render({
      canvasContext: c.getContext('2d'),
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    el.innerHTML = '';
    el.appendChild(c);
    const no = document.createElement('div');
    no.className = 'pdfPageNo';
    no.textContent = n + ' / ' + RDR.total;
    el.appendChild(no);
    el.style.minHeight = '0';
  } catch (err) {
    el.dataset.done = '';
  }
}

function renderPdfScroll() {
  view.innerHTML =
    '<div class="meta"><span>' + esc(RDR.name) + '</span><span id="pgLabel">' + RDR.page + ' / ' + RDR.total + '</span></div>'
    + '<div id="pdfScroll"></div>'
    + '<div class="floating pager' + (RDR.toolsVisible ? ' show' : '') + '" id="pdfTools">'
    + '<button id="prevPage">▲</button><button id="nextPage">▼</button>'
    + '<button id="zoomOut">－</button><button id="zoomIn">＋</button>'
    + '<button id="toggleScroll" class="t-close">翻页</button>'
    + '<button id="tocBtn" class="t-close">目录</button>'
    + '<button id="spreadBtn" class="t-close">' + (RDR.spread ? '单页' : '双页') + '</button>'
    + '<button id="ocrBtn" class="t-close">识别文字</button>'
    + '<button id="kpBtn" class="t-close">知识点</button>'
    + '<button id="vizBtn" class="t-close">看图出题</button>'
    + '<button id="toggleScroll" class="t-close">滚动</button>'
    + '<button id="closePdf" class="t-close">关闭</button>'
    + (RDR.textLines && RDR.textLines.length ? '<button id="showText" class="t-close">文字视图</button>' : '')
    + '</div>';
  const host = document.getElementById('pdfScroll');
  for (let i = 1; i <= RDR.total; i++) {
    const el = document.createElement('div');
    el.className = 'pdfPage';
    el.dataset.page = i;
    host.appendChild(el);
  }
  if (RDR.scrollIO) RDR.scrollIO.disconnect();
  RDR.scrollIO = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) renderScrollPage(e.target);
  }, { root: view, rootMargin: '400px 0px' });
  host.querySelectorAll('.pdfPage').forEach((el) => RDR.scrollIO.observe(el));
  // 进度栏跟着滚动更新
  view.onscroll = () => {
    const mid = view.scrollTop + view.clientHeight / 2;
    let cur = 1;
    host.querySelectorAll('.pdfPage').forEach((el) => { if (el.offsetTop <= mid) cur = Number(el.dataset.page); });
    RDR.page = cur;
    const lb = document.getElementById('pgLabel');
    if (lb) lb.textContent = cur + ' / ' + RDR.total;
  };
  document.getElementById('prevPage').onclick = () => scrollToPdfPage(RDR.page - 1);
  document.getElementById('nextPage').onclick = () => scrollToPdfPage(RDR.page + 1);
  document.getElementById('zoomOut').onclick = () => { RDR.scale = Math.max(0.6, RDR.scale / 1.15); relayoutPdf(); };
  document.getElementById('zoomIn').onclick = () => { RDR.scale = Math.min(3, RDR.scale * 1.15); relayoutPdf(); };
  document.getElementById('toggleScroll').onclick = () => { RDR.pdfScroll = false; renderReader(); };
  const tb2 = document.getElementById('tocBtn');
  if (tb2) tb2.onclick = () => showOutline();
  const kpb2 = document.getElementById('kpBtn');
  if (kpb2) kpb2.onclick = () => { hideTools(); showPoints(); };
  const viz = document.getElementById('vizBtn');
  if (viz) viz.onclick = () => { hideTools(); visionFromPdfPage(); };
  document.getElementById('closePdf').onclick = () => { saveReadPos(); resetBook(); renderReader(); };
  const ocrb = document.getElementById('ocrBtn');
  if (ocrb) ocrb.onclick = () => { hideTools(); ocrCurrentPage(); };
  const ts = document.getElementById('toggleScroll');
  if (ts) ts.onclick = () => { RDR.pdfScroll = true; renderReader(); };
  const tb = document.getElementById('tocBtn');
  if (tb) tb.onclick = () => showOutline();
  const sb = document.getElementById('spreadBtn');
  if (sb) sb.onclick = toggleSpread;
  const st = document.getElementById('showText');
  if (st) st.onclick = () => { RDR.textMode = true; renderReader(); };
  bindFlipGestures(view, {
    prev: () => scrollToPdfPage(RDR.page - 1),
    next: () => scrollToPdfPage(RDR.page + 1),
    middle: toggleTools,
  });
  // 恢复上次读到的那一页
  if (RDR.page > 1) setTimeout(() => scrollToPdfPage(RDR.page), 150);
}

function scrollToPdfPage(n) {
  const p = Math.max(1, Math.min(RDR.total, n));
  const el = document.querySelector('.pdfPage[data-page="' + p + '"]');
  if (!el) return;
  view.scrollTo({ top: el.offsetTop - 8, behavior: 'smooth' });
  RDR.page = p;
  saveReadPos();
}

// 缩放/换屏后整页重排（清掉 done 标记重新画）
function relayoutPdf() {
  if (RDR.pdfScroll) {
    const keep = RDR.page;
    renderPdfScroll();
    RDR.page = keep;
    setTimeout(() => scrollToPdfPage(keep), 120);
  } else {
    drawPage();
  }
}

// 渲染单个 PDF 页（自己管画布 + 文字层），双页模式就是并排渲染两页
async function renderPdfPage(n, canvasId, layerId, maxWidth) {
  const canvas = document.getElementById(canvasId);
  const tl = document.getElementById(layerId);
  if (!canvas) return;
  const page = await RDR.pdf.getPage(n);
  const base = page.getViewport({ scale: 1 });
  const scale = (Math.max(120, maxWidth) / base.width) * RDR.scale;
  const vp = page.getViewport({ scale: scale });
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
  if (!tl) return;
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
  // 结构检测可能误报（字体藏在压缩对象流里）：真取到中文就把提示撤掉
  if (RDR.fontRisk && tc.items.some((it) => /[㐀-鿿]/.test(it.str))) {
    RDR.fontRisk = false;
    const w = document.getElementById('pdfFontWarn');
    if (w) w.remove();
  }
}

async function drawPage() {
  if (!RDR.pdf || RDR.rendering) return;
  RDR.rendering = true;
  const wrap = document.getElementById('readerWrap');
  if (!wrap) { RDR.rendering = false; return; }
  try {
    const nums = [RDR.page];
    if (RDR.spread && RDR.page + 1 <= RDR.total) nums.push(RDR.page + 1);
    const key = nums.join(',');
    if (wrap.dataset.pages !== key) {
      wrap.dataset.pages = key;
      wrap.classList.toggle('spread', nums.length > 1);
      wrap.innerHTML = nums.map((n, i) =>
        '<div class="pageSlot"><canvas id="' + (i === 0 ? 'pdfCanvas' : 'pdfCanvas' + i) + '"></canvas>'
        + '<div class="textLayer" id="' + (i === 0 ? 'textLayer' : 'textLayer' + i) + '"></div></div>'
      ).join('');
    }
    const gap = 8;
    const avail = (view.clientWidth || 360) - 28 - (nums.length - 1) * gap;
    const wPer = avail / nums.length;
    for (let i = 0; i < nums.length; i++) {
      await renderPdfPage(nums[i], i === 0 ? 'pdfCanvas' : 'pdfCanvas' + i, i === 0 ? 'textLayer' : 'textLayer' + i, wPer);
    }
    const lb = document.getElementById('pgLabel');
    if (lb) lb.textContent = (nums.length > 1 ? nums[0] + '-' + nums[nums.length - 1] : nums[0]) + ' / ' + RDR.total;

    // 字体是异步注册的：手机上个别字晚到会留空白，等字体就绪后补画一次
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

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (RDR.pdf) relayoutPdf();
    else if (RDR.paged && RDR.book) {
      const ratio = RDR.pages > 1 ? (RDR.pageIdx || 0) / (RDR.pages - 1) : 0;
      layoutPages(ratio);
    }
  }, 180);
});
window.addEventListener('orientationchange', () => setTimeout(() => { if (RDR.pdf) relayoutPdf(); }, 300));


// 工具条上点了按钮就重新计时（正在缩放/翻页时不要自己收掉）
document.addEventListener('click', (e) => {
  if (RDR.toolsVisible && e.target.closest && e.target.closest('.floating')) scheduleHideTools();
});

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
