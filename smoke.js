// smoke.js —— 阅读器冒烟 Gate：真浏览器（本机 Edge headless）+ 真文件，断言 DOM，不靠肉眼看。
//
// 用法：node smoke.js                 # 跑全部检查（PDF 一项自动跳过）
//       node smoke.js --pdf x.pdf    # 额外验 PDF 回归
// 退出码：0 全过 / 1 有失败 / 2 环境缺件（找不到 Edge）
//
// 为什么要有它：阅读器是「错了也看不出来」的那类代码——排版退化不会报错，
// 只有把 DOM 断言出来才拦得住（2026-10-29 EPUB 退化成纯文本，就是这么漏掉的）。

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP = path.join(ROOT, '.scratch', 'smoke');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PORT || 8799);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 断言账本 ────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '   ← ' + JSON.stringify(detail)}`);
}

// ── 静态服务器（不起 python，少一个依赖）──────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.epub': 'application/epub+zip',
  '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf' };
function serve() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((res) => srv.listen(PORT, '127.0.0.1', () => res(srv)));
}

// ── 测试用书：一本书要把「标题/段落/强调/列表/引用/图/表/脚注/换行」全放进去 ──
async function makeFixtures(pdfPath, scanPath) {
  const JSZip = require(path.join(ROOT, 'vendor', 'jszip.min.js'));
  fs.mkdirSync(TMP, { recursive: true });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const ch1 = `<html><head><meta charset="utf-8"/><style>p{margin:0}</style>
<script>console.log("SHOULD_BE_STRIPPED")</script></head><body>
<h1>第一章　河流与铁桥</h1>
<p class="calibre1">The river was <em>narrow</em> and the bridge <strong>old</strong>.</p>
<div><div><p>被两层 div 包起来的段落。</p></div></div>
<h2>小标题</h2><ul><li>列表一</li><li>列表二</li></ul>
<blockquote>引用块</blockquote>
<p><img src="images/pic.png" alt="示意图"/></p>
<table><tr><td>词</td><td>释义</td></tr></table>
<p onclick="alert(1)">短句。</p>
</body></html>`;

  // 这一章要够长才能滚到底——「选区贴底 → 弹框翻上」这条断言必须有可滚动的空间
  const filler = Array.from({ length: 24 }, (_, i) => `<p>填充段落 ${i + 1}：用来把正文撑过一屏。</p>`).join('\n');
  const ch2 = `<html><head><meta charset="utf-8"/></head><body>
<h1>第二章　雨季</h1>
<p>雨季来得比往年早。<br/>这一行必须换行。</p>
<p>脚注<sup><a href="#fn1">1</a></sup>。<a href="ch1.xhtml">跨章链接</a></p>
${filler}
<p>最后一段，用来在视口底部验证弹框翻上。</p>
</body></html>`;

  const opf = `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="pic" href="images/pic.png" media-type="image/png"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`;

  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml',
    `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/ch1.xhtml', ch1);
  zip.file('OEBPS/ch2.xhtml', ch2);
  zip.file('OEBPS/images/pic.png', png);
  fs.writeFileSync(path.join(TMP, 'smoke.epub'), await zip.generateAsync({ type: 'nodebuffer' }));

  fs.writeFileSync(path.join(TMP, 'smoke.md'),
    '# 读法笔记\n\n含 **粗体**、*斜体*、`code` 的一段。\n\n## 一、结论\n\n- 项一\n- 项二\n\n1. 步骤一\n2. 步骤二\n\n> 引用\n\n```js\nconst x = 1;\n```\n');

  // GBK + 无空行（中文 txt 小说最典型的形态）
  const lines = ['第一章 山雨'];
  for (let i = 1; i <= 120; i++) lines.push(`第${i}行：整本书没有空行分隔，只靠换行。`);
  fs.writeFileSync(path.join(TMP, 'smoke-gbk.txt'), encodeGbk(lines.join('\r\n')));

  // DOCX：标题样式切章 / 自动编号 / 自带编号不加符号 / 数据表保留 / 版式表拍平 / 图片
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const para = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}`
    + `<w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const cell = (t) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const dataTbl = `<w:tbl><w:tr>${cell('词')}${cell('释义')}</w:tr><w:tr>${cell('narrow')}${cell('狭窄的')}</w:tr></w:tbl>`;
  const layoutTbl = `<w:tbl><w:tr><w:tc>${para('版式表左格')}${para('版式表左格二')}</w:tc><w:tc></w:tc></w:tr></w:tbl>`;
  const docXml = `${HEAD}<w:document ${NS}><w:body>`
    + para('一级标题　制度', '2')
    + para('正文第一段，含 **不该出现的星号**。')
    + `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>加粗一句</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>自动编号项</w:t></w:r></w:p>`
    + `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>2.1 自带编号的条款</w:t></w:r></w:p>`
    + dataTbl + layoutTbl
    + `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rIdImg"/></w:drawing></w:r></w:p>`
    + para('二级标题　变更', '3')
    + para('第二章正文。')
    + '</w:body></w:document>';
  const stylesXml = `${HEAD}<w:styles ${NS}>`
    + '<w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="3"><w:name w:val="heading 3"/></w:style></w:styles>';
  const relsXml = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pic.png"/></Relationships>`;
  const dzip = new JSZip();
  dzip.file('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`);
  dzip.file('word/document.xml', docXml);
  dzip.file('word/styles.xml', stylesXml);
  dzip.file('word/_rels/document.xml.rels', relsXml);
  dzip.file('word/media/pic.png', png);
  fs.writeFileSync(path.join(TMP, 'smoke.docx'), await dzip.generateAsync({ type: 'nodebuffer' }));

  fs.writeFileSync(path.join(TMP, 'smoke-nofont.pdf'), makeNoFontPdf());
  fs.writeFileSync(path.join(TMP, 'smoke-outline.pdf'), makeOutlinePdf());
  if (pdfPath) fs.copyFileSync(pdfPath, path.join(TMP, 'smoke.pdf'));
  if (scanPath) fs.copyFileSync(scanPath, path.join(TMP, 'smoke-scan.pdf'));
}

