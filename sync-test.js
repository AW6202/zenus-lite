// sync-test.js —— A 批 · 记录级同步验收（真 Edge headless，假云端，两台设备交替改）
//
// 用法：node sync-test.js
// 退出码：0 全过 / 1 有失败 / 2 环境缺件（找不到 Edge）
//
// 为什么用假云端而不是真 GitHub：要验的是**合并规则**（墓碑、时间戳、并集），
// 那部分跟网络无关；真仓库只验证「写进去的格式对不对」，一次人工验收就够。
// 假云端必须是「按文件存取 + sha」的形状，能挡住「整包覆盖」这类错误实现。

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'sync');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8802);
const CDP_PORT = Number(process.env.CDP_PORT || 9341);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '    ← ' + JSON.stringify(detail)));
}

const MIME = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__synctest.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>sync-test</title><script src="/sync.js"></script>');
    }
    const file = path.join(ROOT, u.replace(/^\/+/, ''));
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
    await sleep(1200);
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

async function evalT(cdp, body, ms) {
  let timer = null;
  const guard = new Promise((_, no) => { timer = setTimeout(() => no(new Error('超时')), ms || 60000); });
  try { return await Promise.race([cdp.eval(body), guard]); } finally { clearTimeout(timer); }
}

// 页面里用的假云端 + 两台设备（作为一段前置脚本注入）
const FIXTURE = `
  const cloud = new Map();
  let seq = 0;
  const mkTransport = () => ({
    async get(p) { const v = cloud.get(p); return v ? { content: v.content, sha: v.sha } : null; },
    async list(dir) {
      const out = [];
      for (const k of cloud.keys()) if (k.startsWith(dir + '/')) out.push({ name: k.slice(dir.length + 1), sha: cloud.get(k).sha });
      return out;
    },
    async put(p, text, sha) { seq++; const s = 'sha' + seq; cloud.set(p, { content: ZSync.b64encode(text), sha: s }); return { content: { sha: s } }; },
  });
  const book = (docId, key, name, updatedAt) => ({ docId, key, name, kind: 'epub', fingerprint: { fileHash: 'h-' + docId, convVersion: 'conv-1', promptVersion: 'clean-1' }, updatedAt: updatedAt || 0, deletedAt: null });
  const arc = { id: 'arc-1', level: 2, verdict: 'ok', playable: true, coverage: { chars: 1234, paras: 12 }, fingerprint: { fileHash: 'h', convVersion: 'conv-1', promptVersion: 'clean-1' } };
  const pos = (at, ch, dev) => ({ at, ch, ratio: 0.5, device: dev });
`;

