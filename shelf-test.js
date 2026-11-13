// shelf-test.js —— B 批 5：书架页验收（真 Edge headless，桩桥，断言 DOM）
//
// 用法：node shelf-test.js
// 退出码：0 全过 / 1 有失败 / 2 环境缺件
//
// 验的是 §2.1/§2.2 的硬要求：
//   1. NG 书目能显示，并标「数据截至 X」
//   2. NG 不在时显示缓存并明说「显示的是缓存」（不许把旧数据装成新的）
//   3. 书和网页混排，顶部筛选（全部 / 只看书 / 只看网页）真的生效
//   4. 网页卡片带关键词 + 域名小字；浏览器里说明「要装 App 才能取 NG 书架」

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'shelf');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8804);
const CDP_PORT = Number(process.env.CDP_PORT || 9343);
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
  const now = Date.now();
  window.__shelf = {
    reply: { at: now, source: 'ng', stale: false, error: '',
      books: [
        { title: '狄公案', author: '高罗佩', chapterIndex: 11, workKey: '狄公案\\n高罗佩' },
        { title: '英文教材', author: '', chapterIndex: 0, workKey: '英文教材\\n' }
      ] },
    // B7「记下这页」的原生档案：一条能听、一条只收藏
    pages: [
      { id: 'pg-1', url: 'https://example.com/a', title: '示例网页甲', domain: 'example.com',
        text: '这是一段足够长的网页正文。'.repeat(20), chars: 260, level: 1,
        keywords: ['关键词甲', '关键词乙'] },
      { id: 'pg-2', url: 'https://example.org/b', title: '示例网页乙', domain: 'example.org',
        text: '', chars: 0, level: 4, why: '阅读模式没抽到正文', keywords: ['仅标题'] }
    ],
    calls: []
  };
  window.zenus = {
    _ls: [],
    addEventListener(_t, fn) { this._ls.push(fn); },
    _emit(msg) { this._ls.forEach((f) => f({ data: JSON.stringify(msg) })); },
    postMessage(raw) {
      let req = {};
      try { req = JSON.parse(raw); } catch (e) { return; }
      if (req.cmd === 'shelf.list') {
        window.__shelf.calls.push(req.cmd);
        return this._emit({ id: req.id, ok: true, data: window.__shelf.reply });
      }
      if (req.cmd === 'page.list') {
        window.__shelf.calls.push(req.cmd);
        return this._emit({ id: req.id, ok: true, data: window.__shelf.pages });
      }
      this._emit({ id: req.id, ok: true, data: null });
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

    // 清库，保证只看到这次的东西
    await cdp.eval(`await new Promise((r) => { const q = indexedDB.deleteDatabase('zenus_materials');`
      + ` q.onsuccess = q.onerror = q.onblocked = () => r(true); }); return true;`);

    // ── 1. NG 书目 + 数据截至 ──
    const first = await cdp.eval(`
      state.tab = 'shelf';
      await render();
      return {
        cards: view.querySelectorAll('.shelfCard').length,
        books: view.querySelectorAll('.shelfCard[data-type="book"]').length,
        webs: view.querySelectorAll('.shelfCard[data-type="web"]').length,
        banner: (view.querySelector('.banner') || {}).textContent || '',
        titles: Array.from(view.querySelectorAll('.shelfCard .st')).map((e) => e.textContent),
        chips: Array.from(view.querySelectorAll('#shelfFilters button')).map((b) => b.textContent),
        calls: window.__shelf.calls.length,
      };
    `);
    check('书架页拿到 NG 书目（2 本）+ 记下的 2 页网页',
      first.books === 2 && first.webs === 2 && first.calls >= 2, first);
    check('卡片上有书名', first.titles.join(',').includes('狄公案') && first.titles.join(',').includes('英文教材'), first.titles);
    check('顶部标「数据截至」', /数据截至/.test(first.banner) && !/缓存/.test(first.banner), first.banner);
    check('筛选三档都在', first.chips.join(',') === '全部,只看书,只看网页', first.chips);

    // ── 1b. B7：网页档案带关键词 + 域名；只收藏的明说「不能听」──
    const pages = await cdp.eval(`
      const cards = Array.from(view.querySelectorAll('.shelfCard[data-type="web"]'));
      const byTitle = (t) => cards.find((c) => c.querySelector('.st').textContent === t);
      const a = byTitle('示例网页甲');
      const b = byTitle('示例网页乙');
      return {
        aKw: a ? Array.from(a.querySelectorAll('.kw span')).map((e) => e.textContent) : [],
        aDom: a ? a.querySelector('.dom').textContent : '',
        bDom: b ? b.querySelector('.dom').textContent : '',
        bTitle: b ? b.querySelector('.st').textContent : '',
      };
    `);
    check('能听的网页卡片：AI 关键词 + 域名小字',
      pages.aKw.join(',') === '关键词甲,关键词乙' && /example\.com/.test(pages.aDom), pages);
    check('抽不到正文的卡片标「仅收藏，不能听」（不冒充可以听）',
      /仅收藏/.test(pages.bDom) && pages.bTitle === '示例网页乙', pages);

    // ── 1c. 再进一次书架不会重复誊同一页（按 url 去重）──
    const dedupe = await cdp.eval(`
      const before = view.querySelectorAll('.shelfCard[data-type="web"]').length;
      await render(); await render();
      return { before, after: view.querySelectorAll('.shelfCard[data-type="web"]').length };
    `);
    check('同一页反复拉不会重复建卡（按 url 去重）', dedupe.before === dedupe.after, dedupe);

    // ── 2. 混排：加一份网页档案，两档筛选各自生效 ──
    const mixed = await cdp.eval(`
      await ZConv.convert({
        html: '<html><head><title>示例文章</title></head><body><article><p>' + '正文第一段。'.repeat(30) + '</p>'
          + '<p>' + '正文第二段。'.repeat(30) + '</p><p>' + '正文第三段。'.repeat(30) + '</p></article></body></html>',
        name: '示例文章.html'
      });
      state.shelf.at = 0;                       // 逼它重新画一遍
      await render();
      const all = view.querySelectorAll('.shelfCard').length;
      const webCards = view.querySelectorAll('.shelfCard[data-type="web"]').length;
      const kw = Array.from(view.querySelectorAll('.shelfCard[data-type="web"] .kw span')).map((e) => e.textContent);
      const dom = (view.querySelector('.shelfCard[data-type="web"] .dom') || {}).textContent || '';
      state.shelfFilter = 'web';
      await render();
      const onlyWeb = view.querySelectorAll('.shelfCard').length;
      state.shelfFilter = 'book';
      await render();
      const onlyBook = view.querySelectorAll('.shelfCard').length;
      return { all, webCards, kw, dom, onlyWeb, onlyBook };
    `);
    check('书和网页混排（书 2 + 网页 3：原生 2 + 新建 1）', mixed.all === 5 && mixed.webCards === 3, mixed);
    check('网页卡片带关键词（没 AI 抽过就退回标题前 8 字）', mixed.kw.length >= 1 && mixed.kw[0].length <= 8, mixed.kw);
    check('「只看网页」只剩网页、「只看书」只剩书',
      mixed.onlyWeb === 3 && mixed.onlyBook === 2, mixed);

    // ── 3. NG 不在 → 显示缓存并明说 ──
    const stale = await cdp.eval(`
      window.__shelf.reply = { at: Date.now() - 3600 * 1000, source: 'cache', stale: true,
        error: '请先打开 NG（1124 连不上）', books: window.__shelf.reply.books };
      await pullShelf(true);
      state.shelfFilter = 'all';
      await render();
      const b = (view.querySelector('.banner') || {}).textContent || '';
      return { banner: b, cards: view.querySelectorAll('.shelfCard').length, stale: state.shelf.stale };
    `);
    check('NG 不在时仍显示缓存书目，并明说「显示的是缓存」+ 原因',
      stale.cards === 5 && /缓存/.test(stale.banner) && /数据截至/.test(stale.banner) && /1124/.test(stale.banner), stale);

    // ── 4. 浏览器里（没有原生桥）：说明只能看本机档案 ──
    await cdp.eval('window.zenus = undefined; return true;');
    const noNative = await cdp.eval(`
      state.shelf.at = 0;
      await render();
      return { banner: (view.querySelector('.banner') || {}).textContent || '',
               cards: view.querySelectorAll('.shelfCard').length };
    `);
    check('浏览器里说明「书要装 App 才取得到」，但本机网页档案照样显示',
      /浏览器/.test(noNative.banner) && /App/.test(noNative.banner) && noNative.cards >= 1, noNative);

    // ── 5. 档案三种看法（§3）：原文快照 / 抽字稿 / 清洗稿 ──
    const arcView = await cdp.eval(`
      const html = '<html><body><article><p>' + '这是一段没被抽到的正文。'.repeat(50) + '</p></article></body></html>';
      const r = await ZConv.convert({ html, name: '快照样本.html' }, { levels: [2, 3, 4] });
      await openArchiveViewer(r.archive.docId);
      const o = document.getElementById('arcOverlay');
      const tabs = Array.from(o.querySelectorAll('.arcTab')).map((b) => ({ k: b.dataset.k, text: b.textContent, disabled: b.disabled }));
      const body1 = document.getElementById('arcBody').textContent;
      // 切到抽字稿
      o.querySelector('.arcTab[data-k="text"]').click();
      const body2 = document.getElementById('arcBody').textContent;
      return { level: r.archive.level, tabs, body1: body1.slice(0, 40), body2: body2.slice(0, 40),
               hasHint: /听的时候不能切/.test(o.textContent) };
    `);
    check('三种看法：三档都在，第 4 级只有「原文」可用（另两档禁用）',
      arcView.level === 4 && arcView.tabs.length === 3
      && arcView.tabs.find((t) => t.k === 'source').disabled === false
      && arcView.tabs.find((t) => t.k === 'text').disabled === true
      && arcView.tabs.find((t) => t.k === 'ai').disabled === true, arcView);
    check('原文视图显示的是快照正文（剥掉标签），禁用的档点不动',
      /没被抽到的正文/.test(arcView.body1) && !/<p>/.test(arcView.body1)
      && arcView.body2 === arcView.body1, arcView);
    check('界面写明「听的时候不能切视图」', arcView.hasHint === true, arcView);

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
