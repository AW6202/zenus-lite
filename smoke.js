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
  // 基线修复：没有 --pdf 参数时也要有一份带文字层的 PDF，否则 P 项必定 FAIL
  if (pdfPath) fs.copyFileSync(pdfPath, path.join(TMP, 'smoke.pdf'));
  else fs.writeFileSync(path.join(TMP, 'smoke.pdf'), makeTextPdf());
  if (scanPath) fs.copyFileSync(scanPath, path.join(TMP, 'smoke-scan.pdf'));
}

// 带文字层的最小 PDF：给「PDF → chapterText → 知识点」用例当稳定夹具
function makeTextPdf() {
  const NL = String.fromCharCode(10);
  const lines = [
    'This page has a real text layer for the smoke test.',
    'It verifies chapter text extraction and the knowledge point flow.',
    'The quick brown fox jumps over the lazy dog near the river.',
    'A second sentence keeps the fixture well over one hundred characters.',
    'No special fonts are used, so every headless Edge can extract this text.',
  ];
  const content = 'BT /F1 12 Tf 40 250 Td '
    + lines.map((s, i) => (i ? '0 -20 Td ' : '') + '(' + s + ') Tj').join(' ') + ' ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 460 320] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + content.length + ' >>' + NL + 'stream' + NL + content + NL + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
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
                         float: document.querySelectorAll('#imgTools button').length,
                         menu: typeof window.__zenusMenu === 'function' };
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
    check('图片能导入并给出识别/知识点入口（菜单入口在，浮栏已撤）',
      kp2.imgState.kind === 'image' && kp2.imgState.shown === true
        && kp2.imgState.float === 0 && kp2.imgState.menu === true, kp2);
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

    // U. 「标记为已掌握」按钮要在翻面后看得见、点了生效
    const known = await probe('已掌握按钮', `
      state.tab = 'review'; render();
      const card = allCards()[0];
      state.queue = [card]; state.current = card; state.revealed = true;
      renderReview();
      await new Promise(r => setTimeout(r, 200));
      const tk = document.getElementById('toggleKnown');
      if (!tk) return { found: false };
      const rect = tk.getBoundingClientRect();
      const inView = rect.top >= 0 && rect.bottom <= innerHeight;
      const wasKnown = isKnown(card.front);
      tk.click();
      await new Promise(r => setTimeout(r, 200));
      const nowKnown = isKnown(card.front);
      const label = (document.getElementById('toggleKnown') || {}).textContent || '';
      const btn2 = document.getElementById('toggleKnown');
      if (btn2) btn2.click();      // 还原
      await new Promise(r => setTimeout(r, 200));
      return { found: true, inView, wasKnown, nowKnown,
               labelChanged: label.indexOf('已在') >= 0, restored: isKnown(card.front) === wasKnown };
    `);
    check('翻面后「标记为已掌握」按钮可见且生效',
      known.found === true && known.inView === true && known.nowKnown !== known.wasKnown
      && known.labelChanged === true && known.restored === true, known);

    // V. 粘贴 / 分享导入（网页链接 → 抓正文；纯文本 → 直接成材料）
    const paste = await probe('粘贴导入', `
      state.tab = 'reader'; render();
      await importFromText('这是一段要导入的文字。'.repeat(80));
      await new Promise(r => setTimeout(r, 400));
      const textOne = { kind: RDR.kind, name: RDR.book ? RDR.book.name : '',
                        len: RDR.book ? RDR.book.chapters[0].text.length : 0 };
      fetchFullText = async () => ({ text: '网页正文'.repeat(150), via: '直连' });
      await importFromText('https://example.com/a');
      await new Promise(r => setTimeout(r, 400));
      const urlOne = { name: RDR.book ? RDR.book.name : '',
                       ok: RDR.book ? RDR.book.chapters[0].text.indexOf('网页正文') >= 0 : false };
      const orig = fetchFullText;
      fetchFullText = async () => null;
      await importFromText('https://blocked.example/x');
      await new Promise(r => setTimeout(r, 300));
      const fallback = !!document.getElementById('pasteBox');
      fetchFullText = orig;
      localStorage.setItem('zenus.shared.v1', JSON.stringify({ text: '分享来的文字'.repeat(60), at: Date.now() }));
      const shared = checkShared();
      const cleared = localStorage.getItem('zenus.shared.v1') === null;
      return { textOne, urlOne, fallback, sharedLen: shared ? shared.length : 0, cleared };
    `);
    check('粘贴：纯文本直接成材料 / 链接抓正文 / 抓不到给手贴入口',
      paste.textOne.len > 100 && paste.textOne.name.indexOf('粘贴') === 0
      && paste.urlOne.ok === true && paste.urlOne.name.indexOf('网页') === 0
      && paste.fallback === true, paste);
    check('分享进来的内容能被接手且不重复消费',
      paste.sharedLen > 100 && paste.cleared === true, paste);

    // W. 剪贴板里有链接时给一条可点的导入提示
    const clip = await probe('剪贴板提示', `
      state.tab = 'reader'; render();
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { readText: async () => 'https://mp.weixin.qq.com/s/AbCdEfG123' },
      });
      lastClipCheck = 0;
      await checkClipboardHint();
      await new Promise(r => setTimeout(r, 200));
      const bar = document.getElementById('clipBar');
      const out = { shown: !!bar, hasGo: !!document.getElementById('clipGo') };
      const no = document.getElementById('clipNo');
      if (no) no.click();
      await new Promise(r => setTimeout(r, 150));
      out.dismissed = !document.getElementById('clipBar');
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { readText: async () => '一段普通文字，不是链接' },
      });
      lastClipCheck = 0;
      await checkClipboardHint();
      await new Promise(r => setTimeout(r, 150));
      out.silentForText = !document.getElementById('clipBar');
      return out;
    `);
    check('剪贴板有链接时提示导入，纯文字不打扰',
      clip.shown === true && clip.hasGo === true && clip.dismissed === true && clip.silentForText === true, clip);

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
      // 全屏图片查看器（放大/拖动/关闭）—— 2026-10-30 新增，防它以后静默坏掉
      const viewer = await probe('全屏查看器', `
        const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        openImageViewer([png, png], 0);
        await new Promise(r => setTimeout(r, 120));
        const box = document.getElementById('imgViewer');
        const stage = box && box.querySelector('#ivStage');
        const hasBtns = !!(box && box.querySelector('#ivPrev') && box.querySelector('#ivNext'));
        box && box.querySelector('#ivNext').click();
        await new Promise(r => setTimeout(r, 60));
        const label = box && box.querySelector('#ivLabel').textContent;
        closeImageViewer();
        await new Promise(r => setTimeout(r, 60));
        return { open: !!box, stage: !!stage, hasBtns, label, closed: !document.getElementById('imgViewer') };
      `);
      check('全屏图片查看器能开能翻页能关',
        viewer.open && viewer.stage && viewer.hasBtns && viewer.label.indexOf('2 /') === 0 && viewer.closed,
        viewer);

    // S5：材料书架保留；书源/书入口收口到 Legado，不再出现在书架
    const shelf = await probe('材料书架', `
      closePoints && closePoints();
      state.tab = 'reader'; render();
      await renderShelf();
      await new Promise(r => setTimeout(r, 150));
      // 基线修正（2026-11-23）：旧断言找 shBack/「书源请用」，那是已经下线的 UI；
      // 现行设计是「书架保留 + 书源管理按钮 + 浏览器态明确说明只看到本机档案」。
      const hasShelf = !!document.getElementById('shelfFilters');
      const hasSources = !!document.getElementById('shSources');
      const hint = document.body.innerHTML.includes('NG 上的书要装 App 才取得到');
      return { hasShelf, hasSources, hint };
    `);
    check('材料书架保留，书源管理入口在且有浏览器态说明',
      shelf.hasShelf === true && shelf.hasSources === true && shelf.hint === true, shelf);

    // 漫画：浏览器「存为漫画」交过来的 zip → 材料库 → 多图阅读器（2026-10-31）
    const comic = await probe('漫画导入', `
      await ensureJSZip();
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = (() => { const bin = atob(png); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; })();
      const zip = new JSZip();
      zip.file('manifest.json', JSON.stringify({ title: '冒烟漫画', pageUrl: 'https://example.com/c/1' }));
      zip.file('img/0001.png', bytes);
      zip.file('img/0002.png', bytes);
      const blob = await zip.generateAsync({ type: 'blob' });
      const n = await importComicZip(new File([blob], '冒烟漫画.zip'));
      await new Promise((r) => setTimeout(r, 300));
      const imgs = document.querySelectorAll('#cmWrap .cmImg').length;
      const kind = RDR.kind;
      const all = await matAll();
      const rec = all.find((m) => m.kind === 'comic' && m.name === '冒烟漫画');
      const kept = rec ? rec.images.length : 0;
      if (rec) await matDelete(rec.id);          // 别污染书架
      resetBook(); state.tab = 'reader'; render();
      return { n, imgs, kind, kept };
    `);
    check('漫画：zip 解包成材料、阅读器按张渲染',
      comic.n === 2 && comic.imgs === 2 && comic.kind === 'comic' && comic.kept === 2, comic);

    // 书源规则入口：整份 JSON 要留住（规则在原生侧求值），测试/搜索入口在无桥环境下不能崩
    const srcRules = await probe('书源规则入口', `
      sources = []; saveJSON(LS.sources, sources);
      renderSourceManager();
      await new Promise(r => setTimeout(r, 80));
      document.getElementById('srcBox').value = JSON.stringify([{
        bookSourceName: '规则源', bookSourceUrl: 'https://example.com',
        searchUrl: 'https://example.com/s?q={{key}}',
        ruleSearch: { bookList: 'class.bookbox', name: 'tag.h4@text' }
      }]);
      document.getElementById('srcAdd').click();
      await new Promise(r => setTimeout(r, 120));
      const kept = !!(sources[0] && sources[0].raw && sources[0].raw.searchUrl);
      const hasSearch = !!document.getElementById('srcSearch');
      const hasPick = !!document.getElementById('srcPick');
      const hasKey = !!document.getElementById('srcKey');
      const hasTest = !!document.querySelector('[data-stest]');
      // 浏览器里没有桥：点「测试」必须只给提示，不能抛
      let threw = false;
      try { await testSource(0); } catch (e) { threw = true; }
      sources = []; saveJSON(LS.sources, sources);
      renderShelf();
      return { kept, hasSearch, hasPick, hasKey, hasTest, threw };
    `);
    check('书源：保留规则 JSON + 测试/搜索入口（无桥不崩）',
      srcRules.kept && srcRules.hasSearch && srcRules.hasPick && srcRules.hasKey
      && srcRules.hasTest && !srcRules.threw, srcRules);

    // 书源库：Legado 的三种导入形态（单对象 / 数组 / {"sourceUrls":[…]}）
    const lib = await probe('书源库导入', `
      const single = normalizeSourcePayload({ bookSourceName: 'S1', bookSourceUrl: 'https://a' });
      const arr = normalizeSourcePayload([{ bookSourceName: 'S2', bookSourceUrl: 'https://b' }]);
      const coll = normalizeSourcePayload({ sourceUrls: ['https://c1', 'https://c2'] });
      const empty = normalizeSourcePayload({ foo: 1 });
      const labels = [sourceTypeLabel(0), sourceTypeLabel(2), sourceTypeLabel(1)];
      // 直接走「数组形态」导入（不需要桥）
      sources = []; saveJSON(LS.sources, sources);
      const r = await importSources(JSON.stringify([
        { bookSourceName: '导入源A', bookSourceUrl: 'https://x', bookSourceType: 0 },
        { bookSourceName: '导入源B', bookSourceUrl: 'https://y', bookSourceType: 2 }
      ]));
      const n = sources.length;
      const dup = await importSources(JSON.stringify([{ bookSourceName: '导入源A', bookSourceUrl: 'https://x' }]));
      const afterDup = sources.length;
      sources = []; saveJSON(LS.sources, sources); renderShelf();
      return { single: single.length, arr: arr.length, coll: coll.length,
               collIsUrl: !!(coll[0] && coll[0].__collectionUrl), empty: empty.length,
               labels: labels.join(','), added: r.added, n, dupAdded: dup.added, afterDup };
    `);
    check('书源库：三种形态可展开 / 去重 / 类型标签',
      lib.single === 1 && lib.arr === 1 && lib.coll === 2 && lib.collIsUrl && lib.empty === 0
      && lib.labels === '文本,漫画,音频' && lib.added === 2 && lib.n === 2
      && lib.dupAdded === 0 && lib.afterDup === 2, lib);

    // 源仓库目录解析（2026-10-31）：用真实抓下来的两个页面当夹具，锁住「id + 标题」的抽取
    const cat = await probe('源仓库解析', `
      const singleHtml = await (await fetch('${base}../../testdata/yck-single-p3.html')).text().catch(() => '');
      const collHtml = await (await fetch('${base}../../testdata/yck-collection-p1.html')).text().catch(() => '');
      const s = parseCatalogHtml(singleHtml, 'single');
      const c = parseCatalogHtml(collHtml, 'collection');
      return {
        sCount: s.length, sFirst: s[0] && s[0].id, sTitleOk: !!(s[0] && s[0].title && s[0].title.length > 2),
        cCount: c.length, cFirst: c[0] && c[0].id, cTitleOk: !!(c[0] && c[0].title && c[0].title.length > 2),
        unique: new Set(s.map((x) => x.id)).size === s.length,
      };
    `);
    check('源仓库：目录页能解析出 id 与标题（真实页面夹具）',
      cat.sCount === 100 && cat.cCount === 100 && cat.sFirst === '7743' && cat.cFirst === '1328'
      && cat.sTitleOk && cat.cTitleOk && cat.unique, cat);

    // 阅读 2.0 老格式 → 3.0 结构（实测：老格式在 3.x 里打不开，就差这次改名）
    const v2 = await probe('书源2.0升级', `
      const s = upgradeV2Source({
        bookSourceName: '老源', bookSourceUrl: 'https://old.test',
        ruleSearchList: 'class.item', ruleSearchName: 'class.name@text',
        ruleChapterUrl: 'class.all@href', ruleChapterList: 'class.ch',
        ruleChapterName: 'tag.a@text', ruleContentUrl: 'tag.a@href',
        ruleBookContent: 'id.content@text'
      });
      return {
        hasSearch: !!(s.ruleSearch && s.ruleSearch.bookList),
        name: s.ruleSearch && s.ruleSearch.name,
        tocUrl: s.ruleBookInfo && s.ruleBookInfo.tocUrl,
        chapters: s.ruleToc && s.ruleToc.chapterList,
        chapterUrl: s.ruleToc && s.ruleToc.chapterUrl,
        content: s.ruleContent && s.ruleContent.content,
        flag: !!s.__upgradedFromV2,
        untouched: upgradeV2Source({ bookSourceName: 'x', ruleSearch: { bookList: 'a' } }).__upgradedFromV2 || false
      };
    `);
    check('书源 2.0 老格式能升级成 3.0 结构（3.0 源不被误改）',
      v2.hasSearch && v2.name === 'class.name@text' && v2.tocUrl === 'class.all@href'
      && v2.chapters === 'class.ch' && v2.chapterUrl === 'tag.a@href'
      && v2.content === 'id.content@text' && v2.flag === true && v2.untouched === false, v2);

    // 卡片模型 v2：同词只留一条 / 课本已有不重复建 / 手动结论不被复习覆盖
    const cards = await probe('卡片模型', `
      const before = userCards.length;
      const r1 = upsertCard({ front: 'Smokeword', back: '烟', source: { kind: 'web' } });
      const r2 = upsertCard({ front: 'smokeword', hint: '/x/', source: { kind: 'reader' } });
      const merged = userCards.find(c => normFront(c.front) === 'smokeword');
      const delta = userCards.length - before;
      const packFront = (state.pack && state.pack.courses && state.pack.courses[0].cards[0].front) || null;
      const r3 = packFront ? upsertCard({ front: packFront, source: { kind: 'web' } }) : { reason: 'skip' };
      markKnown('probe-known', 'manual');
      schedule('probe-card-id', 'again', 'probe-known');
      const stillKnown = !!known[normWord('probe-known')];
      // 清理
      userCards = userCards.filter(c => normFront(c.front) !== 'smokeword');
      saveJSON(LS.userCards, userCards);
      delete cardIndex[normFront('smokeword')];
      delete known[normWord('probe-known')];
      saveJSON(LS.known, known);
      return { added1: r1.added, mergedNotAdded: r2.added === false, delta,
               back: merged && merged.back, hint: merged && merged.hint,
               packReason: r3.reason, stillKnown };
    `);
    check('同词从不同入口只留一条（字段合并）',
      cards.added1 === true && cards.mergedNotAdded && cards.delta === 1
        && cards.back === '烟' && cards.hint === '/x/', cards);
    check('课本已有的词不重复建卡', cards.packReason === 'exists-in-pack' || cards.packReason === 'skip', cards);
    check('手动标记的已掌握不被复习答错覆盖', cards.stillKnown === true, cards);

    // ── P1 数据层（2026-11-23）────────────────────────────────
    const p1io = await probe('P1 导出导入', `
      rebuildCardIndex();                      // 以当前卡型去重键为准，避免历史键污染对照
      const snap = exportBundle();
      const five = ['progress','log','userCards','known','cardIndex']
        .every(k => Object.prototype.hasOwnProperty.call(snap, k));
      // 导出 → 清空 → 导入，五项逐项比对
      const saved = { progress, log: reviewLog, userCards, known, cardIndex };
      progress = {}; reviewLog = []; userCards = []; known = {}; cardIndex = {};
      const plan = dryRunBundle(snap);
      const r = await applyBundle(snap, plan);
      const same = {
        progress: JSON.stringify(progress) === JSON.stringify(snap.progress),
        log: JSON.stringify(reviewLog) === JSON.stringify(snap.log),
        userCards: JSON.stringify(userCards) === JSON.stringify(snap.userCards),
        known: JSON.stringify(known) === JSON.stringify(snap.known),
        cardIndex: JSON.stringify(cardIndex) === JSON.stringify(snap.cardIndex),
      };
      // 负向：缺字段 / 坏 JSON / log 引用包外卡，都必须停在导入前
      let missingRejected = false, badLogRejected = false, badJsonRejected = false;
      try { await applyBundle({ ...snap, userCards: undefined }, { valid: true }); }
      catch (e) { missingRejected = true; }
      try { validateBundle({ ...snap, log: [{ id: 'p1-not-in-bundle', ts: 1 }] }); }
      catch (e) { badLogRejected = true; }
      try { JSON.parse('{bad json'); } catch (e) { badJsonRejected = true; }
      const backupKeys = Object.keys(localStorage).filter(k => k.indexOf('zenus.backup.') === 0);
      return { five, same, plan: { added: plan.added, merged: plan.merged, skipped: plan.skipped },
               missingRejected, badLogRejected, badJsonRejected,
               backup: backupKeys.some(k => k === r.backupKey) };
    `);
    check('P1 导出含五项，清空后导入逐项一致',
      p1io.five === true && Object.values(p1io.same || {}).every(Boolean), p1io);
    check('P1 dry-run 统计新增/合并/跳过 + 导入前备份',
      !!p1io.plan && p1io.plan.added >= 0 && p1io.backup === true, p1io);
    check('P1 负向：坏 JSON / 缺字段 / 半截 log 都在导入前被拒',
      p1io.missingRejected === true && p1io.badLogRejected === true && p1io.badJsonRejected === true, p1io);

    const p1data = await probe('P1 IndexedDB 与去重', `
      const meta = await idbGet('meta', 'migration');
      const cardRows = await idbAll('cards');
      const srsRows = await idbAll('srs');
      const legacyKeys = ['zenus.progress.v1','zenus.log.v1','zenus.usercards.v1',
                          'zenus.known.v1','zenus.cards.index.v1']
        .every(k => localStorage.getItem(k) !== null);
      const staticCount = (state.pack.courses || []).reduce((n, c) => n + (c.cards || []).length, 0);
      // 按卡型去重：同一句、不同来源 refId 共存；同句同来源被拒
      const s1 = upsertCard({ front: 'P1 sentence alpha', type: 'sentence', source: { kind: 'reader', refId: 'book-A' } });
      const s2 = upsertCard({ front: 'P1 sentence alpha', type: 'sentence', source: { kind: 'reader', refId: 'book-B' } });
      const s3 = upsertCard({ front: 'P1 sentence alpha', type: 'sentence', source: { kind: 'reader', refId: 'book-A' } });
      const coexist = s1.added === true && s2.added === true && s3.reason === 'merged';
      const keys = ['sentence:p1 sentence alpha|book-A','sentence:p1 sentence alpha|book-B'];
      for (const id of [s1.card && s1.card.id, s2.card && s2.card.id].filter(Boolean)) {
        userCards = userCards.filter(c => c.id !== id);
      }
      keys.forEach(k => { delete cardIndex[k]; });
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      // 编辑 / 删除 / 刷新不复活（切到「我的生词」才看得到用户卡）
      const oldCourse = state.courseId;
      state.courseId = MINE_ID;
      const ec = upsertCard({ front: 'P1 edit me', back: '旧' }).card;
      await saveCardEdit(ec.id, { front: 'P1 edited now', back: '新' });
      const editedInCards = allCards().some(c => c.id === ec.id && c.front === 'P1 edited now');
      const oldInQueue = dueQueue().some(c => c.front === 'P1 edit me');
      await softDeleteCard(ec.id);
      const goneNow = !allCards().some(c => c.id === ec.id) && !dueQueue().some(c => c.id === ec.id);
      await loadLearnerMeta();
      const goneAfterReload = state.learner.deleted.has(ec.id);
      const dc = upsertCard({ front: 'P1 delete me' }).card;
      await softDeleteCard(dc.id);
      const deleteGone = !allCards().some(c => c.id === dc.id);
      // 合并：保留复习次数更多 / 到期更晚的一份，流水改 cardId
      const a = upsertCard({ front: 'P1 merge a' }).card;
      const b = upsertCard({ front: 'P1 merge b' }).card;
      progress[a.id] = { due: Date.now() + 1000, interval: 1, reps: 1 };
      progress[b.id] = { due: Date.now() + 86400000, interval: 10, reps: 5 };
      reviewLog.push({ id: b.id, r: 'good', ts: Date.now() });
      const mr = await mergeDuplicateCards(a.id, b.id);
      const mergeKeptBetter = mr.merged === true && progress[a.id].reps === 5 && !progress[b.id];
      const logMoved = reviewLog.some(x => x.id === a.id && x.mergedFrom === b.id);
      delete progress[a.id];
      reviewLog = reviewLog.filter(x => !x.mergedFrom);
      saveJSON(LS.progress, progress); saveJSON(LS.log, reviewLog);
      state.courseId = oldCourse;
      return {
        migrated: !!meta && !!meta.migratedAt,
        cards: cardRows.length, staticCount, srs: srsRows.length,
        expected: meta && meta.counts && meta.counts.cards,
        migratedStatic: meta && meta.counts && meta.counts.staticCards,
        migratedUser: meta && meta.counts && meta.counts.userCards,
        legacyKeys, coexist, editedInCards, oldInQueue, goneNow, goneAfterReload, deleteGone,
        mergeKeptBetter, logMoved, algo: meta && meta.fsrs,
      };
    `);
    check('P1 迁移：meta 落库 + 275 静态卡与本机卡数量一致 + 旧键保留',
      p1data.migrated === true && p1data.migratedStatic === 275
      && p1data.expected === p1data.migratedStatic + p1data.migratedUser
      && p1data.cards >= p1data.expected && p1data.legacyKeys === true, p1data);
    check('P1 去重：不同句子卡共存，同句重复被拒', p1data.coexist === true, p1data);
    check('P1 编辑/删除：旧内容不进队列，刷新不复活',
      p1data.editedInCards === true && p1data.oldInQueue === false
      && p1data.goneNow === true && p1data.goneAfterReload === true && p1data.deleteGone === true, p1data);
    check('P1 合并：保留复习更多的卡，流水改 cardId',
      p1data.mergeKeptBetter === true && p1data.logMoved === true, p1data);
    check('P1 固定 FSRS-6', String(p1data.algo || '').indexOf('FSRS-6') >= 0, p1data);

    const p1fsrs = await probe('P1 FSRS 评分', `
      const fid = 'p1-fsrs-probe';
      progress[fid] = { due: Date.now() - 1000, interval: 1, ease: 2.5, reps: 1, lapses: 0,
                        last: Date.now() - 86400000 };
      schedule(fid, 'good', 'p1 fsrs word');
      await new Promise(r => setTimeout(r, 200));   // srs/revlog 是异步落 IndexedDB
      const e = progress[fid];
      const fsrsOk = !!(e.fsrs && e.fsrs.version === 'FSRS-6'
        && Number.isFinite(e.fsrs.stability) && e.fsrs.stability > 0);
      const lastLog = reviewLog[reviewLog.length - 1];
      const logAlgo = lastLog && lastLog.algo === 'FSRS-6';
      const row = await idbGet('srs', fid);
      const rev = (await idbAll('revlog')).find(x => x.cardId === fid && x.reviewKind === 'learn');
      // 负向：坏 srs 必须回退为 New，不许页面崩
      progress['p1-bad'] = { due: Date.now(), interval: 3, reps: 2,
                             fsrs: { stability: undefined, state: 2 } };
      schedule('p1-bad', 'good', 'p1 bad word');
      const bad = progress['p1-bad'];
      const recovered = !!(bad.fsrs && (bad.fsrs.recovered || bad.fsrs.approx));
      await logQuizEntry('p1-quiz', { q: 1 });
      const quizInQuiz = (await idbAll('quiz_log')).some(x => String(x.id).indexOf('quiz-') === 0);
      const quizNotRev = !(await idbAll('revlog')).some(x => String(x.id).indexOf('quiz-') === 0);
      delete progress[fid]; delete progress['p1-bad'];
      reviewLog = reviewLog.filter(x => x.id !== fid && x.id !== 'p1-bad');
      delete known[normWord('p1 fsrs word')]; delete known[normWord('p1 bad word')];
      saveJSON(LS.progress, progress); saveJSON(LS.log, reviewLog); saveJSON(LS.known, known);
      return { fsrsOk, logAlgo, srsRow: !!row, revRow: !!rev, recovered, quizInQuiz, quizNotRev };
    `);
    check('P1 FSRS：评分后 srs + revlog 持久化，坏 srs 回退 New 不崩',
      p1fsrs.fsrsOk === true && p1fsrs.logAlgo === true && p1fsrs.srsRow === true
      && p1fsrs.revRow === true && p1fsrs.recovered === true, p1fsrs);
    check('P1 quiz-* 不进 revlog，进 quiz_log',
      p1fsrs.quizInQuiz === true && p1fsrs.quizNotRev === true, p1fsrs);

    // ── P1b 复核三项：旧代码必红 ─────────────────────────────
    const p1bfsrs = await probe('P1b 多步 FSRS', `
      const fid = 'p1b-fsrs-steps';
      delete progress[fid];
      const seq = [];
      for (const [i, rating] of ['good', 'good', 'again', 'good'].entries()) {
        if (i > 0) progress[fid].due = Date.now() - 1000;   // 人为推进到到期
        schedule(fid, rating, '');
        const e = progress[fid];
        seq.push({ state: e.fsrs && e.fsrs.state, stability: e.fsrs && e.fsrs.stability,
                   reps: e.reps, dueMin: Math.round((e.due - Date.now()) / 60000) });
      }
      const S = window.FSRS.State;
      const want = [S.Learning, S.Review, S.Relearning, S.Review];
      const states = seq.map(x => x.state);
      const stateOk = want.every((s, i) => states[i] === s);
      const dueOk = seq[0].dueMin >= 0 && seq[0].dueMin <= 15;
      const stabilityOk = seq[1].stability > seq[0].stability
        && seq[2].stability < seq[1].stability && seq[3].stability > seq[2].stability;
      const repsOk = seq.every((x, i) => i === 0 || x.reps > seq[i - 1].reps);
      delete progress[fid];
      reviewLog = reviewLog.filter(x => x.id !== fid);
      saveJSON(LS.progress, progress); saveJSON(LS.log, reviewLog);
      return { stateOk, dueOk, stabilityOk, repsOk, states,
               stabilities: seq.map(x => Math.round(x.stability * 100) / 100),
               reps: seq.map(x => x.reps), dueMin: seq[0].dueMin };
    `);
    check('P1b 多步 FSRS：Learning→Review→Relearning→Review，stability/reps 不倒退',
      p1bfsrs.stateOk === true && p1bfsrs.dueOk === true
      && p1bfsrs.stabilityOk === true && p1bfsrs.repsOk === true, p1bfsrs);

    const p1blog = await probe('P1b 6000 条流水', `
      const c = upsertCard({ front: 'P1B bulk log card' }).card;
      const base = Date.now() - 6000000;
      const rows = Array.from({ length: 6000 }, (_, i) => ({ id: c.id, r: 'good', ts: base + i }));
      mergeState({ log: rows });
      await new Promise(r => setTimeout(r, 1500));   // mergeState 的 IDB 写入是后台的
      const exported = exportBundle();
      const fullCount = typeof exportBundleFull === 'function'
        ? (await exportBundleFull()).log.filter(x => x.id === c.id).length : -1;
      const syncCount = (await localState()).log.filter(x => x.id === c.id).length;
      const memCount = exported.log.filter(x => x.id === c.id).length;
      // 导出 → 清空 → 导入，6000 条必须一条不少
      const saved = reviewLog;
      reviewLog = [];
      const mini = { schema: exported.schema, progress: {}, log: exported.log.filter(x => x.id === c.id),
                     userCards: [c], known: {}, cardIndex: {} };
      await applyBundle(mini, dryRunBundle(mini));
      const afterImport = reviewLog.filter(x => x.id === c.id).length;
      reviewLog = saved.filter(x => x.id !== c.id);
      if (typeof saveReviewLog === 'function') saveReviewLog(); else saveJSON(LS.log, reviewLog);
      const db = await learnerDb();
      await new Promise((res, rej) => {
        const tx = db.transaction('revlog', 'readwrite');
        const os = tx.objectStore('revlog');
        os.getAll().onsuccess = (ev) => {
          for (const r of ev.target.result || []) if (r.cardId === c.id) os.delete(r.id);
        };
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      userCards = userCards.filter(x => x.id !== c.id);
      delete progress[c.id];
      delete cardIndex[cardKey(c)];
      saveJSON(LS.progress, progress); saveJSON(LS.userCards, userCards);
      saveJSON(LS.cardIndex, cardIndex);
      return { memCount, fullCount, syncCount, afterImport };
    `);
    check('P1b 6000 条 log：导出/同步/回导一条不少（无 5000 截断）',
      p1blog.memCount === 6000 && p1blog.fullCount === 6000
      && p1blog.syncCount === 6000 && p1blog.afterImport === 6000, p1blog);

    const p1bmerge = await probe('P1b 合并 IDB', `
      const a = upsertCard({ front: 'P1B merge keep' }).card;
      const b = upsertCard({ front: 'P1B merge drop' }).card;
      const rid = 'p1b-merge-row-' + b.id;
      await idbPut('revlog', { id: rid, cardId: b.id, rating: 'good', reviewedAt: Date.now(),
                               algo: 'FSRS-6', lib: 'ts-fsrs@5.1.0 / FSRS-6' });
      await idbPut('srs', srsFromEntry(b.id, { due: Date.now(), last: Date.now(), reps: 2,
                                                fsrs: { state: 2, stability: 5, difficulty: 5 } }));
      const mr = await mergeDuplicateCards(a.id, b.id);
      const rows = (await idbAll('revlog')).filter(x => x.cardId === a.id || x.cardId === b.id);
      const orphan = rows.some(x => x.cardId === b.id);
      const remapped = rows.some(x => x.cardId === a.id && x.mergedFrom === b.id);
      const srsGone = !(await idbGet('srs', b.id));
      const db = await learnerDb();
      await new Promise((res, rej) => {
        const tx = db.transaction('revlog', 'readwrite');
        const os = tx.objectStore('revlog');
        os.getAll().onsuccess = (ev) => {
          for (const r of ev.target.result || []) if (r.id === rid) os.delete(r.id);
        };
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      userCards = userCards.filter(x => x.id !== a.id && x.id !== b.id);
      delete progress[a.id]; delete progress[b.id];
      reviewLog = reviewLog.filter(x => x.id !== a.id && x.id !== b.id);
      saveJSON(LS.progress, progress); saveJSON(LS.log, reviewLog); saveJSON(LS.userCards, userCards);
      rebuildCardIndex();
      return { merged: mr.merged, remappedCount: mr.idbRemapped, orphan, remapped, srsGone };
    `);
    check('P1b 合并：IDB revlog 无 dropId 孤儿，srs 已清',
      p1bmerge.merged === true && p1bmerge.remappedCount >= 1
      && p1bmerge.orphan === false && p1bmerge.remapped === true
      && p1bmerge.srsGone === true, p1bmerge);

    // ── P1c 复核三项：内存改了，IDB 真源也要跟上 ─────────────────
    const p1coverride = await probe('P1c override 回写', `
      const oldCourse = state.courseId;
      state.courseId = MINE_ID;
      // 建卡时 back 为空（override 里也是空），同词合并补上 back：
      // mergeCardFields(target, incoming, true) 只填空字段，这才走得到复核说的路径。
      const c = upsertCard({ front: 'P1C override probe' }).card;
      await new Promise(r => setTimeout(r, 250));      // 首次 override 是 fire-and-forget
      const first = (await idbGet('cards', c.id) || {}).back;
      const m = upsertCard({ front: 'P1C override probe', back: '新释义' });
      await new Promise(r => setTimeout(r, 250));      // 合并分支回写 override
      await loadLearnerMeta();
      const after = (allCards().find(x => x.id === c.id) || {}).back;
      await idbDelete('cards', c.id);
      state.learner.deleted.delete(c.id); delete state.learner.overrides[c.id];
      userCards = userCards.filter(x => x.id !== c.id);
      delete cardIndex[cardKey(c)];
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      state.courseId = oldCourse;
      await loadLearnerMeta();
      return { merged: m.reason === 'merged', first, after };
    `);
    check('P1c 同词合并：新字段回写 IDB，重开不被旧 override 盖回',
      p1coverride.merged === true && p1coverride.first === ''
      && p1coverride.after === '新释义', p1coverride);

    const p1cabsorb = await probe('P1c absorb IDB', `
      const oldCourse = state.courseId;
      state.courseId = MINE_ID;
      const fromId = 'p1c-absorb-from', toId = 'p1c-absorb-to';
      const rowId = 'p1c-absorb-row';
      const target = upsertCard({ front: 'P1C absorb word', id: toId, back: '目标' }).card;
      await idbPut('revlog', { id: rowId, cardId: fromId, rating: 'good',
                               reviewedAt: Date.now(), algo: 'FSRS-6' });
      progress[fromId] = { due: Date.now() + 1000, reps: 3 };
      reviewLog.push({ id: fromId, r: 'good', ts: Date.now() });
      const r = upsertCard({ front: 'P1C absorb word', id: fromId, back: '来源新' });
      await new Promise(r2 => setTimeout(r2, 300));
      const rows = (await idbAll('revlog')).filter(x => x.cardId === fromId || x.cardId === toId);
      const orphan = rows.some(x => x.cardId === fromId);
      const remapped = rows.some(x => x.cardId === toId && x.mergedFrom === fromId);
      await idbDelete('revlog', rowId);
      await idbDelete('cards', toId);
      delete progress[fromId]; delete progress[toId];
      reviewLog = reviewLog.filter(x => x.id !== fromId && x.id !== toId);
      userCards = userCards.filter(x => x.id !== toId);
      delete cardIndex[cardKey(target)];
      saveJSON(LS.progress, progress); saveJSON(LS.log, reviewLog);
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      state.courseId = oldCourse;
      return { merged: r.reason === 'merged', orphan, remapped };
    `);
    check('P1c absorbProgress：IDB revlog 无 fromId 孤儿，带 mergedFrom',
      p1cabsorb.merged === true && p1cabsorb.orphan === false
      && p1cabsorb.remapped === true, p1cabsorb);

    const p1ctomb = await probe('P1c 远端墓碑', `
      const oldCourse = state.courseId;
      state.courseId = MINE_ID;
      const c = upsertCard({ front: 'P1C tombstone probe' }).card;
      await new Promise(r => setTimeout(r, 200));
      await mergeState({ deleted: [c.id] });
      const inMem = state.learner.deleted.has(c.id);
      const row = await idbGet('cards', c.id);
      const stamped = !!(row && row.deletedAt);
      await loadLearnerMeta();
      const afterReload = state.learner.deleted.has(c.id);
      await idbDelete('cards', c.id);
      state.learner.deleted.delete(c.id); delete state.learner.overrides[c.id];
      userCards = userCards.filter(x => x.id !== c.id);
      delete cardIndex[cardKey(c)];
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      state.courseId = oldCourse;
      await loadLearnerMeta();
      return { inMem, stamped, afterReload };
    `);
    check('P1c mergeState 墓碑：落 IDB 后重开不复活',
      p1ctomb.inMem === true && p1ctomb.stamped === true
      && p1ctomb.afterReload === true, p1ctomb);

    // 「已掌握」单一事实源：复习队列 / 统计 / 抓词入库 必须同一口径
    const knownScope = await probe('已掌握口径', `
      state.courseId = MINE_ID;
      upsertCard({ front: 'scope-alpha', back: '甲' });
      upsertCard({ front: 'scope-beta', back: '乙' });
      markKnown('scope-alpha', 'manual');
      const inQueue = (w) => dueQueue().some(c => normFront(c.front) === w);
      const qBefore = { alpha: inQueue('scope-alpha'), beta: inQueue('scope-beta') };
      const bar = statsBar();
      const before = userCards.length;
      const added = addCardFromSelection('scope-alpha');
      const grew = userCards.length - before;
      unmarkKnown('scope-alpha');
      const backInQueue = inQueue('scope-alpha');
      // 清理
      userCards = userCards.filter(c => normFront(c.front).indexOf('scope-') !== 0);
      saveJSON(LS.userCards, userCards);
      ['scope-alpha', 'scope-beta'].forEach(w => { delete cardIndex[normFront(w)]; });
      saveJSON(LS.cardIndex, cardIndex);
      state.courseId = state.pack.courses[0].id;
      return { qBefore, barHasKnown: bar.indexOf('已掌握 1') >= 0, added, grew, backInQueue };
    `);
    check('已掌握：不进复习队列 / 不重复进生词本 / 移除后回队列',
      knownScope.qBefore.alpha === false && knownScope.qBefore.beta === true
      && knownScope.barHasKnown === true && knownScope.added === false
      && knownScope.grew === 0 && knownScope.backInQueue === true, knownScope);

    // 200035 §4c：设置页已掌握逐词列表 + 单条移除走 unmarkKnown（含原生桥）
    const knownList = await probe('已掌握逐词列表', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data: {} }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null;
      const backup = JSON.parse(JSON.stringify(known));
      const baseN = Object.keys(backup).length;
      const prevTab = state.tab;
      known['list-one'] = { at: 3000, why: 'review' };
      known['list-two'] = { at: 2000, why: 'skip' };
      known['list-three'] = { at: 1000, why: 'manual' };
      saveJSON(LS.known, known);
      state.tab = 'settings'; renderSettings();
      const box = document.getElementById('knownList');
      const toggle = document.getElementById('toggleKnownList');
      const hiddenAtFirst = box.style.display === 'none';
      toggle.click();
      const shownAfterToggle = box.style.display !== 'none';
      const rows = Array.from(box.querySelectorAll('[data-known-row]')).map(r => r.dataset.knownRow);
      const skipRow = box.querySelector('[data-known-row="list-two"]');
      const skipLabel = skipRow ? (skipRow.querySelector('small') || {}).textContent : '';
      const countBefore = document.getElementById('knownCount').textContent;
      box.querySelector('[data-known-remove="list-two"]').click();
      const out = {
        hiddenAtFirst, shownAfterToggle, rows, skipLabel, countBefore,
        rowsAfter: box.querySelectorAll('[data-known-row]').length,
        gone: !known['list-two'],
        countAfter: document.getElementById('knownCount').textContent,
        nativeUnmark: calls.filter(c => c.cmd === 'learner.unmarkKnown').map(c => c.args.word),
        expectedBefore: String(baseN + 3), expectedAfter: String(baseN + 2),
      };
      Object.keys(known).forEach(k => delete known[k]);
      Object.assign(known, backup); saveJSON(LS.known, known);
      state.tab = prevTab; render();
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('已掌握列表：3 行/来源标注/单条移除走 learner.unmarkKnown',
      knownList.hiddenAtFirst === true && knownList.shownAfterToggle === true
      && knownList.rows.slice(0, 3).join(',') === 'list-one,list-two,list-three'
      && knownList.skipLabel === '跳过'
      && knownList.countBefore === knownList.expectedBefore
      && knownList.rowsAfter === knownList.rows.length - 1
      && knownList.gone === true && knownList.countAfter === knownList.expectedAfter
      && knownList.nativeUnmark.includes('list-two'), knownList);

    // 系统内核渲染视图：按设计**不再有**右侧浮栏，动作全在壳的长按菜单里；
    // 页面只需提供「当前在读什么」给壳的存入思源用
    const npTools = await probe('内核实渲染视图', `
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      RDR.nativePages = [png, png];
      RDR.name = '冒烟页';
      RDR.kind = 'nativepdf';
      renderNativePdf();
      await new Promise(r => setTimeout(r, 80));
      const hadBar = !!document.getElementById('npTools');
      const wraps = document.querySelectorAll('.npWrap').length;
      const docApi = typeof window.__zenusCurrentDoc === 'function';
      RDR.nativePages = null; resetBook(); renderReader();
      return { hadBar, wraps, docApi };
    `);
    check('内核实渲染视图不再挂浮栏，且提供当前材料给「存入思源」',
      npTools.hadBar === false && npTools.wraps === 2 && npTools.docApi, npTools);

    // 学习内核桥：导入 / 待确认箱 / 评分镜像（假 window.zenus，不依赖真机）
    const core = await probe('学习内核桥', `
      const calls = [];
      const cbs = [];
      let importCards = -1;
      window.zenus = {
        postMessage(json) {
          const m = JSON.parse(json);
          calls.push(m);
          const reply = (data) => cbs.forEach((cb) => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
          if (m.cmd === 'inbox.take') {
            reply([{ id: 'n-smoke', kind: 'card', front: 'ephemeral', back: '短暂的',
                     hint: '/ɪˈfemərəl/', sourceKind: 'reader', sourceTitle: '冒烟书' },
                   { id: 'n-smoke2', kind: 'card', front: 'serendipity', back: '意外发现',
                     hint: '/ˌserənˈdɪpəti/', sourceKind: 'reader', sourceTitle: '冒烟书' }]);
          } else if (m.cmd === 'learner.import') {
            importCards = (m.args.payload.userCards || []).length;
            reply({ cards: importCards });
          } else {
            reply({ ok: true });
          }
        },
        addEventListener(type, cb) { if (type === 'message') cbs.push(cb); },
      };
      CTRL = null;
      state.inbox = [];
      settings.coreImported = false;
      await importToCoreOnce();
      await pullCoreInbox();
      state.tab = 'review'; state.queue = []; state.current = null; renderReview();
      const btn = document.getElementById('inboxBtn');
      const hasBtn = !!btn;
      if (btn) btn.click();
      const add = document.querySelector('#inboxOverlay [data-add="0"]');
      if (add) add.click();
      await new Promise((r) => setTimeout(r, 80));
      // 第二项必须还能点：按索引 splice 的旧写法会在这里跳项
      const add2 = document.querySelector('#inboxOverlay [data-add="1"]');
      if (add2) add2.click();
      await new Promise((r) => setTimeout(r, 80));
      schedule('u-smoke', 'good', 'ephemeral');
      await new Promise((r) => setTimeout(r, 80));
      const cmds = calls.map((c) => c.cmd);
      const out = {
        hasBtn, importCards,
        imported: cmds.includes('learner.import'),
        took: cmds.includes('inbox.take'),
        upserted: cmds.includes('cards.upsert'),
        rated: cmds.includes('review.rate'),
        cardAdded: userCards.some((c) => c.front === 'ephemeral')
          && userCards.some((c) => c.front === 'serendipity'),
        inboxLeft: state.inbox.length,
      };
      // 清理，别污染后面的用例
      userCards = userCards.filter((c) => c.front !== 'ephemeral' && c.front !== 'serendipity');
      saveJSON(LS.userCards, userCards);
      delete progress['u-smoke']; saveJSON(LS.progress, progress);
      state.inbox = []; saveInbox();
      const ov = document.getElementById('inboxOverlay'); if (ov) ov.remove();
      window.zenus = undefined; CTRL = null;
      renderReview();
      return out;
    `);
    check('学习内核：导入本机进度 + 待确认箱 + 评分镜像',
      core.hasBtn === true && core.imported === true && core.took === true
      && core.upserted === true && core.rated === true && core.cardAdded === true
      && core.inboxLeft === 0 && core.importCards >= 0, core);

    // P2b（2026-11-24）：pullWebCards 已从 app.js 删除——旧桥命令 "inbox" 直接入主卡牌的口子不能回来。
    // 旧代码上这条必红（函数仍在 / 仍调 nativeCall('inbox')）；不是靠删覆盖换绿。
    const p2bSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const p2bGone = await probe('P2b 不再自动入卡', `
      return { fn: typeof pullWebCards };
    `);
    check('P2b：pullWebCards 已删，网页存词只走待确认箱',
      p2bGone.fn === 'undefined'
      && !p2bSrc.includes('pullWebCards')
      && !p2bSrc.includes("nativeCall('inbox'"),
      { fn: p2bGone.fn, hasFn: p2bSrc.includes('pullWebCards'), hasOldCall: p2bSrc.includes("nativeCall('inbox'") });

    // 撤销「已掌握」要连原生 learner 表一起清，否则生词雷达继续屏蔽该词（浏览器里 nativePort 为空 → no-op）
    check('撤销已掌握会同步清原生 known',
      p2bSrc.includes("coreCall('learner.unmarkKnown', { word: w }"),
      { wired: p2bSrc.includes("coreCall('learner.unmarkKnown', { word: w }") });

    // 例句（2026-11-24）：存卡时抓「选区所在的那一句」当例句，离线可用/真实语境。
    // 要在旧代码上全红：旧代码没有 sentenceContainingSelection / 不写 example。
    const SENT = 'The morning light fell softly on the old wooden bridge.';
    const exam = await probe('选区例句', `
      // 1) 纯函数：给一个真实 DOM 选区，取出包含选区的整句（前后各一句，只取命中那句）
      const host = document.createElement('div');
      host.className = 'bookText';
      host.innerHTML = '<p>Before sentence one. ${SENT} After sentence three.</p>';
      document.body.appendChild(host);
      const p = host.querySelector('p');
      const t = p.childNodes[0];
      const at = t.textContent.indexOf('wooden');
      const rg = document.createRange();
      rg.setStart(t, at); rg.setEnd(t, at + 6);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
      const got = sentenceContainingSelection(sel);
      sel.removeAllRanges(); host.remove();
      return { got };
    `);
    check('选区→整句：只取命中那一句，含句末标点，不带前后句',
      exam.got === SENT, exam);

    // 行内 span（加粗/高亮/挖空）里的选区：块必须退到 p，不能把 span 的词本身当例句
    const SENT2 = 'The wooden bridge held firm.';
    const examSpan = await probe('行内span选区', `
      const host = document.createElement('div');
      host.className = 'bookText';
      host.innerHTML = '<p>Before sentence one. The <span class="hl">wooden bridge</span> held firm. After.</p>';
      document.body.appendChild(host);
      const t = host.querySelector('span.hl').childNodes[0];
      const at = t.textContent.indexOf('wooden');
      const rg = document.createRange();
      rg.setStart(t, at); rg.setEnd(t, at + 6);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg);
      const got = sentenceContainingSelection(sel);
      sel.removeAllRanges(); host.remove();
      return { got };
    `);
    check('行内 span 里的选区：例句是整个句子，不是那个词',
      examSpan.got === SENT2, examSpan);

    const examSave = await probe('存卡带例句', `
      state.courseId = MINE_ID;
      const before = userCards.length;
      const r = addCardFromSelection('quasar-example', ${JSON.stringify(SENT)});
      const card = userCards.find(c => c.front === 'quasar-example');
      const out = { added: r, grew: userCards.length - before,
                    example: card ? card.example : '' };
      // 清场
      userCards = userCards.filter(c => c.front !== 'quasar-example');
      delete cardIndex['quasar-example'];
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      state.courseId = state.pack.courses[0].id;
      return out;
    `);
    check('存卡把选区句写进 example（离线，不靠 AI）',
      examSave.added === true && examSave.grew === 1 && examSave.example === SENT, examSave);

    const examMerge = await probe('同词合并保例句', `
      state.courseId = MINE_ID;
      const a = upsertCard({ front: 'merge-example', back: '旧释义' }).card;
      const b = upsertCard({ front: 'merge-example', example: ${JSON.stringify(SENT)} });
      const kept = userCards.find(c => c.id === a.id);
      const out = { reason: b.reason, example: kept ? kept.example : '' };
      userCards = userCards.filter(c => c.front !== 'merge-example');
      delete cardIndex['merge-example'];
      saveJSON(LS.userCards, userCards); saveJSON(LS.cardIndex, cardIndex);
      state.courseId = state.pack.courses[0].id;
      return out;
    `);
    check('同词合并：老卡没有例句时，新例句补进去不丢',
      examMerge.reason === 'merged' && examMerge.example === SENT, examMerge);

    const examNative = await probe('壳存卡回填例句', `
      // 模拟 APK：壳存卡只在 Core inbox 留词，例句靠 selectionchange 的词→句缓存回填
      rememberSelectionExample('radian-drift', ${JSON.stringify(SENT)});
      const cacheHit = recallSelectionExample('radian-drift');
      const cacheMiss = recallSelectionExample('never-selected');
      const calls = [], cbs = [];
      window.zenus = {
        postMessage(json) {
          const m = JSON.parse(json); calls.push(m);
          const reply = (data) => cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
          if (m.cmd === 'inbox.list' || m.cmd === 'inbox.take') {
            reply([{ id: 'n-eg', kind: 'card', front: 'radian-drift', back: '', sourceKind: 'web' }]);
          } else reply({ ok: true });
        },
        addEventListener(type, cb) { if (type === 'message') cbs.push(cb); },
      };
      CTRL = null;
      state.inbox = [];
      await pullCoreInbox();
      const item = state.inbox.find(x => x.front === 'radian-drift');
      // 待确认面板要把例句画出来
      state.tab = 'review'; state.queue = []; state.current = null; renderReview();
      const btn = document.getElementById('inboxBtn'); if (btn) btn.click();
      const eg = document.querySelector('#inboxOverlay .eg');
      const egText = eg ? eg.textContent : '';
      // 清场
      const ov = document.getElementById('inboxOverlay'); if (ov) ov.remove();
      inboxDoneMark(item);
      state.inbox = []; saveInbox();
      window.zenus = undefined; CTRL = null;
      renderReview();
      return { cacheHit, cacheMiss, inboxExample: item ? item.example : '', egText };
    `);
    check('壳存卡（离线圈选）→ 待确认卡 + 面板都带真实语境例句',
      examNative.cacheHit === SENT && examNative.cacheMiss === ''
      && examNative.inboxExample === SENT && examNative.egText === SENT, examNative);

    // AI 收口：App 里必须走原生 ai.ask，而不是网页直连
    const aiRoute = await probe('AI 收口', `
      const calls = [];
      const cbs = [];
      window.zenus = {
        postMessage(json) {
          const m = JSON.parse(json);
          calls.push(m);
          const data = { text: '{"questions":[]}', artifactId: 'a-smoke', skill: m.args && m.args.skill };
          cbs.forEach((cb) => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(type, cb) { if (type === 'message') cbs.push(cb); },
      };
      CTRL = null;
      const txt = await coreAsk('quiz', { system: 'sys', input: 'in', json: true });
      const c = calls[0] || {};
      window.zenus = undefined; CTRL = null;
      return { txt, cmd: c.cmd, skill: c.args && c.args.skill,
               hasSystem: !!(c.args && c.args.system), json: !!(c.args && c.args.json) };
    `);
    check('AI 收口：App 里走 ai.ask（带 system/json）',
      aiRoute.cmd === 'ai.ask' && aiRoute.skill === 'quiz' && aiRoute.json === true
      && aiRoute.hasSystem === true && aiRoute.txt === '{"questions":[]}', aiRoute);

    // ── 200035：待确认补释义 / 例句只求译文 / inbox.remove / 未收录灰字 ──
    const fillAdd = await probe('待确认补释义', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          let data = {};
          if (m.cmd === 'inbox.list') data = [{ id: 'smoke-uncol-1', front: 'zz-uncollected', back: '', hint: '' }];
          else if (m.cmd === 'ai.ask') data = { text: JSON.stringify({ back: '未收录释义', phonetic: '/ʌn/', example: 'AI 例句', exampleCN: 'AI 译文' }) };
          else if (m.cmd === 'inbox.remove') data = { ok: true, removed: 1 };
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null;
      state.inbox = [];
      delete known['zz-uncollected'];
      delete inboxDone['id:smoke-uncol-1']; delete inboxDone['w:zz-uncollected'];
      saveJSON(LS.known, known); saveJSON(LS.inboxDone, inboxDone);
      await pullCoreInbox();
      showInboxSheet();
      const o = document.getElementById('inboxOverlay');
      const grey = o.querySelector('[data-missing="1"]');
      const btn = o.querySelector('[data-add="0"]');
      btn.click();
      await new Promise(r => setTimeout(r, 700));
      const card = userCards.find(c => c.front === 'zz-uncollected');
      const out = {
        grey: grey ? grey.textContent.trim() : '',
        label: btn.textContent,
        skill: (calls.find(c => c.cmd === 'ai.ask') || {}).args ? (calls.find(c => c.cmd === 'ai.ask').args.skill || '') : '',
        back: card ? card.back : '', hint: card ? card.hint : '',
        removed: calls.filter(c => c.cmd === 'inbox.remove').map(c => (c.args.ids || []).join(',')),
      };
      o.remove(); state.inbox = []; saveInbox();
      userCards = userCards.filter(c => c.front !== 'zz-uncollected'); saveJSON(LS.userCards, userCards);
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('待确认加入：未收录灰字 + 自动补释义 + inbox.remove',
      fillAdd.grey === '词典未收录 · 加入后自动补释义'
      && fillAdd.label === '已加入' && fillAdd.skill === 'card'
      && fillAdd.back === '未收录释义' && fillAdd.hint === '/ʌn/'
      && fillAdd.removed.includes('smoke-uncol-1'), fillAdd);

    const fillEg = await probe('有例句只求译文', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          const data = m.cmd === 'ai.ask'
            ? { text: JSON.stringify({ back: '敏捷', phonetic: '/kwɪk/', example: 'AI 想换掉的例句', exampleCN: '译'.repeat(300) }) }
            : { ok: true };
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null;
      const card = { front: 'quick', example: 'The quick brown fox jumps.', back: '', hint: '', exampleCN: '' };
      await fillCardMeaning(card);
      const c = calls.find(x => x.cmd === 'ai.ask') || {};
      const input = (c.args && c.args.input) || '';
      const out = {
        hasExampleText: input.includes('The quick brown fox jumps.'),
        forbid: input.includes('不要改写或替换例句'),
        example: card.example, cnLen: (card.exampleCN || '').length,
        back: card.back, hint: card.hint,
      };
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('有例句：prompt 带例句且禁改写，不写 example，exampleCN ≤240',
      fillEg.hasExampleText && fillEg.forbid && fillEg.example === 'The quick brown fox jumps.'
      && fillEg.cnLen === 240 && fillEg.back === '敏捷' && fillEg.hint === '/kwɪk/', fillEg);

    const skipRemove = await probe('跳过即删', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          const data = m.cmd === 'inbox.list' ? [{ id: 'smoke-skip-1', front: 'zz-skipword', back: '释义' }] : { ok: true };
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null; state.inbox = [];
      delete known['zz-skipword'];
      delete inboxDone['id:smoke-skip-1']; delete inboxDone['w:zz-skipword'];
      await pullCoreInbox(); showInboxSheet();
      const o = document.getElementById('inboxOverlay');
      o.querySelector('[data-skip="0"]').click();
      await new Promise(r => setTimeout(r, 100));
      const out = {
        removed: calls.filter(c => c.cmd === 'inbox.remove').map(c => (c.args.ids || []).join(',')),
        knownWhy: (known['zz-skipword'] || {}).why,
        label: o.querySelector('[data-skip="0"]').textContent,
      };
      o.remove(); state.inbox = []; saveInbox();
      delete known['zz-skipword']; saveJSON(LS.known, known);
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('跳过：写 known + 调 inbox.remove',
      skipRemove.removed.includes('smoke-skip-1') && skipRemove.knownWhy === 'skip'
      && skipRemove.label === '已掌握', skipRemove);

    const stale = await probe('过滤项清理', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          const data = m.cmd === 'inbox.list' ? [
            { id: 'stale-done', front: 'zz-stale-done', back: 'x' },
            { id: 'stale-known', front: 'zz-stale-known', back: 'x' },
            { id: 'stale-card', front: 'zz-stale-card', back: 'x' },
            { id: 'fresh-one', front: 'zz-fresh-one', back: 'x' }
          ] : { ok: true };
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null; state.inbox = [];
      known['zz-stale-known'] = { at: Date.now(), why: 'manual' };
      inboxDone['id:stale-done'] = Date.now();
      saveJSON(LS.known, known); saveJSON(LS.inboxDone, inboxDone);
      upsertCard({ front: 'zz-stale-card', back: '已有' });
      await pullCoreInbox();
      const rm = calls.filter(x => x.cmd === 'inbox.remove');
      const out = {
        rmCount: rm.length,
        ids: rm.length ? (rm[0].args.ids || []).slice().sort().join(',') : '',
        inbox: state.inbox.map(x => x.id).join(','),
      };
      userCards = userCards.filter(x => ['zz-stale-card', 'zz-fresh-one'].indexOf(x.front) < 0);
      saveJSON(LS.userCards, userCards);
      delete known['zz-stale-known']; saveJSON(LS.known, known);
      delete inboxDone['id:stale-done']; saveJSON(LS.inboxDone, inboxDone);
      state.inbox = []; saveInbox();
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('首次拉取：被过滤的历史行一次性 inbox.remove',
      stale.rmCount === 1 && stale.ids === 'stale-card,stale-done,stale-known'
      && stale.inbox === 'fresh-one', stale);

    const undo2 = await probe('关面板后撤销', `
      const calls = []; const cbs = [];
      window.zenus = {
        postMessage(raw) {
          const m = JSON.parse(raw); calls.push(m);
          const data = m.cmd === 'inbox.list' ? [{ id: 'undo2-1', front: 'zz-undo2', back: '释义' }] : { ok: true };
          cbs.forEach(cb => cb({ data: JSON.stringify({ id: m.id, ok: true, data }) }));
        },
        addEventListener(t, cb) { if (t === 'message') cbs.push(cb); },
      };
      CTRL = null; state.inbox = [];
      delete known['zz-undo2'];
      delete inboxDone['id:undo2-1']; delete inboxDone['w:zz-undo2'];
      await pullCoreInbox(); showInboxSheet();
      const o = document.getElementById('inboxOverlay');
      o.querySelector('[data-skip="0"]').click();
      o.querySelector('#inboxClose').click();
      await pullCoreInbox();
      const afterClose = { pending: state.inbox.map(x => x.id).join(','), knownWhy: (known['zz-undo2'] || {}).why };
      // 第二条路：app.js 的「已掌握」按钮（#toggleKnown）走的就是 unmarkKnown(word)
      unmarkKnown('zz-undo2');
      await new Promise(r => setTimeout(r, 50));
      const out = {
        afterClose, gone: !known['zz-undo2'],
        nativeUnmark: calls.filter(c => c.cmd === 'learner.unmarkKnown').map(c => c.args.word),
      };
      state.inbox = []; saveInbox();
      window.zenus = undefined; CTRL = null;
      return out;
    `);
    check('跳过→关面板→已掌握撤销：learner.unmarkKnown 被调用',
      undo2.afterClose.pending === '' && undo2.afterClose.knownWhy === 'skip'
      && undo2.gone && undo2.nativeUnmark.includes('zz-undo2'), undo2);

    // Node 侧源码 Gate：负向 4 把 "inbox" -> JSONArray() 加回来必红
    const appSrcGate = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
    const bridgePath = path.join(ROOT, '..', 'aegis-wb', 'app', 'src', 'main', 'java',
      'info', 'plateaukao', 'einkbro', 'zenus', 'ZenusBridge.kt');
    const bridgeSrcGate = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf8') : '';
    check('旧命令已删：PWA 无 nativeCall(inbox)，原生无 inbox -> JSONArray()',
      bridgeSrcGate.length > 0 && !appSrcGate.includes("nativeCall('inbox'")
      && !bridgeSrcGate.includes('"inbox" -> JSONArray()'),
      { pwaOld: appSrcGate.includes("nativeCall('inbox'"), nativeOld: bridgeSrcGate.includes('"inbox" -> JSONArray()') });

    // 配置同步：PWA 的 key 必须推到原生，否则 ai.ask 报「还没配置 AI key」
    const cfg = await probe('AI 配置同步', `
      const calls = [];
      const cbs = [];
      window.zenus = {
        postMessage(json) {
          const m = JSON.parse(json);
          calls.push(m);
          cbs.forEach((cb) => cb({ data: JSON.stringify({ id: m.id, ok: true, data: { ok: true } }) }));
        },
        addEventListener(type, cb) { if (type === 'message') cbs.push(cb); },
      };
      CTRL = null;
      const oldKey = settings.key;
      settings.key = 'sk-smoke';
      await pushAiConfig();
      const c = calls[0] || {};
      window.zenus = undefined; CTRL = null; settings.key = oldKey;
      return { cmd: c.cmd, key: c.args && c.args.apiKey, model: c.args && c.args.model };
    `);
    check('AI 配置同步：启动把 key/model 推给原生',
      cfg.cmd === 'ai.config.set' && cfg.key === 'sk-smoke' && !!cfg.model, cfg);

    // 生词雷达目标语言开关：设置里能选、能回显
    const langSel = await probe('雷达语言', `
      settings.radarLang = 'ja';
      state.tab = 'settings'; render();
      const v = document.getElementById('s-radar-lang').value;
      settings.radarLang = 'auto';
      state.tab = 'review'; render();
      return { v };
    `);
    check('生词雷达目标语言开关可回显', langSel.v === 'ja', langSel);

    // S6：阅读模式打开必须把 reader:true 传给原生
    const openMode = await probe('阅读模式打开', `
      const calls = [];
      const cbs = [];
      window.zenus = {
        postMessage(json) {
          const m = JSON.parse(json);
          calls.push(m);
          cbs.forEach((cb) => cb({ data: JSON.stringify({ id: m.id, ok: true, data: true }) }));
        },
        addEventListener(type, cb) { if (type === 'message') cbs.push(cb); },
      };
      CTRL = null;
      openInBrowser('https://example.com/chapter', true);
      await new Promise((r) => setTimeout(r, 30));
      const c = calls[0] || {};
      window.zenus = undefined; CTRL = null;
      return { cmd: c.cmd, reader: c.args && c.args.reader };
    `);
    check('阅读模式：openUrl 带 reader:true',
      openMode.cmd === 'openUrl' && openMode.reader === true, openMode);

    // 错误可见：手机 WebView 没有控制台，「点了没反应」必须自己能显示出来
    // 负向测试：故意让 renderBrowse 抛错，页面要报错而不是停在旧页面
    const errVisible = await probe('报错可见', `
      const old = renderBrowse;
      renderBrowse = () => { throw new Error('SMOKE_BOOM'); };
      state.tab = 'browse'; render();
      const inView = (document.getElementById('view').textContent || '');
      const bar = document.getElementById('zErrBar');
      const barText = bar ? bar.textContent : '';
      renderBrowse = old;
      state.tab = 'review'; render();
      return { inView, barText };
    `);
    check('render 抛错时页面显示错误（不再停在旧页面）',
      /出错了/.test(errVisible.inView) && /SMOKE_BOOM/.test(errVisible.inView), errVisible);
    check('未捕获错误画到页面并记进 localStorage',
      /SMOKE_BOOM/.test(errVisible.barText || ''), errVisible);

    // 诊断面板要能收集完（不能在手机上卡在「正在收集…」）
    const diag = await probe('诊断面板', `
      const t0 = Date.now();
      const txt = await collectDiag();
      return { okLen: (txt || '').length, ms: Date.now() - t0, hasUA: /UA：/.test(txt), hasIdb: /IndexedDB/.test(txt) };
    `);
    check('诊断面板能收集完且含 UA / IndexedDB 结论',
      diag.okLen > 80 && diag.hasUA && diag.hasIdb && diag.ms < 20000, diag);

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

  // 构建版本一致性：index.html 的 app.js?v= 必须跟 BUILD 同步。
  // 2026-11-15 发版时 .23 没跟着改，手机吃旧缓存，人看到的是半新半旧 —— 固化成断言，别再靠记性。
  try {
    const fs = require('fs');
    const build = (fs.readFileSync('app.js', 'utf8').match(/const BUILD = '([^']+)'/) || [])[1];
    const v = (fs.readFileSync('index.html', 'utf8').match(/app\.js\?v=([^"'&]+)/) || [])[1];
    check('index.html 的 app.js?v 与 BUILD 一致', !!build && build === v, { build, v });
  } catch (e) {
    check('index.html 的 app.js?v 与 BUILD 一致', false, { err: e.message });
  }

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  if (bad.length) { console.log('失败项：' + bad.map((b) => b.name).join('；')); process.exit(1); }
  process.exit(0);
})().catch((e) => {
  console.error('SMOKE 崩了：' + e.message);
  process.exit(e.message === 'ENV' ? 2 : 1);
});