(async () => {
  if (!fs.existsSync(EDGE)) {
    console.log('SKIP  找不到 Edge：' + EDGE);
    process.exit(2);
  }
  fs.mkdirSync(TMP, { recursive: true });
  const prof = path.join(TMP, 'prof');
  fs.rmSync(prof, { recursive: true, force: true });
  const srv = await serve();
  const base = 'http://127.0.0.1:' + PORT;
  let cdp = null;
  try {
    cdp = await CDP.launch(prof, CDP_PORT);
    await cdp.page(base + '/__synctest.html');

    const ready = await cdp.eval('return { has: typeof ZSync === "object", schema: ZSync && ZSync.SCHEMA };');
    check('ZSync 已加载', ready.has && ready.schema === 2, ready);

    // ── 1. 路径：一人一仓 / 老布局兜底 ──
    const paths = await cdp.eval('return { withPerson: ZSync.pathOf("alice", "dev-a1"), noPerson: ZSync.pathOf("", "dev-a1"), dirty: ZSync.pathOf("a/b c", "d 1") };');
    check('云端路径是 <人>/<设备>.json，没填人退回 devices/<设备>.json',
      paths.withPerson === 'alice/dev-a1.json' && paths.noPerson === 'devices/dev-a1.json'
      && paths.dirty === 'a_b_c/d_1.json', paths);

    // ── 2. 两台设备各改一本 → 两边都在（不是整包覆盖）──
    const twoBooks = await evalT(cdp, FIXTURE + `
      const t = mkTransport();
      // A 设备：有书 X 和 Y，位置在 X 第 3 章
      const aRec = {
        'doc-x': ZSync.recordOf({ doc: book('doc-x', 'key-x', '书 X'), archive: arc, position: pos(100, 3, 'dev-a'), device: 'dev-a' }),
        'doc-y': ZSync.recordOf({ doc: book('doc-y', 'key-y', '书 Y'), archive: arc, position: pos(100, 1, 'dev-a'), device: 'dev-a' }),
      };
      const ra = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: aRec, now: 100 });
      // B 设备：只有书 X，位置更早（第 1 章）；同步后应当拿到 A 的第 3 章
      const bRec = {
        'doc-x': ZSync.recordOf({ doc: book('doc-x', 'key-x', '书 X'), archive: arc, position: pos(50, 1, 'dev-b'), device: 'dev-b' }),
      };
      const rb = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-b', records: bRec, now: 200 });
      // B 又往前读到第 5 章，推上去；A 再拉
      const bRec2 = JSON.parse(JSON.stringify(rb.state.records));
      bRec2['doc-x'].position = { at: 300, ch: 5, ratio: 0.5, device: 'dev-b' };
      bRec2['doc-x'].updatedAt = 300;
      bRec2['doc-x'].history = bRec2['doc-x'].history.concat([{ at: 300, ch: 5, ratio: 0.5, device: 'dev-b' }]);
      const rb2 = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-b', records: bRec2, now: 300 });
      const aRec2 = JSON.parse(JSON.stringify(ra.state.records));
      const ra2 = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: aRec2, now: 400 });
      const files = Array.from(cloud.keys()).sort();
      return {
        files,
        bSeesX: !!rb.state.records['doc-x'],
        bSeesY: !!rb.state.records['doc-y'],
        bCh: rb.state.records['doc-x'].position.ch,
        aChAfter: ra2.state.records['doc-x'].position.ch,
        aHistory: (ra2.state.records['doc-x'].history || []).map((h) => h.ch + '@' + h.device),
        aStillHasY: !!ra2.state.records['doc-y'],
        uploaded: ra2.uploaded > 0,
      };
    `);
    check('两台设备各改一本：同步后两边都看得见（记录级，不整包覆盖）',
      twoBooks.bSeesX && twoBooks.bSeesY && twoBooks.aStillHasY, twoBooks);
    check('B 拉到 A 的位置后继续读到第 5 章，A 再拉能拿到第 5 章',
      twoBooks.bCh === 3 && twoBooks.aChAfter === 5, twoBooks);
    check('两台各自的进度都留在 history 里（不是二选一丢掉）',
      twoBooks.aHistory.includes('3@dev-a') && twoBooks.aHistory.includes('5@dev-b'), twoBooks.aHistory);
    check('每个设备只写自己的文件', twoBooks.files.join(',') === 'alice/dev-a.json,alice/dev-b.json', twoBooks.files);

    // ── 3. 删书不复活：B 删了，A 手里还有更新的位置，推上去也不能把书带回来 ──
    const tomb = await evalT(cdp, FIXTURE + `
      const t = mkTransport();
      // A 有书 Z（位置 t=100）
      const aRec = { 'doc-z': ZSync.recordOf({ doc: book('doc-z', 'key-z', '书 Z'), archive: arc, position: pos(100, 2, 'dev-a'), device: 'dev-a' }) };
      const ra = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: aRec, now: 100 });
      // B 拉到书 Z，然后删掉它（墓碑 t=500）
      let bRec = JSON.parse(JSON.stringify(ra.state.records));
      bRec['doc-z'].deleted = true;
      bRec['doc-z'].deletedAt = 500;
      bRec['doc-z'].updatedAt = 500;
      const rb = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-b', records: bRec, now: 500 });
      // A 又从自己那份旧记录推了一次（它还活着，位置更新到 t=600）
      let aRec2 = JSON.parse(JSON.stringify(ra.state.records));
      aRec2['doc-z'].position = { at: 600, ch: 4, ratio: 0.5, device: 'dev-a' };
      aRec2['doc-z'].updatedAt = 600;
      const ra2 = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: aRec2, now: 600 });
      // B 再拉一次
      const rb2 = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-b', records: rb.state.records, now: 700 });
      return {
        aAfterDelete: !!ra2.state.records['doc-z'].deleted,
        bStillDeleted: !!rb2.state.records['doc-z'].deleted,
        bTombAt: rb2.state.records['doc-z'].deletedAt,
      };
    `);
    check('删书不复活：A 手上还有更新的位置，推上去也不会把书带回来',
      tomb.aAfterDelete === true && tomb.bStillDeleted === true && tomb.bTombAt === 500, tomb);

    // ── 4. 显式复活：revivedAt 晚于 deletedAt 才认 ──
    const revive = await cdp.eval(FIXTURE + `
      const rec = { docId: 'doc-z', deleted: true, deletedAt: 500, updatedAt: 500, history: [] };
      const live = { docId: 'doc-z', deleted: false, deletedAt: null, updatedAt: 600, revivedAt: 900, position: { at: 900, ch: 4 }, history: [] };
      const older = { docId: 'doc-z', deleted: false, deletedAt: null, updatedAt: 700, position: { at: 700, ch: 3 }, history: [] };
      return {
        revived: ZSync.mergeRecord(rec, live).deleted === false,
        notRevivedByOlder: ZSync.mergeRecord(rec, older).deleted === true,
        keptTomb: ZSync.mergeRecord(rec, { docId: 'doc-z', deleted: true, deletedAt: 400, updatedAt: 400, history: [] }).deletedAt === 500,
      };
    `);
    check('只有显式复活（revivedAt > deletedAt）才算活过来，更新的「活」记录不能顶开墓碑',
      revive.revived && revive.notRevivedByOlder && revive.keptTomb, revive);

    // ── 5. 坏远端文件不能把整次同步带崩 ──
    const bad = await evalT(cdp, FIXTURE + `
      const t = mkTransport();
      cloud.set('alice/dev-bad.json', { content: ZSync.b64encode('{ 这不是 JSON'), sha: 's-bad' });
      const rec = { 'doc-q': ZSync.recordOf({ doc: book('doc-q', 'key-q', '书 Q'), archive: arc, position: pos(10, 1, 'dev-a'), device: 'dev-a' }) };
      const r = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: rec, now: 10 });
      return { ok: !!r.state.records['doc-q'], path: r.path };
    `);
    check('远端有坏 JSON 时跳过它，自己的同步照常完成', bad.ok === true && bad.path === 'alice/dev-a.json', bad);

    // ── 6. 真传输层带 ETag：第二次读到 304 不重下正文 ──
    const etag = await cdp.eval(`
      const calls = [];
      const TAG = 'W/"abc123"';
      const fakeFetch = async (url, opts) => {
        calls.push({ inm: (opts.headers && opts.headers['If-None-Match']) || '' });
        if (opts.headers && opts.headers['If-None-Match'] === TAG) {
          return { status: 304, ok: false, headers: { get: () => TAG }, json: async () => ({}) };
        }
        return {
          status: 200, ok: true,
          headers: { get: (k) => String(k).toLowerCase() === 'etag' ? TAG : null },
          json: async () => ({ content: ZSync.b64encode(JSON.stringify({ hello: 1 })), sha: 'sha-1', name: 'a.json' }),
        };
      };
      const t = ZSync.ghTransport({ token: 'x', repo: 'owner/repo', fetchImpl: fakeFetch });
      const one = await t.get('alice/dev-a.json');
      const two = await t.get('alice/dev-a.json');
      return { calls: calls.map((c) => c.inm), firstSha: one.sha, secondCached: !!two.cached, secondSha: two.sha };
    `);
    check('读取带 ETag：第一次 200、第二次发 If-None-Match 拿 304 用缓存（不吃 CDN 旧版）',
      etag.calls.length === 2 && etag.calls[1] === 'W/"abc123"' && etag.secondCached === true
      && etag.firstSha === 'sha-1' && etag.secondSha === 'sha-1', etag);

    // ── 7. 上传内容只含自己的记录 + 别人文件还在 ──
    const own = await evalT(cdp, FIXTURE + `
      const t = mkTransport();
      const aRec = { 'doc-1': ZSync.recordOf({ doc: book('doc-1', 'k1', '书 1'), archive: arc, position: pos(10, 1, 'dev-a'), device: 'dev-a' }) };
      await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-a', records: aRec, now: 10 });
      const bRec = { 'doc-2': ZSync.recordOf({ doc: book('doc-2', 'k2', '书 2'), archive: arc, position: pos(20, 2, 'dev-b'), device: 'dev-b' }) };
      const rb = await ZSync.syncNow({ transport: t, person: 'alice', device: 'dev-b', records: bRec, now: 20 });
      const aBody = JSON.parse(ZSync.b64decode(cloud.get('alice/dev-a.json').content));
      const bBody = JSON.parse(ZSync.b64decode(cloud.get('alice/dev-b.json').content));
      return {
        aFileHasOnlyOwnOrMerged: !!aBody.records['doc-1'],
        aFileAlsoGotB: !!aBody.records['doc-2'],
        bFileGotBoth: !!bBody.records['doc-1'] && !!bBody.records['doc-2'],
        files: Array.from(cloud.keys()).sort().length,
      };
    `);
    check('自己文件里带上合并结果、别人文件不被改写（各自只写自己那份）',
      own.aFileHasOnlyOwnOrMerged && own.bFileGotBoth && own.files === 2, own);

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
