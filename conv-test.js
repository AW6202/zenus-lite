// conv-test.js —— A 批 · 文本档案 + 转换管线验收（真 Edge headless，真文件，断言数据不看感觉）
//
// 用法：
//   node conv-test.js                      # 跑全部（语料见 testdata/conv-corpus.json）
//   node conv-test.js --pages 4            # 覆盖每份的 maxPages
//   node conv-test.js --only Read          # 只跑文件名含 "Read" 的
//   node conv-test.js --corpus 别的.json
//
// 退出码：0 全过 / 1 有失败 / 2 环境缺件（找不到 Edge）
//
// 为什么要有它：转换管线的坏法是「安静地少抽一半」，页面照样能翻、照样能朗读。
// 只有把覆盖率 / 失败页 / 判定全部断言出来，才知道它是不是真的抽全了。

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'conv');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8801);
const CDP_PORT = Number(process.env.CDP_PORT || 9340);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '    ← ' + JSON.stringify(detail)));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pages') out.pages = Number(argv[++i]);
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--corpus') out.corpus = argv[++i];
  }
  return out;
}

// ── 静态服务器：仓库文件 + 语料（按序号映射到本机真实路径）──────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json',
};

function serve(corpus) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/__convtest.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta charset="utf-8"><title>conv-test</title>'
        + '<script src="/conv.js"></script>');
    }
    const m = /^\/corpus\/(\d+)$/.exec(u);
    if (m) {
      const f = corpus[Number(m[1])];
      if (!f || !fs.existsSync(f.path)) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return fs.createReadStream(f.path).pipe(res);
    }
    const rel = u.replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve(srv)));
}

// ── 极简 CDP 客户端（node 自带 WebSocket）──────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async launch(profile, port) {
    const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=' + port,
      '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
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
      const msg = JSON.parse(ev.data);
      const p = msg.id && c.pend.get(msg.id);
      if (!p) return;
      c.pend.delete(msg.id);
      msg.error ? p.no(new Error(msg.error.message)) : p.ok(msg.result);
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
      expression: '(async () => { ' + body + ' })()', awaitPromise: true, returnByValue: true, userGesture: true,
    }, this.sid);
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description
        || r.exceptionDetails.text || '页面执行失败');
    }
    return r.result.value;
  }
  close() { try { this.proc.kill(); } catch { /* 已退出 */ } }
}

async function evalT(cdp, body, ms) {
  let timer = null;
  const guard = new Promise((_, no) => {
    timer = setTimeout(() => no(new Error('超时 ' + Math.round(ms / 1000) + ' 秒没回话')), ms || 300000);
  });
  try { return await Promise.race([cdp.eval(body), guard]); } finally { clearTimeout(timer); }
}

const SRC_SET = ['dom', 'text', 'ocr', 'ai'];

