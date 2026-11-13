// inbox-test.js —— B 批 6：生词收件箱改造验收（真 Edge headless，桩桥，断言命令与去重）
//
// 用法：node inbox-test.js
// 退出码：0 全过 / 1 有失败 / 2 环境缺件
//
// 验的是三件事：
//   1. 学习机拉箱走「只列出」的 inbox.list，不再走会清空的 inbox.take
//   2. 反复拉、切回前台再拉，都不会重复（按 id 去重）
//   3. 老 APK 没有 inbox.list 时能退回 inbox.take（不至于一个词都拉不到）

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'inbox');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8803);
const CDP_PORT = Number(process.env.CDP_PORT || 9342);
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
  async page(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sid = sessionId;
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    await sleep(1800);
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

// 页面一加载就注入桩桥（必须在 app.js 之前跑）
const STUB = `
  window.__inbox = {
    cmds: [],
    supportsList: true,
    items: [
      { id: 'w-alpha', front: 'alpha', back: '第一个' },
      { id: 'w-beta', front: 'beta', back: '第二个' },
      { id: 'w-gamma', front: 'gamma', back: '第三个' }
    ]
  };
  window.zenus = {
    _ls: [],
    addEventListener(_t, fn) { this._ls.push(fn); },
    _emit(msg) { this._ls.forEach((f) => f({ data: JSON.stringify(msg) })); },
    postMessage(raw) {
      let req = {};
      try { req = JSON.parse(raw); } catch (e) { return; }
      window.__inbox.cmds.push(req.cmd);
      let msg = { id: req.id, ok: true, data: null };
      if (req.cmd === 'inbox.list') {
        if (window.__inbox.supportsList) msg.data = window.__inbox.items;
        else msg = { id: req.id, ok: false, error: 'unknown cmd: inbox.list' };
      } else if (req.cmd === 'inbox.take') {
        msg.data = window.__inbox.items;
      }
      this._emit(msg);
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

    // ── 1. 走的是「只列出」的 inbox.list ──
    const first = await cdp.eval(`
      const cmds = window.__inbox.cmds;
      return { inbox: state.inbox.length, ids: state.inbox.map((x) => x.id).sort(),
               listCalls: cmds.filter((c) => c === 'inbox.list').length,
               takeCalls: cmds.filter((c) => c === 'inbox.take').length };
    `);
    check('拉箱走 inbox.list（只列出），不走会清空的 inbox.take',
      first.inbox === 3 && first.listCalls >= 1 && first.takeCalls === 0, first);
    check('三张候选都进了本地待确认箱',
      first.ids.join(',') === 'w-alpha,w-beta,w-gamma', first.ids);

    // ── 2. 再拉两次不重复（按 id 去重）──
    const again = await cdp.eval(`
      await pullCoreInbox();
      await pullCoreInbox();
      return { inbox: state.inbox.length, ids: state.inbox.map((x) => x.id).sort() };
    `);
    check('重复拉取不会重复入箱（按 id 去重）', again.inbox === 3 && again.ids.length === 3, again);

    // ── 3. 切回前台会再拉一次；连发只算一次（节流）──
    // 先把启动时的定时拉取放完（init 里 2.5s 那次），再清零计数，避免把后台定时器算进来
    const focus = await cdp.eval(`
      await new Promise((r) => setTimeout(r, 2600));
      window.__inbox.cmds.length = 0;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('focus'));         // 连发两次
      await new Promise((r) => setTimeout(r, 400));
      const burst = window.__inbox.cmds.filter((c) => c === 'inbox.list').length;
      await new Promise((r) => setTimeout(r, 2000));    // 过掉 1.5s 节流窗口
      window.dispatchEvent(new Event('pageshow'));      // 从听书界面回来走这个
      await new Promise((r) => setTimeout(r, 400));
      const later = window.__inbox.cmds.filter((c) => c === 'inbox.list').length;
      return { burst, later };
    `);
    check('切回前台（focus）会再拉一次', focus.later > focus.burst, focus);
    check('三个事件一起来只拉一次（节流 1.5s）', focus.burst === 1, focus);

    // ── 4. 老 APK 没有 inbox.list → 退回 inbox.take ──
    const fallback = await cdp.eval(`
      window.__inbox.supportsList = false;
      window.__inbox.cmds.length = 0;
      state.inbox = [];
      await pullCoreInbox();
      return { inbox: state.inbox.length, cmds: window.__inbox.cmds.filter((c) => c.startsWith('inbox')) };
    `);
    check('老 APK（没有 inbox.list）能退回 inbox.take，一个词都不少',
      fallback.inbox === 3 && fallback.cmds[0] === 'inbox.list' && fallback.cmds.includes('inbox.take'), fallback);

    console.log('');
  } catch (err) {
    check('跑完整个流程', false, { err: err.message, stack: String(err.stack || '').slice(0, 500) });
  } finally {
    if (cdp) cdp.close();
    srv.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log('共 ' + results.length + ' 项，PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
})();
