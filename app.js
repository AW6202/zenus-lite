// 学习机 Lite — 静态 PWA：内容来自 pack.json，进度存本地，AI 直连 OpenAI 兼容接口
'use strict';

const BUILD = '2026-10-28.5';

const LS = {
  progress: 'zenus.progress.v1',
  log: 'zenus.log.v1',
  settings: 'zenus.settings.v1',
  chat: 'zenus.chat.v1',
};

const DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  key: '',
  dailyNew: 10,
  ttsRate: 0.9,
  ctxMsgs: 12,
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

  // 只追加的复习流水：换调度算法（SM-2 → FSRS）或换 App 都不丢历史
  reviewLog.push({ id, r: rating, ts: now });
  if (reviewLog.length > 5000) reviewLog = reviewLog.slice(-5000);
  saveJSON(LS.log, reviewLog);
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

    <h2>进度</h2>
    <div class="hint">进度只保存在这台手机上。导出后放进 git 或网盘，换手机时导入。</div>
    <div class="row" style="margin-top:8px">
      <button class="btn" id="exportProg">导出进度</button>
      <button class="btn" id="importProg">导入进度</button>
    </div>
    <input type="file" id="fileProg" accept="application/json" style="display:none">

    <h2>关于</h2>
    <div class="row" style="margin-bottom:8px"><button class="btn" id="checkUpdate">检查更新</button></div>
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
  const cu = $('#checkUpdate');
  if (cu) cu.onclick = async () => {
    try {
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

// 选字朗读：选中任意文字 → 浮出「🔊 朗读」按钮
(function selectionSpeak() {
  let fab = null;
  const remove = () => { if (fab) { fab.remove(); fab = null; } };
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    const text = sel && sel.toString().trim();
    if (!text || text.length > 200 || !sel.rangeCount) return remove();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return remove();
    if (!fab) {
      fab = document.createElement('button');
      fab.id = 'speakFab';
      fab.onclick = (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        speak(fab.dataset.text);
        remove();
      };
      document.body.appendChild(fab);
    }
    fab.textContent = '🔊 朗读';
    fab.dataset.text = text;
    fab.style.left = Math.min(window.innerWidth - 96, Math.max(8, rect.left)) + 'px';
    fab.style.top = Math.max(8, rect.top - 46) + 'px';
  });
  document.addEventListener('click', (e) => { if (e.target.id !== 'speakFab') remove(); });
})();

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
