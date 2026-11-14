// shortcut-test.js —— T1「桌面快捷方式路由」验收（跑 Edge headless，桩桥，断 state + DOM）
//
// 用法：node shortcut-test.js
// 退出码：0 全过 / 1 有失败 / 2 环境缺件
//
// 验的是「点了桌面图标之后，学习机落到哪一页」：
//   1. 冷启动：原生把 route=learn 记进 prefs → 网页 init 里 shortcut.take 取走 → 切「今天」页
//   2. 取走即清：再调一次 shortcut.take 回空串，路由不会反复触发
//   3. 暖启动：App 已开时原生发 zenus:shortcut 事件 → 同样切「今天」页
//   4. route=listen 不归网页管（原生点了直接起听书服务）：网页取走但不跳页
//   5. 浏览器里没有桥：takeShortcut 静默返回，不报错、不改页

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'shortcut');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8806);
const CDP_PORT = Number(process.env.CDP_PORT || 9345);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '     ← ' + JSON.stringify(detail)));
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

// 桩：原生侧只有 shortcut.take 有状态（route 取走即清），其余命令一律回 null。
// 语义照 ZenusBridge 的真实实现：读 prefs + remove + 回 {route}，空则回空串。
const STUB = `
  window.__sc = { route: 'learn', calls: [] };
  window.zenus = {
    _ls: [],
    addEventListener(_t, fn) { this._ls.push(fn); },
    _emit(m) { this._ls.forEach((f) => f({ data: JSON.stringify(m) })); },
    postMessage(raw) {
      let r = {};
      try { r = JSON.parse(raw); } catch (e) { return; }
      if (r.cmd === 'shortcut.take') {
        const taken = window.__sc.route || '';
        window.__sc.route = '';                 // 取走即清：同一份 route 只生效一次
        window.__sc.calls.push({ cmd: r.cmd, taken });
        return this._emit({ id: r.id, ok: true, data: { route: taken } });
      }
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

    // ── 1. 冷启动：init 里自己把 route 取走并落到「今天」页 ──
    const cold = await cdp.eval(`
      return {
        tab: state.tab,
        onTab: (document.querySelector('.tabbar button.on') || {}).dataset
          ? document.querySelector('.tabbar button.on').dataset.tab : '',
        taken: window.__sc.calls.filter((c) => c.cmd === 'shortcut.take').map((c) => c.taken),
        todayCard: !!document.querySelector('.todayCard'),
        build: (typeof BUILD === 'string') ? BUILD : '',
      };
    `);
    check('冷启动 route=learn → 停在「今天」页',
      cold.tab === 'today' && cold.onTab === 'today' && cold.todayCard, cold);
    check('route 确实经 shortcut.take 取走（第一次拿到 learn）',
      cold.taken.length >= 1 && cold.taken[0] === 'learn', cold.taken);

    // ── 2. 取走即清：再调一次回空串，不重复切页 ──
    const again = await cdp.eval(`
      const before = window.__sc.calls.length;
      await takeShortcut();
      const calls = window.__sc.calls;
      return { before, after: calls.length, last: calls[calls.length - 1], tab: state.tab };
    `);
    check('取走即清：再调一次回空串、页面不动',
      again.after === again.before + 1 && again.last && again.last.cmd === 'shortcut.take'
      && again.last.taken === '' && again.tab === 'today', again);

    // ── 3. 暖启动：App 已开时原生发 zenus:shortcut，网页照样落「今天」 ──
    const warm = await cdp.eval(`
      window.__sc.route = 'learn';
      state.tab = 'shelf';
      await render();
      window.dispatchEvent(new Event('zenus:shortcut'));
      await new Promise((r) => setTimeout(r, 300));
      const calls = window.__sc.calls;
      return { tab: state.tab, last: calls[calls.length - 1] };
    `);
    check('暖启动：zenus:shortcut 事件 → 切「今天」页（不靠重开 App）',
      warm.tab === 'today' && warm.last && warm.last.taken === 'learn', warm);

    // ── 4. route=listen 不归网页管：取走但不跳页（原生已直接起听书服务） ──
    const listen = await cdp.eval(`
      window.__sc.route = 'listen';
      state.tab = 'settings';
      await render();
      window.dispatchEvent(new Event('zenus:shortcut'));
      await new Promise((r) => setTimeout(r, 300));
      const calls = window.__sc.calls;
      return { tab: state.tab, last: calls[calls.length - 1] };
    `);
    check('route=listen：取走后不抢着跳页（听书由原生起）',
      listen.tab === 'settings' && listen.last && listen.last.taken === 'listen', listen);

    // ── 5. 浏览器里没有桥：静默返回，不报错、不改页 ──
    await cdp.eval('window.zenus = undefined; return true;');
    const noBridge = await cdp.eval(`
      window.__sc.route = 'learn';
      state.tab = 'review';
      await render();
      const back = await takeShortcut();
      return { tab: state.tab, back: String(back) };
    `);
    check('浏览器（无桥）里 takeShortcut 静默返回、不改页',
      noBridge.tab === 'review', noBridge);

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