// ── 主流程 ─────────────────────────────────────────
(async () => {
  if (!fs.existsSync(EDGE)) {
    console.log('SKIP  找不到 Edge：' + EDGE + '（设 EDGE 环境变量指向 msedge.exe）');
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));
  const corpusPath = args.corpus || path.join(ROOT, 'testdata', 'conv-corpus.json');
  if (!fs.existsSync(corpusPath)) {
    console.log('FAIL  找不到语料清单：' + corpusPath);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const files = manifest.files.filter((f) => !args.only || f.name.includes(args.only));
  if (!files.length) { console.log('FAIL  语料清单是空的'); process.exit(1); }

  fs.mkdirSync(TMP, { recursive: true });
  const prof = path.join(TMP, 'prof');
  fs.rmSync(prof, { recursive: true, force: true });        // 每次从干净的浏览器状态开始

  const srv = await serve(files);
  const base = 'http://127.0.0.1:' + PORT;
  let cdp = null;
  const rows = [];
  try {
    cdp = await CDP.launch(prof, CDP_PORT);
    await cdp.page(base + '/__convtest.html');

    const ready = await cdp.eval('return { has: typeof ZConv === "object", conv: ZConv && ZConv.CONV_VERSION, th: ZConv && ZConv.thresholds() };');
    check('ZConv 已加载，转换器版本与阈值可读',
      ready.has && !!ready.conv && !!ready.th && ready.th.minChars > 0, ready);

    // 干净库：同一台机器重复跑要能重现同一份覆盖率
    await cdp.eval('await new Promise((r) => { const q = indexedDB.deleteDatabase("zenus_materials");'
      + ' q.onsuccess = q.onerror = q.onblocked = () => r(true); }); return true;');

    // ── 1. 逐份转 + 断言档案结构 / 覆盖率 / 判定 ──
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!fs.existsSync(f.path)) { check('语料存在：' + f.name, false, { path: f.path }); continue; }
      const maxPages = args.pages || f.maxPages || 0;
      const t0 = Date.now();
      let out = null;
      try {
        out = await evalT(cdp, `
          const buf = await (await fetch('/corpus/${i}')).arrayBuffer();
          const r = await ZConv.convert({ bytes: new Uint8Array(buf), name: ${JSON.stringify(f.name)} },
            { maxPages: ${maxPages} });
          const back = await ZConv.arcCurrent(r.archive.docId);
          const srcs = {};
          for (const p of r.archive.paragraphs) srcs[p.src] = (srcs[p.src] || 0) + 1;
          return {
            kind: r.archive.kind, level: r.archive.level, verdict: r.archive.verdict,
            playable: r.archive.playable, coverage: r.archive.coverage, paras: r.archive.paragraphs.length,
            srcs, fp: r.archive.fingerprint, report: r.report,
            roundTrip: !!back && back.id === r.archive.id,
            first: ((r.archive.paragraphs[0] || {}).text || '').slice(0, 60),
            lang: r.archive.lang,
          };
        `, 300000);
      } catch (e) {
        check(f.name + ' 转换', false, { err: e.message });
        rows.push({ name: f.name, err: e.message });
        continue;
      }
      const cov = out.coverage || {};
      const ms = Date.now() - t0;
      rows.push({
        name: f.name, kind: out.kind, level: out.level, verdict: out.verdict,
        playable: out.playable, pages: cov.pages, pagesOk: cov.pagesOk, pagesFail: cov.pagesFail,
        chars: cov.chars, paras: out.paras, lang: out.lang, ms,
        srcs: out.srcs, first: out.first, reasons: cov.reasons || [], failPages: cov.failPages || [],
      });
      const srcSum = Object.values(out.srcs).reduce((a, b) => a + b, 0);
      const srcBad = Object.keys(out.srcs).filter((s) => !SRC_SET.includes(s));
      check(f.name + ' 档案落库 + 段落都有来源标',
        out.roundTrip && out.paras > 0 && srcSum === out.paras && srcBad.length === 0, {
          roundTrip: out.roundTrip, paras: out.paras, srcSum, srcBad, srcs: out.srcs,
        });
      check(f.name + ' 指纹齐全（文件 hash + 转换器版本 + 清洗提示词版本）',
        typeof out.fp.fileHash === 'string' && out.fp.fileHash.length === 64
        && !!out.fp.convVersion && !!out.fp.promptVersion, { fp: out.fp });
      check(f.name + ' 覆盖率 / 失败页 / 转换时间 / 判定都在报告里',
        cov.pages > 0 && typeof cov.ms === 'number'
        && ['覆盖：', '指纹：', '判定：'].every((k) => String(out.report).indexOf(k) >= 0),
        { report: String(out.report).split('\n').slice(0, 6) });
      if (f.expect === 'ok') {
        check(f.name + ' 应当可听（expect=ok）', out.playable === true, { verdict: out.verdict, reasons: cov.reasons });
      } else if (f.expect === 'partial') {
        check(f.name + ' 只转了部分页 → 必须标「还没转完」，不许冒充整本',
          out.playable === false && cov.partial === true && cov.docPages > cov.pages, {
            verdict: out.verdict, pages: cov.pages, docPages: cov.docPages, partial: cov.partial,
          });
      } else if (f.expect === 'incomplete') {
        check(f.name + ' 应当标红（expect=incomplete）', out.playable === false, { verdict: out.verdict });
      }
    }

    // ── 2. 负向：去掉第 1 级 → 必须报红 ──
    // 拿「本来能听的那份 HTML」做对照：去掉第 1 级它就必须掉到第 4 级并报红。
    const htmlRow = rows.find((r) => r.kind === 'html' && r.playable === true);
    const htmlIdx = htmlRow
      ? files.findIndex((f) => f.name === htmlRow.name)
      : files.findIndex((f) => /\.html?$/i.test(f.name));
    if (htmlIdx >= 0) {
      const rowOk = htmlRow || rows.find((r) => r.name === files[htmlIdx].name);
      const neg = await evalT(cdp, `
        const buf = await (await fetch('/corpus/${htmlIdx}')).arrayBuffer();
        const r = await ZConv.convert({ bytes: new Uint8Array(buf), name: ${JSON.stringify(files[htmlIdx].name)} },
          { levels: [2, 3, 4] });
        return { level: r.archive.level, verdict: r.archive.verdict, playable: r.archive.playable,
                 reasons: r.archive.coverage.reasons, paras: r.archive.paragraphs.length,
                 snapshotChars: (r.archive.snapshot && r.archive.snapshot.text || '').length,
                 sourceChars: ZConv.sourceText(r.archive).length,
                 report: r.report };
      `, 120000);
      check('负向：去掉第 1 级 → HTML 掉到第 4 级且报红（不许拿剥标签冒充抽字）',
        neg.level === 4 && neg.verdict !== 'ok' && neg.playable === false, neg);
      check('第 4 级留了原文快照（只能看不能听，报告里写明）',
        neg.snapshotChars > 0 && neg.sourceChars === neg.snapshotChars && /原文：留了快照/.test(neg.report), neg);
      check('对照：同一份 HTML 带第 1 级时是可听的',
        !!rowOk && rowOk.playable === true && rowOk.level === 1, rowOk || {});
    } else {
      // 只跑单份（--only）时语料里可能没有 HTML，这时跳过，不算失败
      if (args.only) console.log('SKIP  负向测试：这次过滤后没有 HTML 语料');
      else check('语料里要有 1 份 HTML（负向测试要用）', false, { files: files.map((f) => f.name) });
    }

    // ── 3. 分批：暂停后能续跑，续完页数对得上 ──
    const bigIdx = rows.findIndex((r) => r.kind === 'pdf' && r.pages >= 3);
    if (bigIdx >= 0) {
      const bigName = rows[bigIdx].name;
      const idx = files.findIndex((f) => f.name === bigName);
      const pr = await evalT(cdp, `
        // pdf.js 会接管（detach）传进去的 ArrayBuffer，续跑要重新取一份
        const b1 = await (await fetch('/corpus/${idx}')).arrayBuffer();
        const b2 = await (await fetch('/corpus/${idx}')).arrayBuffer();
        const name = ${JSON.stringify(bigName)};
        const first = await ZConv.convert({ bytes: new Uint8Array(b1), name }, { maxPages: 2 });
        const resumed = await ZConv.convert({ bytes: new Uint8Array(b2), name },
          { resume: first.archive, maxPages: 0 });
        const pg = (resumed.archive.pages || []).map((p) => p.i);
        const uniq = new Set(pg).size === pg.length;
        return { partial: first.archive.partial, nextPage: first.archive.nextPage,
                 playable1: first.archive.playable, verdict1: first.archive.verdict,
                 pages1: first.archive.coverage.pages, pages2: resumed.archive.coverage.pages,
                 total: resumed.archive.coverage.pages, playable2: resumed.archive.playable,
                 verdict2: resumed.archive.verdict, uniq };
      `, 300000);
      check('分批：第一次停在 2 页，标 partial 且不能听',
        pr.partial === true && pr.nextPage === 3 && pr.playable1 === false, pr);
      check('续跑：接着抽完，页数连续不重复、判定重算',
        pr.pages2 > pr.pages1 && pr.uniq === true, pr);
    }

    // ── 4. 负向：字数太少必须标 incomplete ──
    const tiny = await evalT(cdp, `
      const r = await ZConv.convert({ text: '只有几个字。', name: 'tiny.txt', kind: 'txt' });
      return { verdict: r.archive.verdict, playable: r.archive.playable,
               reasons: r.archive.coverage.reasons, level: r.archive.level };
    `, 60000);
    check('负向：字数太少 → incomplete 且不能听（不许显示成可以听）',
      tiny.verdict === 'incomplete' && tiny.playable === false && (tiny.reasons || []).length > 0, tiny);

    // ── 5. 三种看法：AI 清洗稿另存，抽字稿不动 ──
    const views = await evalT(cdp, `
      const docs = await ZConv.docAll();
      const doc = docs.find((d) => d.archiveIds && d.archiveIds.length) || docs[0];
      const arc = await ZConv.arcCurrent(doc.docId);
      const cleaned = await ZConv.applyClean(arc, ['第一段清洗稿。', '第二段清洗稿。']);
      const ai = ZConv.paragraphsOf(cleaned, 'ai');
      const txt = ZConv.paragraphsOf(cleaned, 'text');
      const again = await ZConv.arcGet(cleaned.id);
      return { ai: ai.length, aiSrc: Array.from(new Set(ai.map((p) => p.src))),
               text: txt.length, orig: arc.paragraphs.length, persisted: again.clean.paragraphs.length };
    `, 60000);
    check('三种看法：清洗稿落盘、每段标 ai、抽字稿不被覆盖',
      views.ai === 2 && views.aiSrc.length === 1 && views.aiSrc[0] === 'ai'
      && views.text === views.orig && views.persisted === 2, views);

    // ── 6. 覆盖前先留旧档（同一份重跑两次 → 旧档还在）──
    const hist = await evalT(cdp, `
      const name = 'hist.txt';
      const text = '第一段足够长的正文，用来让判定通过。'.repeat(6) + '\\n\\n' + '第二段也是正文。'.repeat(6) + '\\n\\n' + '第三段收尾。'.repeat(6);
      const a = await ZConv.convert({ text, name, kind: 'txt' });
      const b = await ZConv.convert({ text, name, kind: 'txt' });
      const doc = await ZConv.docGet(a.archive.docId);
      const old = await ZConv.arcGet(doc.archiveIds[0]);
      const cur = await ZConv.arcCurrent(doc.docId);
      return { ids: doc.archiveIds.length, oldKept: !!old, curIsNewest: cur.id === doc.archiveIds[doc.archiveIds.length - 1],
               verdict: b.archive.verdict };
    `, 60000);
    check('重跑：旧档留着、当前指针指向最新一版',
      hist.ids === 2 && hist.oldKept === true && hist.curIsNewest === true, hist);

    // ── 7. 逐页 OCR 并进档案（A3：材料页「转文字」的落库口径）──
    const ocrPages = await evalT(cdp, `
      const key = 'ocr-fixture.pdf';
      const lorem = '這是一頁掃描件的辨識結果，字數要夠多才算抽到。';
      const p1 = await ZConv.upsertPageText({ key, name: '扫描件.pdf', kind: 'pdf', page: 1,
        lines: [lorem.repeat(3), lorem.repeat(3), lorem.repeat(3)], ms: 2100, total: 2, lang: 'zh' });
      const p2 = await ZConv.upsertPageText({ key, name: '扫描件.pdf', kind: 'pdf', page: 2,
        lines: [lorem.repeat(3), lorem.repeat(3), lorem.repeat(3)], ms: 1900, total: 2, lang: 'zh' });
      const again = await ZConv.upsertPageText({ key, name: '扫描件.pdf', kind: 'pdf', page: 1,
        lines: ['重抽这一页第一句。'.repeat(3), '重抽这一页第二句。'.repeat(3), '重抽这一页第三句。'.repeat(3)],
        ms: 800, total: 2, lang: 'zh' });
      const srcs = Array.from(new Set(again.archive.paragraphs.map((p) => p.src)));
      const page1 = again.archive.paragraphs.filter((p) => p.page === 1).length;
      return {
        level: again.archive.level,
        pages: again.archive.coverage.pages,
        docPages: again.archive.coverage.docPages,
        verdict: again.archive.verdict,
        srcs,
        page1Paras: page1,
        totalParas: again.archive.paragraphs.length,
        report: again.report,
        playable: again.archive.playable,
      };
    `, 60000);
    check('OCR 逐页并进档案：每段标 ocr、页数正确、能听',
      ocrPages.level === 3 && ocrPages.pages === 2 && ocrPages.srcs.length === 1 && ocrPages.srcs[0] === 'ocr'
      && ocrPages.verdict === 'ok' && ocrPages.playable === true, ocrPages);
    check('同一页重转是「替换」不是「追加」',
      ocrPages.page1Paras === 3 && ocrPages.totalParas === 6, ocrPages);
    check('OCR 档案的报告里带覆盖率与失败页数',
      /覆盖：2\/2 页/.test(ocrPages.report) && /失败 0 页/.test(ocrPages.report), ocrPages.report);

    // ── 报告文件 + 表格 ──
    fs.writeFileSync(path.join(TMP, 'report.json'), JSON.stringify({ at: new Date().toISOString(), rows, results }, null, 2));
    console.log('');
    console.log('── 覆盖率报告（§7 判据：10 份真实文件）────────────────────────────');
    const pad = (s, n) => { s = String(s == null ? '' : s); return s + ' '.repeat(Math.max(0, n - [...s].length)); };
    console.log(pad('材料', 30) + pad('级', 4) + pad('页 ok/全部', 12) + pad('字数', 8) + pad('段', 6) + pad('判定', 12) + '用时');
    for (const r of rows) {
      if (r.err) { console.log(pad(r.name, 30) + '转换失败：' + r.err); continue; }
      console.log(pad(r.name, 30) + pad(r.level, 4) + pad(r.pagesOk + '/' + r.pages, 12)
        + pad(r.chars, 8) + pad(r.paras, 6) + pad(r.verdict + (r.playable ? '(可听)' : ''), 12)
        + (r.ms / 1000).toFixed(1) + 's');
    }
    console.log('──────────────────────────────────────────────────────────────');
    console.log('详细 JSON：' + path.join(TMP, 'report.json'));
  } catch (err) {
    check('跑完整个流程', false, { err: err.message, stack: String(err.stack || '').slice(0, 600) });
  } finally {
    if (cdp) cdp.close();
    srv.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('共 ' + results.length + ' 项，PASS ' + (results.length - failed.length) + ' / FAIL ' + failed.length);
  process.exit(failed.length ? 1 : 0);
})();