// 造一个「带书签（outline）」的最小 PDF：用来验证目录导航
function makeOutlinePdf() {
  const NL = String.fromCharCode(10);
  const page = (extra) => '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] '
    + '/Resources << /Font << /F1 9 0 R >> >> ' + extra + ' >>';
  const content1 = 'BT /F1 18 Tf 40 120 Td (Page One) Tj ET';
  const content2 = 'BT /F1 18 Tf 40 120 Td (Page Two) Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    page('/Contents 10 0 R'),
    page('/Contents 11 0 R'),
    '<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>',
    '<< /Title (Chapter One) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>',
    '<< /Title (Chapter Two) /Parent 5 0 R /Prev 6 0 R /Next 8 0 R /Dest [4 0 R /Fit] >>',
    '<< /Title (Chapter Two again) /Parent 5 0 R /Prev 7 0 R /Dest [1 /Fit] >>',
    '<< /Font /F1 10 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + content1.length + ' >>' + NL + 'stream' + NL + content1 + NL + 'endstream',
    '<< /Length ' + content2.length + ' >>' + NL + 'stream' + NL + content2 + NL + 'endstream',
  ];
  let out = '%PDF-1.7' + NL;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj' + NL + body + NL + 'endobj' + NL;
  });
  const xref = out.length;
  out += 'xref' + NL + '0 ' + (objs.length + 1) + NL + '0000000000 65535 f' + NL;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n' + NL;
  out += 'trailer' + NL + '<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>' + NL;
  out += 'startxref' + NL + xref + NL + '%%EOF' + NL;
  return Buffer.from(out, 'latin1');
}


// 手搓最小 PDF：Type0 + CIDFontType2 + UniGB-UCS2-H，且不带 /FontFile（= 中文必然画不出来）
function makeNoFontPdf() {
  const NL = String.fromCharCode(10);
  const content = 'BT /F1 14 Tf 20 150 Td <4E2D6587> Tj ET';   // 「中文」的 UCS-2 码
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + content.length + ' >>' + NL + 'stream' + NL + content + NL + 'endstream',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
  ];
  let out = '%PDF-1.7' + NL;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj' + NL + body + NL + 'endobj' + NL;
  });
  const xref = out.length;
  out += 'xref' + NL + '0 ' + (objs.length + 1) + NL + '0000000000 65535 f' + NL;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n' + NL;
  out += 'trailer' + NL + '<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>' + NL;
  out += 'startxref' + NL + xref + NL + '%%EOF' + NL;
  return Buffer.from(out, 'latin1');
}

// Node 只能解 GBK、不能编 GBK：把解码器反过来用，造一张「字 → 字节」表
function encodeGbk(str) {
  const dec = new TextDecoder('gb18030');
  const map = new Map();
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x40; lo <= 0xfe; lo++) {
      if (lo === 0x7f) continue;
      const s = dec.decode(Uint8Array.from([hi, lo]));
      if (s.length === 1 && s !== '�' && !map.has(s)) map.set(s, [hi, lo]);
    }
  }
  const out = [];
  for (const ch of str) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) { out.push(code); continue; }
    const pair = map.get(ch);
    if (!pair) throw new Error('GBK 表里没有这个字：' + ch);
    out.push(pair[0], pair[1]);
  }
  return Buffer.from(out);
}

// ── 极简 CDP 客户端（node 24 自带 WebSocket）─────────
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async launch(profile) {
    const proc = spawn(EDGE, ['--headless=new', '--remote-debugging-port=9339', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:9339/json/version')).json(); }
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
  async page(url, { width = 390, height = 844 } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sid = sessionId;
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 2, mobile: true }, sessionId);
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    await sleep(1500);
  }
  async eval(body) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true, userGesture: true,
    }, this.sid);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() { try { this.proc.kill(); } catch { /* 已退出 */ } }
}

