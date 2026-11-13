// today-test.js —— D7「今天页」验收（真 Edge headless，桩桥，断言 DOM）
//
// 用法：node today-test.js
// 退出码：0 全过 / 1 有失败 / 2 环境缺件
//
// 验的是「今天页只回答现在该干什么」：
//   1. 从 NG 拿到当前书 + 第几章（shelf.current）
//   2. 到期复习 / 没学过 / 待确认生词 三个数是真的（来自本机）
//   3. NG 不在时如实说「还不知道你在读哪本」，不糊一个假书名
//   4. 浏览器里说明取不到 NG 的书

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'today');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8805);
const CDP_PORT = Number(process.env.CDP_PORT || 9344);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '    ← ' + JSON.stringify(detail)));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, u.replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve(srv)));
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async launch(profile, port) {
    const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + profile,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 80 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json(); }
      catch { await sleep(250); }
    }
    if (!ver) { proc.kill(); throw new Error('ENV'); }
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; });
    const c = new CDP(ws);
    c.proc = proc;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      const p = m.id && c.pend.get(m.id);
      if (!p) return;
      c.pend.delete(m.id);
      m.error ? p.no(new Error(m.error.message)) : p.ok(m.result);
    };
    return c;
  }
  send(method, params = {}, sid) {
    const id = ++this.id;
    this.ws.send(JSON.stringify(sid ? { id, method, params, sessionId: sid } : { id, method, params }));
    return new Promise((ok, no) => this.pend.set(id, { ok, no }));
  }
  async eval(body) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(async () => { ' + body + ' })()', awaitPromise: true, returnByValue: true,
    }, this.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.proc.kill(); } catch { /* 已退出 */ } }
}

const STUB = `
  window.__today = {
    current: { ok: true, title: '狄公案', author: '高罗佩', chapterIndex: 11, chapterPos: 420 },
    reading: [{ book: '狄公案', chapter: 11, kind: 'read_ng' }, { book: '教材', chapter: 3, kind: 'read_ng' }],
    calls: []
  };
  window.zenus = {
    _ls: [],
    addEventListener(_t, fn) { this._ls.push(fn); },
    _emit(m) { this._ls.forEach((f) => f({ data: JSON.stringify(m) })); },
    postMessage(raw) {
      let r = {};
      try { r = JSON.parse(raw); } catch (e) { return; }
      window.__today.calls.push(r.cmd);
      if (r.cmd === 'shelf.current') return this._emit({ id: r.id, ok: true, data: window.__today.current });
      if (r.cmd === 'reading.state') return this._emit({ id: r.id, ok: true, data: window.__today.reading });
      if (r.cmd === 'inbox.list') return this._emit({ id: r.id, ok: true, data: [] });
      this._emit({ id: r.id, ok: true, data: null });
    }
  };
`;

(async () => {
  if (!fs.existsSync(EDGE)) { console.log('SKIP  找不到 Edge：' + EDGE); process.exit(2); }
  fs.mkdirSync(TMP, { recursive: true });
  const prof = path.join(TMP, 'prof');
  fs.rmSync(prof, { recursive: true, force: true });
  const srv = await serve();
  let cdp = null;
  try {
    cdp = await CDP.launch(prof, CDP_PORT);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    cdp.sid = sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB }, sessionId);
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' }, sessionId);
    await sleep(2500);

    // ── 1. 当前书从 NG 来 ──
    const first = await cdp.eval(`
      state.tab = 'today';
      await render();
      return {
        title: (document.querySelector('.todayCard .tt') || {}).textContent || '',
        sub: (document.querySelector('.todayCard .ts') || {}).textContent || '',
        buttons: Array.from(document.querySelectorAll('.todayRow button')).map((b) => b.textContent),
        stats: ['todayReview', 'todayFresh', 'todayInbox'].map((id) => {
          const el = document.getElementById(id);
          return el ? el.textContent : '';
        }),
        calls: window.__today.calls,
        recent: Array.from(document.querySelectorAll('.list .it')).map((e) => e.textContent),
      };
    `);
    check('今天页显示 NG 当前书 + 第几章',
      first.title === '狄公案' && /第 12 章/.test(first.sub) && /高罗佩/.test(first.sub), first);
    check('三个数（到期/没学过/待确认）都在',
      first.stats.length === 3 && first.stats.every((s) => s.length > 0)
      && first.stats.every((s, i) => /到期复习|没学过|待确认生词/.test(s)), first.stats);
    check('最近在读列出 reading.state 的行', first.recent.length === 2 && /教材/.test(first.recent.join('')), first.recent);
    check('确实问了 NG（shelf.current）', first.calls.includes('shelf.current'), first.calls);

    // ── 2. NG 不在：如实说，不糊假书名 ──
    const offline = await cdp.eval(`
      window.__today.current = { ok: false, error: '请先打开 NG（1124 连不上）' };
      state.today.at = 0;
      await render();
      return {
        title: (document.querySelector('.todayCard .tt') || {}).textContent || '',
        sub: (document.querySelector('.todayCard .ts') || {}).textContent || '',
      };
    `);
    check('NG 不在时明说「还不知道你在读哪本」+ 原因',
      /还不知道/.test(offline.title) && /1124/.test(offline.sub), offline);

    // ── 3. 浏览器里：说明取不到 NG ──
    await cdp.eval('window.zenus = undefined; return true;');
    const noNative = await cdp.eval(`
      state.today.at = 0;
      await render();
      return { sub: (document.querySelector('.todayCard .ts') || {}).textContent || '' };
    `);
    check('浏览器里说明「取不到 NG 的书」', /浏览器/.test(noNative.sub), noNative);

    console.log('');
  } catch (err) {
    check('跑完整个流程', false, { err: err.message, stack: String(err.stack || '').slice(0, 400) });
  } finally {
    if (cdp) cdp.close();
    srv.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('共 ' + results.length + ' 项，PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
})();