// ── 主流程 ──────────────────────────────────────────
(async () => {
  if (!fs.existsSync(EDGE)) {
    console.log('SKIP  找不到 Edge：' + EDGE + '（设 EDGE 环境变量指向 msedge.exe）');
    process.exit(2);
  }
  const pdfArg = process.argv.includes('--pdf') ? process.argv[process.argv.indexOf('--pdf') + 1] : null;
  const scanArg = process.argv.includes('--pdf-scan') ? process.argv[process.argv.indexOf('--pdf-scan') + 1] : null;
  await makeFixtures(pdfArg, scanArg);
  const srv = await serve();
  const base = `http://127.0.0.1:${PORT}/.scratch/smoke/`;
  const prof = path.join(TMP, 'prof');
  fs.rmSync(prof, { recursive: true, force: true });

  const cdp = await CDP.launch(prof);
  // 页面里抛错（element 不存在等）不能把整份冒烟崩掉：记一条 FAIL，接着跑下一项
  const probe = async (label, js) => {
    try { return await cdp.eval(js); }
    catch (e) { check(label + ' → 页面执行失败', false, { err: e.message }); return {}; }
  };
  try {
    await cdp.page(`http://127.0.0.1:${PORT}/index.html`);

    // A. EPUB 结构渲染
    const epub = await probe('EPUB 渲染', `
      state.tab = 'reader'; render();
      const b = await (await fetch('${base}smoke.epub')).blob();
      await openEpubBook(new File([b], 'smoke.epub'));
      await new Promise(r => setTimeout(r, 600));
      const box = document.querySelector('.bookText');
      const q = (s) => box.querySelectorAll(s).length;
      const img = box.querySelector('img');
      return {
        kind: RDR.kind, h1: q('h1'), h2: q('h2'), li: q('li'), blockquote: q('blockquote'),
        table: q('table'), em: q('em'), strong: q('strong'),
        img: q('img'), imgLoaded: img ? img.naturalWidth : 0,
        script: (document.body.innerHTML.match(/SHOULD_BE_STRIPPED/) || []).length,
        taint: [/class=/, /style=/, /onclick=/, /javascript:/].filter(re => re.test(box.innerHTML)).length,
        h1Bigger: (() => {
          const fs_ = (s) => { const el = box.querySelector(s); return el ? parseFloat(getComputedStyle(el).fontSize) : 0; };
          return fs_('h1') > fs_('p');
        })(),
      };
    `);
    check('EPUB 标题/列表/引用/表格/强调 都渲染出来了',
      epub.h1 === 1 && epub.h2 === 1 && epub.li === 2 && epub.blockquote === 1 && epub.table === 1
      && epub.em === 1 && epub.strong === 1, epub);
    check('EPUB 标题字号大于正文', epub.h1Bigger, epub);
    check('EPUB 图片从 zip 里取出并加载成功', epub.img === 1 && epub.imgLoaded > 0, epub);
    check('EPUB 脚本/事件/样式被清掉', epub.script === 0 && epub.taint === 0, epub);

    // B. 换行与脚注没丢
    const ch2 = await probe('EPUB 章内结构', `
      gotoChapter(1); await new Promise(r => setTimeout(r, 200));
      const box = document.querySelector('.bookText');
      return { br: box.querySelectorAll('br').length, sup: box.querySelectorAll('sup').length,
               title: RDR.book.chapters[1].title };
    `);
    check('EPUB 章内 <br> 换行保留', ch2.br === 1, ch2);
    check('EPUB 脚注上标保留', ch2.sup === 1, ch2);

    // B2. 阅读进度：关掉再打开要回到上次的章
    const pos = await probe('阅读进度', `
      const b = await (await fetch('${base}smoke.epub')).blob();
      const f1 = new File([b], 'smoke.epub');
      await openEpubBook(f1);
      await new Promise(r => setTimeout(r, 500));
      gotoChapter(1);
      await new Promise(r => setTimeout(r, 300));
      const savedCh = readPositions[RDR.key] ? readPositions[RDR.key].ch : null;
      document.getElementById('closeBook').click();
      await new Promise(r => setTimeout(r, 300));
      await openEpubBook(new File([b], 'smoke.epub'));
      await new Promise(r => setTimeout(r, 600));
      return { savedCh, reopened: RDR.ch };
    `);
    check('关掉再打开回到上次读的章', pos.savedCh === 1 && pos.reopened === 1, pos);

    // C. 选中弹框位置：中部选区在下方，底部选区翻到上方
    const bar = await probe('选中弹框', `
      if (RDR.paged) togglePaged();                 // 分页模式下没有纵向滚动，这条要用滚动模式测
      await new Promise(r => setTimeout(r, 400));
      const ps = [...document.querySelectorAll('.bookText p')].filter(p => p.textContent.trim().length > 3);
      const probe = async (el, block) => {
        el.scrollIntoView({ block });
        await new Promise(r => setTimeout(r, 250));
        const rg = document.createRange(); rg.selectNodeContents(el);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
        await new Promise(r => setTimeout(r, 350));
        const b = document.getElementById('selTools');
        if (!b) return { shown: false };
        const br = b.getBoundingClientRect(), sr = sel.getRangeAt(0).getBoundingClientRect();
        return { shown: true,
          below: br.top >= sr.bottom - 1, above: br.bottom <= sr.top + 1,
          inViewport: br.top >= 0 && br.bottom <= innerHeight,
          gap: Math.round(br.top - sr.bottom) };
      };
      const mid = await probe(ps[0], 'center');
      const bottom = await probe(ps[ps.length - 1], 'end');
      getSelection().removeAllRanges();
      return { mid, bottom };
    `);
    const m = bar.mid || {}, bt = bar.bottom || {};
    check('选区在页面中部时，弹框在文字下方', !!m.shown && !!m.below, m);
    check('选区贴屏幕底部时，弹框翻到上方且不出界', !!bt.shown && !!bt.above && !!bt.inViewport, bt);

    // D. Markdown
    const md = await probe('Markdown', `
      const b = await (await fetch('${base}smoke.md')).blob();
      await openTextBook(new File([b], 'smoke.md'));
      await new Promise(r => setTimeout(r, 400));
      const titles = RDR.book.chapters.map(c => c.title);
      gotoChapter(1); await new Promise(r => setTimeout(r, 150));
      const box = document.querySelector('.bookText');
      const q = (s) => box.querySelectorAll(s).length;
      return { titles, ul: q('ul'), ol: q('ol'), pre: q('pre'), blockquote: q('blockquote'),
               raw: /^\\s*(#{1,3}\\s|\\*\\*)/m.test(box.textContent) || /\\u0060{3}/.test(box.textContent) };
    `);
    check('MD 按一级标题切章', md.titles.length === 2 && md.titles[1] === '一、结论', md);
    check('MD 列表/引用/代码块渲染出来', md.ul === 1 && md.ol === 1 && md.pre === 1 && md.blockquote === 1, md);
    check('MD 没有残留原始标记', md.raw === false, md);

    // E. GBK 纯文本
    const txt = await probe('GBK 文本', `
      const b = await (await fetch('${base}smoke-gbk.txt')).blob();
      await openTextBook(new File([b], 'smoke-gbk.txt'));
      await new Promise(r => setTimeout(r, 300));
      const box = document.querySelector('.bookText');
      return { kind: RDR.kind, ps: box.querySelectorAll('p').length,
               mojibake: /\\uFFFD|锟斤拷/.test(box.textContent),
               head: box.textContent.replace(/\\s+/g, ' ').slice(0, 30) };
    `);
    check('GBK txt 不乱码', txt.mojibake === false && txt.head.indexOf('第一章 山雨') === 0, txt);
    check('无空行 txt 按行分段', txt.ps > 100, txt);

    // F. DOCX
    const docx = await probe('DOCX', `
      const b = await (await fetch('${base}smoke.docx')).blob();
      await openDocxBook(new File([b], 'smoke.docx'));
      await new Promise(r => setTimeout(r, 500));
      const box = document.querySelector('.bookText');
      const q = (s) => box.querySelectorAll(s).length;
      const txt = box.textContent;
      return {
        kind: RDR.kind, chapters: RDR.book.chapters.length,
        titles: RDR.book.chapters.map(c => c.title),
        table: q('table'), strong: q('strong'), img: q('img'),
        imgLoaded: box.querySelector('img') ? box.querySelector('img').naturalWidth : 0,
        bullet: txt.indexOf('• 自动编号项') >= 0,
        noDoubleNum: txt.indexOf('• 2.1') < 0 && txt.indexOf('2.1 自带编号的条款') >= 0,
        layoutFlattened: txt.indexOf('版式表左格') >= 0 && txt.indexOf('版式表左格二') >= 0,
      };
    `);
    check('DOCX 按标题样式切章', docx.chapters === 2 && docx.titles[0] === '一级标题 制度', docx);
    check('DOCX 数据表保留表格 + 版式表拍平成文字',
      docx.table === 1 && docx.layoutFlattened, docx);
    check('DOCX 自动编号加符号，自带编号不重复加', docx.bullet && docx.noDoubleNum, docx);
    check('DOCX 粗体与图片', docx.strong === 1 && docx.img === 1 && docx.imgLoaded > 0, docx);

    // F2. 缺字体 PDF：必须给出提示和兜底入口
    const nofont = await probe('缺字体 PDF', `
      const b = await (await fetch('${base}smoke-nofont.pdf')).blob();
      await openPdfFile(new File([b], 'nofont.pdf'));
      await new Promise(r => setTimeout(r, 2000));
      return { risk: RDR.fontRisk, warn: !!document.getElementById('pdfFontWarn'),
               sys: !!document.getElementById('openSys'), spans: document.querySelectorAll('#textLayer span').length };
    `);
    check('缺字体的 PDF 被识别并给出「用系统阅读器打开」',
      nofont.risk === true && nofont.warn === true && nofont.sys === true, nofont);

    // F2b. 缺字体 PDF 要能自己把文字解出来（文字视图）
    const ptext = await probe('缺字体 PDF 文字重建', `
      const b = await (await fetch('${base}smoke-nofont.pdf')).blob();
      await openPdfFile(new File([b], 'nofont.pdf'));
      await new Promise(r => setTimeout(r, 1200));
      const box = document.getElementById('pdfTextBox');
      return { mode: RDR.textMode, lines: (RDR.textLines || []).length,
               box: !!box, text: box ? box.textContent : '',
               canToggle: !!document.getElementById('showCanvas') };
    `);
    check('缺字体 PDF 能解出文字并切到文字视图',
      ptext.mode === true && ptext.lines > 0 && ptext.box === true
      && ptext.text.indexOf('中文') >= 0 && ptext.canToggle === true, ptext);

    // F3. 脚本全局丢失时能自愈（缓存里存过坏响应的场景）
    const heal = await probe('依赖自愈', `
      await ensureJSZip();
      const loaded = !!window.JSZip;
      delete window.JSZip;
      await ensureJSZip();
      return { loaded, healed: !!window.JSZip };
    `);
    check('脚本全局丢了能自己重新取到（不再 JSZip is not defined）', heal.loaded && heal.healed, heal);

    // G. PDF 的 CMap / 标准字体资源要在线上存在（缺了中文 CID 字体整块空白）
    const cmap = await probe('PDF 字体资源', `
      const res = await fetch('vendor/cmaps/GBK-EUC-H.bcmap');
      const buf = res.ok ? await res.arrayBuffer() : null;
      const sf = await fetch('vendor/standard_fonts/LiberationSans-Regular.ttf');
      return { cmapOk: res.ok && buf && buf.byteLength > 1000, cmapBytes: buf ? buf.byteLength : 0, sfOk: sf.ok };
    `);
    check('PDF 的 CMap 与标准字体在线上可取', !!cmap.cmapOk && !!cmap.sfOk, cmap);

    // E2. 真分页（B）：长文本要分成多页，翻页改 transform，能切回滚动
    const paged = await probe('分页模式', `
      if (!RDR.paged) togglePaged();          // 上一条检查可能把模式切走了
      await new Promise(r => setTimeout(r, 300));
      const b = await (await fetch('${base}smoke-gbk.txt')).blob();
      await openTextBook(new File([b], 'smoke-gbk.txt'));
      await new Promise(r => setTimeout(r, 700));
      const out = { paged: RDR.paged, pages: RDR.pages, label0: document.getElementById('pageLabel').textContent };
      const t0 = document.getElementById('bookText').style.transform;
      flipPage(1);
      await new Promise(r => setTimeout(r, 300));
      out.label1 = document.getElementById('pageLabel').textContent;
      out.moved = document.getElementById('bookText').style.transform !== t0;
      RDR.toolsVisible = true; syncTools();
      bumpFont(2);
      await new Promise(r => setTimeout(r, 300));
      out.fontSize = getComputedStyle(document.getElementById('bookText')).fontSize;
      out.pagesAfterFont = RDR.pages;
      togglePaged();
      await new Promise(r => setTimeout(r, 300));
      out.scrollMode = !RDR.paged && !document.getElementById('pageViewport')
        && view.scrollHeight > view.clientHeight;
      return out;
    `);
    check('长文本按屏分页 + 翻页位移', paged.paged === true && paged.pages > 3
      && paged.label0 === '1 / ' + paged.pages && paged.moved === true, paged);
    check('字号可调且会重新分页', paged.fontSize !== '16px' && paged.pagesAfterFont > 0, paged);
    check('能一键切回滚动模式', paged.scrollMode === true, paged);

    // I. 整章提知识点（用桩函数，不花钱）
    const kp = await probe('知识点', `
      state.tab = 'reader'; render();
      const b = await (await fetch('${base}smoke.epub')).blob();
      await openEpubBook(new File([b], 'smoke.epub'));
      await new Promise(r => setTimeout(r, 500));
      settings.key = 'stub';
      askPoints = async () => ({ kind: 'language', summary: '概括', points: ['要点一', '要点二'],
        words: [{ w: 'alpha', cn: '甲' }],
        quiz: [{ q: '题干', options: ['错的', '对的'], a: 1, why: '解析' }] });
      RDR.kpCache = {};
      await showPoints();
      await new Promise(r => setTimeout(r, 300));
      const sheet = document.getElementById('kpOverlay');
      const out = { points: sheet ? sheet.querySelectorAll('.kplist li').length : 0,
                    quiz: sheet ? sheet.querySelectorAll('.kpq').length : 0,
                    words: sheet ? sheet.querySelectorAll('.list .it').length : 0,
                    readerAlive: !!document.getElementById('bookText') };
      const before = userCards.length;
      sheet.querySelector('[data-w="0"]').click();
      out.added = userCards.length - before;
      const q = sheet.querySelector('.kpq');
      q.querySelectorAll('button[data-o]')[0].click();
      out.marked = q.querySelector('button[data-o="0"]').classList.contains('wrong');
      const chBefore = RDR.ch;
      document.getElementById('kpClose').click();
      await new Promise(r => setTimeout(r, 300));
      out.closed = !document.getElementById('kpOverlay');
      out.back = !!document.getElementById('bookText') && RDR.ch === chBefore;
      // 再点开应该命中缓存（不再调 AI）
      let calls = 0;
      askPoints = async () => { calls++; return { points: ['重算'] }; };
      await showPoints();
      await new Promise(r => setTimeout(r, 300));
      out.fromCache = calls === 0 && !!document.getElementById('kpOverlay');
      closePoints();
      state.tab = 'settings'; render();
      out.installBtn = !!document.getElementById('btnInstall');
      out.fullBtn = !!document.getElementById('btnFull');
      return out;
    `);
    check('整章提知识点：浮层展示 + 生词入库 + 自测判对错',
      kp.points === 2 && kp.quiz === 1 && kp.words === 1 && kp.added === 1 && kp.marked === true, kp);
    check('知识点是浮层：关掉后阅读位置不变、再开命中缓存',
      kp.readerAlive === true && kp.closed === true && kp.back === true && kp.fromCache === true, kp);
    check('设置页有「安装到主屏幕」「全屏」入口', kp.installBtn === true && kp.fullBtn === true, kp);

    // J. 找教材（搜索用桩，不打真网络）
    const find = await probe('找教材', `
      state.tab = 'reader'; render();
      settings.searchKey = 'stub'; settings.key = '';
      bochaSearch = async () => ([
        { name: '材料甲', url: 'https://a.example', snippet: '片段一', summary: '摘要一' },
        { name: '材料乙', url: 'https://b.example', snippet: '片段二', summary: '摘要二' },
      ]);
      FIND.src = 'bocha'; FIND.items = []; FIND.note = '';
      renderFind();
      const links = view.querySelectorAll('a[target=_blank]').length;
      document.getElementById('findQ').value = '测试查询';
      document.getElementById('findGo').click();
      await new Promise(r => setTimeout(r, 600));
      const picks = view.querySelectorAll('[data-pick]').length;
      const origFT = fetchFullText;
      fetchFullText = async () => null;        // 这条测导入流程，抓正文另有专门用例
      document.getElementById('findImport').click();
      await new Promise(r => setTimeout(r, 900));
      fetchFullText = origFT;                  // 复原，别污染后面的用例
      return { links, picks, kind: RDR.kind, chapters: RDR.book ? RDR.book.chapters.length : 0,
               name: RDR.book ? RDR.book.name : '', heading: !!view.querySelector('#bookText h2, #bookText h3') };
    `);
    check('找教材：开放书源直链 + 搜索结果勾选导入成短文',
      find.links >= 6 && find.picks === 2 && find.kind === 'md'
      && find.chapters === 2 && find.name.indexOf('找教材') === 0 && find.heading === true, find);

    // K. OCR：资源在位 + 库能加载（真识别要 --pdf-scan 才跑）
    const ocr = await probe('OCR 资源', `
      const lang = await fetch('vendor/ocr/chi_sim.traineddata.gz');
      const core = await fetch('vendor/ocr/tesseract-core-simd-lstm.wasm');
      const lb = lang.ok ? (await lang.arrayBuffer()).byteLength : 0;
      const cb = core.ok ? (await core.arrayBuffer()).byteLength : 0;
      const T = await ensureTesseract();
      return { langBytes: lb, coreBytes: cb, lib: !!T };
    `);
    check('OCR 资源（中文模型 / wasm / 库）都在线上且可加载',
      ocr.langBytes > 1000000 && ocr.coreBytes > 1000000 && ocr.lib === true, ocr);

    if (scanArg) {
      const ocrRun = await probe('OCR 真跑', `
        const b = await (await fetch('${base}smoke-scan.pdf')).blob();
        await openPdfFile(new File([b], 'scan.pdf'));
        await new Promise(r => setTimeout(r, 3000));
        const t0 = performance.now();
        await ocrCurrentPage();
        return { ms: Math.round(performance.now() - t0), lines: (RDR.textLines || []).length,
                 sample: (RDR.textLines || []).slice(0, 3) };
      `);
      check('扫描件能 OCR 出文字', ocrRun.lines > 5, ocrRun);
    } else {
      console.log('SKIP  OCR 真识别（要验就加 --pdf-scan <扫描件.pdf>）');
    }

    // L. 抓正文：开了 CORS 的站能拿到全文，没开的老实降级（不打网络就过了）
    const ft = await probe('抓正文', `
      fetchFullText = window.__origFetchFullText || fetchFullText;   // 前面用例可能打过桩
      const t0 = performance.now();
      const got = await fetchFullText('https://raw.githubusercontent.com/mozilla/pdf.js/master/README.md');
      return { via: got && got.via, chars: got ? got.text.length : 0,
               ms: Math.round(performance.now() - t0) };
    `);
    check('抓正文：CORS 开放的站能拿到全文（直连通道）',
      ft.via === '直连' && ft.chars > 1000, ft);

    const lab = await probe('正文/摘要标注', `
      importAsText([
        { name: 'A', url: 'https://a.example', full: '正文内容'.repeat(60), via: '直连' },
        { name: 'B', url: 'https://b.example', summary: '这是书籍简介' },
      ], '标注测试', 1);
      await new Promise(r => setTimeout(r, 300));
      const t = RDR.book.chapters.map((c) => c.text).join('');
      return { hasFull: t.indexOf('全文经') >= 0, hasWarn: t.indexOf('没抓到正文') >= 0,
               chapters: RDR.book.chapters.length };
    `);
    check('导入时标明哪些是全文、哪些只是摘要',
      lab.hasFull === true && lab.hasWarn === true && lab.chapters === 2, lab);

    // M. 抓正文要保住图片；文档站要标出来
    const img = await probe('图片与文档站', `
      const html = '<html><body><article><p>' + '正文段落内容。'.repeat(30) + '</p>'
        + '<p><img src="/static/map1.png"><img data-src="https://cdn.example.com/map2.png"></p></article></body></html>';
      const txt = htmlToReadableText(html, 'https://school.example.com/a/b.html');
      const markers = txt.split('![](').length - 1;
      const absOk = txt.indexOf('https://school.example.com/static/map1.png') >= 0;
      const md = '文字' + String.fromCharCode(10, 10) + '![](https://cdn.example.com/map2.png)';
      const out = mdToHtml(md);
      settings.searchKey = 'stub'; settings.key = '';
      FIND.src = 'bocha';
      FIND.items = [
        { name: '淘豆网', url: 'https://www.taodocs.com/p-1.html', summary: 'x' },
        { name: '博客', url: 'https://blog.example.com/a', summary: 'y' },
      ];
      renderFind();
      const boxes = [...view.querySelectorAll('[data-pick]')];
      return { markers, absOk, hasImg: out.indexOf('<img') >= 0,
               noRef: out.indexOf('referrerpolicy="no-referrer"') >= 0,
               docUnchecked: boxes[0] && boxes[0].checked === false,
               normalChecked: boxes[1] && boxes[1].checked === true };
    `);
    check('抓正文保留图片（转绝对地址）且能渲染出来',
      img.markers === 2 && img.absOk === true && img.hasImg === true && img.noRef === true, img);
    check('文档分享站标「抓不到」且默认不勾',
      img.docUnchecked === true && img.normalChecked === true, img);

    // N. 目录导航 / 单双页 / 扫描版目录草案
    const toc = await probe('目录与双页', `
      state.tab = 'reader'; render();
      const b = await (await fetch('${base}smoke-outline.pdf')).blob();
      await openPdfFile(new File([b], 'outline.pdf'));
      await new Promise(r => setTimeout(r, 1800));
      await showOutline();
      await new Promise(r => setTimeout(r, 500));
      const items = [...document.querySelectorAll('.tocItem')];
      const list = items.map((e) => e.textContent.trim());
      if (items[1]) items[1].click();
      await new Promise(r => setTimeout(r, 1500));
      const jumped = RDR.page;
      RDR.page = 1; RDR.spread = true; renderReader();   // 这份夹具只有 2 页，回到第 1 页才有并排
      await new Promise(r => setTimeout(r, 2000));
      const canvases = document.querySelectorAll('#readerWrap canvas').length;
      RDR.spread = false;
      const parsed = parseTocLines(['第一章 集合 ............ 12', '第二章 三角函数 27',
        '这是一段正文没有页码也没有章节号所以不该进目录', '第三章 数列 88'], 300);
      return { items: list.length, list, jumped, canvases, parsed: parsed.length,
               parsedFirst: parsed[0] && parsed[0].title, hasOcrDraft: typeof ocrOutlineDraft === 'function' };
    `);
    check('PDF 书签能读成目录并点击跳页（含「直接给页号」的书签）',
      toc.items === 3 && toc.jumped === 2 && toc.list[1].indexOf('p.2') >= 0
      && toc.list[2].indexOf('p.2') >= 0, toc);
    check('双页模式并排渲染两页', toc.canvases === 2, toc);
    check('扫描版目录：OCR 文本能抽成目录条目',
      toc.parsed === 3 && toc.hasOcrDraft === true, toc);

    // O. 文字书也支持目录/双页；工具条在右侧竖排；打开不落在封面
    const bookTools = await probe('文字书目录与双页', `
      state.tab = 'reader'; render();
      if (!RDR.paged) { togglePaged(); await new Promise(r => setTimeout(r, 400)); }  // 前面用例可能切到滚动
      const b = await (await fetch('${base}smoke-gbk.txt')).blob();
      await openTextBook(new File([b], 'smoke-gbk.txt'));
      await new Promise(r => setTimeout(r, 700));
      const single = { pages: RDR.pages, colW: Math.round(RDR.colW || 0) };
      RDR.toolsVisible = true; syncTools();
      await new Promise(r => setTimeout(r, 150));
      const bar = document.getElementById('bookTools');
      const cs = getComputedStyle(bar);
      const br = bar.getBoundingClientRect();
      const barInfo = { dir: cs.flexDirection, rightGap: Math.round(innerWidth - br.right),
                        buttons: [...bar.querySelectorAll('button')].length };
      toggleSpread();
      await new Promise(r => setTimeout(r, 600));
      const spread = { pages: RDR.pages, colW: Math.round(RDR.colW || 0) };
      toggleSpread();
      await new Promise(r => setTimeout(r, 400));
      showBookToc();
      await new Promise(r => setTimeout(r, 300));
      const items = [...document.querySelectorAll('.tocItem')];
      return { single, spread, barInfo, tocItems: items.length,
               tocFirst: items[0] ? items[0].textContent.trim() : '',
               curHighlighted: !!document.querySelector('.tocItem.on') };
    `);
    check('文字书也有目录（章列表 + 高亮当前章）',
      bookTools.tocItems >= 1 && bookTools.curHighlighted === true, bookTools);
    // 双页 = 一屏两栏（每栏半宽），总内容不变，所以页数应基本持平（允许 ±40% 的换行损耗）
    check('文字书双页：栏宽减半、页数基本持平',
      bookTools.spread.colW <= bookTools.single.colW * 0.6
      && Math.abs(bookTools.spread.pages - bookTools.single.pages) <= bookTools.single.pages * 0.4, bookTools);
    check('工具条改成右侧竖排', bookTools.barInfo.dir === 'column' && bookTools.barInfo.rightGap <= 12
      && bookTools.barInfo.buttons >= 10, bookTools.barInfo);

    const cover = await probe('打开不落在封面', `
      state.tab = 'reader'; render();
      const b = await (await fetch('${base}smoke.epub')).blob();
      await openEpubBook(new File([b], 'smoke.epub'));
      await new Promise(r => setTimeout(r, 600));
      return { ch: RDR.ch, textLen: (RDR.book.chapters[RDR.ch].text || '').trim().length };
    `);
    check('打开书不落在封面页（停在有正文的那章）', cover.textLen > 50, cover);

    // P. 图片 → OCR → 知识点；PDF 也能出知识点
    const kp2 = await probe('图片与PDF出知识点', `
      state.tab = 'reader'; render();
      settings.key = 'stub';
      askPoints = async () => ({ kind: 'tech', summary: '概括', points: ['要点一'], words: [], quiz: [] });
      // 图片：把已有截图当成待识别图片
      const png = await (await fetch('icons/icon-192.png')).blob();
      await openImageFile(new File([png], 'pic.png'));
      await new Promise(r => setTimeout(r, 300));
      const imgState = { kind: RDR.kind, shown: !!document.getElementById('imgView'),
                         tools: document.querySelectorAll('#imgTools button').length };
      // PDF（有文字层）
      const b = await (await fetch('${base}smoke.pdf')).blob();
      await openPdfFile(new File([b], 'smoke.pdf'));
      await new Promise(r => setTimeout(r, 2200));
      const t = await chapterText();
      const textLen = t ? t.text.length : 0;
      await showPoints();
      await new Promise(r => setTimeout(r, 400));
      const sh = document.getElementById('kpOverlay');
      const points = sh ? sh.querySelectorAll('.kplist li').length : 0;
      closePoints();
      return { imgState, textLen, points };
    `);
    check('图片能导入并给出识别/知识点入口',
      kp2.imgState.kind === 'image' && kp2.imgState.shown === true && kp2.imgState.tools >= 3, kp2);
    check('PDF（含文字层）能取到正文并生成知识点',
      kp2.textLen > 100 && kp2.points >= 1, kp2);

    // Q. 视觉模型「看图出题」：请求结构 + 结果渲染（打桩，不花钱）
    const viz = await probe('看图出题', `
      state.tab = 'reader'; render();
      const sent = [];
      const BT = String.fromCharCode(96);
      const stub = { summary: '几何题', points: ['垂直关系'], words: [],
        quiz: [{ q: '角 A 多少度', options: ['45', '90', '180', '360'], a: 1, why: '垂直定义' }] };
      const orig = window.fetch;
      window.fetch = async function (url, opts) {
        if (String(url).indexOf('chat/completions') >= 0 && opts && opts.body) {
          const b = JSON.parse(opts.body);
          const c = b.messages[0].content;
          sent.push({ model: b.model, types: c.map(function (x) { return x.type; }),
                      isData: (c[1] && c[1].image_url && c[1].image_url.url || '').indexOf('data:image/') === 0 });
          const body = BT + BT + BT + 'json' + String.fromCharCode(10) + JSON.stringify(stub) + String.fromCharCode(10) + BT + BT + BT;
          return { ok: true, json: async function () { return { choices: [{ message: { content: body } }] }; } };
        }
        return orig.apply(this, arguments);
      };
      settings.visionKey = 'stub';
      settings.visionBase = 'https://api.siliconflow.cn/v1';
      settings.visionModel = 'Qwen/Qwen3-VL-8B-Instruct';
      const png = await (await fetch('icons/icon-192.png')).blob();
      await openImageFile(new File([png], 'pic.png'));
      await new Promise(function (r) { setTimeout(r, 400); });
      await visionFromImage();
      await new Promise(function (r) { setTimeout(r, 600); });
      window.fetch = orig;
      const sh = document.getElementById('kpOverlay');
      return { sent: sent[0], points: sh ? sh.querySelectorAll('.kplist li').length : 0,
               quiz: sh ? sh.querySelectorAll('.kpq').length : 0 };
    `);
    check('看图出题：按 OpenAI 兼容格式发图给视觉模型并渲染结果',
      viz.sent && viz.sent.types.join(',') === 'text,image_url' && viz.sent.isData === true
      && viz.points >= 1 && viz.quiz >= 1, viz);

    // R. 开放书源：Standard Ebooks 搜索 + 维基文库取正文导入（都打桩，不依赖外网）
    const srcs = await probe('开放书源', `
      state.tab = 'reader'; render();
      searchStandardEbooks = async () => ([
        { name: 'Emma', author: 'Jane Austen', url: 'https://standardebooks.org/ebooks/jane-austen/emma', kind: 'epub' },
      ]);
      FIND.src = 'se'; FIND.items = []; FIND.note = '';
      renderFind();
      const tabs = document.querySelectorAll('[data-src]').length;
      document.getElementById('findQ').value = 'austen';
      document.getElementById('findGo').click();
      await new Promise(r => setTimeout(r, 600));
      const items = document.querySelectorAll('[data-get]').length;
      const note = FIND.note;
      searchWikisource = async () => ([{ name: '三字经', url: 'https://zh.wikisource.org/wiki/三字经' }]);
      wikisourceText = async () => '人之初性本善。'.repeat(120);
      FIND.src = 'wikisource'; FIND.items = []; FIND.note = '';
      renderFind();
      document.getElementById('findQ').value = '三字经';
      document.getElementById('findGo').click();
      await new Promise(r => setTimeout(r, 600));
      const wxBtn = document.querySelector('[data-get="0"]');
      if (wxBtn) wxBtn.click();
      await new Promise(r => setTimeout(r, 900));
      return { tabs, items, note, wxKind: RDR.kind,
               chapters: RDR.book ? RDR.book.chapters.length : 0,
               textLen: RDR.book ? RDR.book.chapters[0].text.length : 0 };
    `);
    check('开放书源面板：三条通道 + Standard Ebooks 能搜到书',
      srcs.tabs === 3 && srcs.items === 1 && /打开书页/.test(srcs.note || ''), srcs);
    check('维基文库：取正文后导入成可读材料',
      srcs.wxKind === 'md' && srcs.chapters >= 1 && srcs.textLen > 100, srcs);

    // S. 离线词典查词
    const dic = await probe('离线词典', `
      state.tab = 'reader'; render();
      const t0 = performance.now();
      const en = await loadDict('en');
      const ms = Math.round(performance.now() - t0);
      const hit = lookupIn(en, 'salmon')[0];
      const miss = lookupIn(en, 'zzzzqqq').length;
      renderLookup('salmon');
      await new Promise(r => setTimeout(r, 700));
      const box = document.getElementById('lkResult');
      return { count: Object.keys(en).length, ms, phon: hit ? hit.entry[0] : '',
               tr: hit ? String(hit.entry[1]).slice(0, 12) : '', miss,
               ui: box ? box.querySelectorAll('.it').length : 0 };
    `);
    check('离线词典：加载并从 gzip 解出词条、UI 能查到',
      dic.count > 100000 && dic.phon.length > 0 && dic.tr.length > 0 && dic.miss === 0 && dic.ui === 1, dic);

    // T. 卡片上「单词」和「例句」两个喇叭都要能读
    const spk = await probe('朗读按钮', `
      state.tab = 'review'; render();
      const spoken = [];
      window.speechSynthesis.speak = function (u) { spoken.push(String(u.text)); };
      window.speechSynthesis.cancel = function () {};
      const card = allCards().find(function (c) { return c.example; });
      if (!card) return { error: 'no card with example' };
      state.queue = [card]; state.current = card; state.revealed = true;
      renderReview();
      await new Promise(function (r) { setTimeout(r, 120); });
      const btns = [...document.querySelectorAll('.spk')];
      if (btns[1]) btns[1].click();
      await new Promise(function (r) { setTimeout(r, 300); });
      const afterExample = spoken.slice();
      if (btns[0]) btns[0].click();
      await new Promise(function (r) { setTimeout(r, 300); });
      return { count: btns.length, afterExample: afterExample, all: spoken,
               example: card.example, front: card.front };
    `);
    check('卡片上的单词喇叭和例句喇叭都能朗读',
      spk.count === 2 && spk.afterExample.length === 1 && spk.afterExample[0] === spk.example
      && spk.all.length === 2 && spk.all[1] === spk.front, spk);

    // H. 关书释放 blob URL
    const clean = await probe('关书释放', `
      const b = await (await fetch('${base}smoke.epub')).blob();
      await openEpubBook(new File([b], 'smoke.epub'));
      await new Promise(r => setTimeout(r, 500));
      const before = RDR.urls.length;
      document.getElementById('closeBook').click();
      await new Promise(r => setTimeout(r, 100));
      return { before, after: RDR.urls.length, book: !!RDR.book };
    `);
    check('关书释放图片 blob（内存不涨）', clean.before > 0 && clean.after === 0 && clean.book === false, clean);

    // G. PDF 回归（可选）
    if (pdfArg) {
      const pdf = await probe('PDF', `
        const b = await (await fetch('${base}smoke.pdf')).blob();
        await openPdfFile(new File([b], 'smoke.pdf'));
        await new Promise(r => setTimeout(r, 3000));
        return { pages: RDR.total, spans: document.querySelectorAll('#textLayer span').length,
                 canvas: (document.getElementById('pdfCanvas') || {}).width || 0 };
      `);
      check('PDF 仍能渲染（画布 + 文字层）', pdf.pages > 0 && pdf.canvas > 0 && pdf.spans > 0, pdf);

      // A：翻页手势与浮动工具条
      const flip = await probe('翻页手势', `
        const el = document.getElementById('view');
        const t = (type, x, y) => {
          const tt = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
          el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
            touches: type === 'touchend' ? [] : [tt], changedTouches: [tt] }));
        };
        const tap = (x) => { t('touchstart', x, 400); t('touchend', x, 400); };
        const swipe = (x1, x2) => { t('touchstart', x1, 400); t('touchend', x2, 402); };
        const before = RDR.page;
        tap(370);
        await new Promise(r => setTimeout(r, 900));
        const afterRight = RDR.page;
        tap(20);
        await new Promise(r => setTimeout(r, 900));
        const afterLeft = RDR.page;
        swipe(320, 60);
        await new Promise(r => setTimeout(r, 900));
        const afterSwipe = RDR.page;
        tap(195);
        await new Promise(r => setTimeout(r, 200));
        const tools = document.getElementById('pdfTools');
        const shown = !!tools && tools.classList.contains('show');
        await new Promise(r => setTimeout(r, 3900));
        return { before, afterRight, afterLeft, afterSwipe, shown,
                 autoHidden: !!tools && !tools.classList.contains('show') };
      `);
      check('左右边缘点击 + 横滑都能翻页', flip.afterRight === flip.before + 1
        && flip.afterLeft === flip.before && flip.afterSwipe === flip.before + 1, flip);
      check('点中间出工具条，且 3.5 秒后自动收起', flip.shown === true && flip.autoHidden === true, flip);

      // PDF 滚动模式 + 阅读页隐藏顶栏
      const scrolly = await probe('PDF 滚动', `
        state.tab = 'reader'; render();
        await new Promise(r => setTimeout(r, 200));
        const headerHidden = getComputedStyle(document.querySelector('header')).display === 'none';
        const b = await (await fetch('${base}smoke.pdf')).blob();
        await openPdfFile(new File([b], 'smoke.pdf'));
        await new Promise(r => setTimeout(r, 2500));
        const total = RDR.total;
        RDR.pdfScroll = true; renderReader();
        await new Promise(r => setTimeout(r, 2500));
        const pages = document.querySelectorAll('.pdfPage').length;
        const rendered = [...document.querySelectorAll('.pdfPage')].filter((e) => e.querySelector('canvas')).length;
        view.scrollTop = 900;
        await new Promise(r => setTimeout(r, 1400));
        const label = (document.getElementById('pgLabel') || {}).textContent;
        RDR.pdfScroll = false; renderReader();
        await new Promise(r => setTimeout(r, 1500));
        return { headerHidden, total, pages, rendered, label, back: !!document.getElementById('pdfCanvas') };
      `);
      check('阅读页隐藏顶部标题栏', scrolly.headerHidden === true, scrolly);
      check('PDF 滚动模式：全部页铺开 + 懒渲染 + 能切回翻页',
        scrolly.pages === scrolly.total && scrolly.rendered > 0 && scrolly.back === true, scrolly);

      // 「关闭这份 PDF」必须真的回到选文件页（2026-10-29 回归：按钮点了没反应）
      const closed = await probe('关闭 PDF', `
        const btn = document.getElementById('closePdf');
        if (!btn) return { btn: false };
        btn.click();
        await new Promise(r => setTimeout(r, 300));
        return { pdf: !!RDR.pdf, kind: RDR.kind, picker: !!document.getElementById('pickPdf') };
      `);
      check('关闭 PDF 能回到选文件页',
        closed.btn !== false && closed.pdf === false && closed.picker === true, closed);

      // 关掉 PDF 后底部菜单栏必须还在视口里（用户报过它整个消失）
      const tab = await probe('底部菜单', `
        const t = document.querySelector('.tabbar');
        const r = t.getBoundingClientRect();
        return { display: getComputedStyle(t).display, top: Math.round(r.top),
                 bottom: Math.round(r.bottom), h: Math.round(r.height), vh: innerHeight,
                 bodyOverflow: getComputedStyle(document.body).overflow };
      `);
      check('关闭 PDF 后底部菜单仍在视口内',
        tab.display === 'flex' && tab.h > 30 && tab.bottom <= tab.vh + 1, tab);
    } else {
      console.log('SKIP  PDF 回归（要验就加 --pdf <某个真实PDF>）');
    }
  } finally {
    cdp.close();
    srv.close();
  }

  // 内容包自检（数学题重算 / 五十音 / 选择题唯一答案）
  try {
    const out = require('child_process').execFileSync('python', ['check_pack.py', 'pack.json'],
      { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }) });
    const summary = (out || '').trim().split(String.fromCharCode(10)).pop();
    check('内容包自检（check_pack.py）通过', /PASS/.test(summary || ''), { summary });
  } catch (e) {
    check('内容包自检（check_pack.py）通过', false, { err: (e.stdout || e.message || '').slice(-300) });
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) { console.log('失败项：' + bad.map((b) => b.name).join('；')); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE 崩了：' + e.message);
  process.exit(e.message === 'ENV' ? 2 : 1);
});
