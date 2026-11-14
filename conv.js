'use strict';
// ── 文本档案 + 转换管线（A 批 · 地基，不含 UI）────────────────────────
//
// 一份「文本档案」= 一份文档转出来的纯文本：段落 + 每段来源 + 页码映射 + 指纹。
// 它跟阅读器里的 RDR.book 不是一回事：
//   RDR.book   给屏幕渲染用（HTML 片段、图片 url、排版），关掉就重建
//   archive    给听书 / AI / 同步用（纯文本 + 来源 + 页号），落 IndexedDB，可重跑
//
// 四级降级（SPEC §3），产出同一种档案：
//   1 阅读模式抽 DOM     文章页最快最准
//   2 抽字（PDF 文字层）  pdf.js getTextContent → 按 Y 聚行（Koodo 的做法）
//                        DOCX/EPUB/TXT/MD 走各自的结构化抽字，同样算第 2 级
//   3 截图 → OCR         扫描件 / 图片页（自托管 Tesseract，中文+英文）
//   4 只存档             全不行：留 HTML 快照，标「仅收藏，不能听」
//
// 必须做到（SPEC §3）：
//   每段标来源；档案带指纹（文件 hash + 转换器版本 + 清洗提示词版本）；
//   可重跑、覆盖前先留旧档；可暂停可续跑；覆盖率 / 失败页 / 转换时间可见；
//   质量不达标 → verdict='incomplete'，playable=false（不许显示成可以听）。
//
// 为什么单独一个文件：app.js 已经 7400 行，管线是纯函数 + 一张表，塞进去更难验。
// 这个文件不依赖 app.js 的任何内部变量，只依赖 vendor/ 下的 pdf.js、jszip、ocr。

window.ZConv = (function () {
  const CONV_VERSION = 'conv-2026-11-13.1';
  const CLEAN_PROMPT_VERSION = 'clean-2026-11-13.1';

  const DB_NAME = 'zenus_materials';       // 跟 materials 同一个库，旁边两个新 store
  const DB_VER = 2;
  const S_MAT = 'materials';               // 旧的正文缓存（app.js 写）
  const S_DOC = 'documents';               // 文档身份：一份文件一条
  const S_ARC = 'archives';                // 档案版本：每次转换一条

  const SRC = { DOM: 'dom', TEXT: 'text', OCR: 'ocr', AI: 'ai' };
  const LEVEL = {
    1: '阅读模式抽 DOM',
    2: '抽字（文字层）',
    3: 'OCR',
    4: '仅存档',
  };

  // 阈值先用保守值。10 份真实文件量完基线再定（证据写进 DECISIONS.md），
  // 改这里等于改判定口径，改前先看基线报告。
  const TH = {
    minChars: 200,        // 全文最少字数，少于这个当「没抽到」
    minParas: 3,          // 最少段落数
    minPageChars: 30,     // 单页最少字数，低于此算失败页
    minBodyRatio: 0.35,   // 正文占页面全文的比例（HTML 抽正文用）
    maxFailRatio: 0,      // 失败页比例上限：一页都不许坏
    keepVersions: 3,      // 每份文档留几版档案（覆盖前留旧档）
    maxPages: 400,        // 一次最多转多少页，防 50MB 手册把页面拖死
  };

  // ── 小工具 ─────────────────────────────────────────
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowIso = () => new Date().toISOString();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function cjk(ch) {
    if (!ch) return false;
    const c = ch.codePointAt(0);
    return (c >= 0x2e80 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af)
      || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xffef);
  }

  async function sha256Hex(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const d = await crypto.subtle.digest('SHA-256', u8);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function kindOf(name) {
    const n = String(name || '').toLowerCase();
    if (n.endsWith('.pdf')) return 'pdf';
    if (n.endsWith('.epub')) return 'epub';
    if (n.endsWith('.docx')) return 'docx';
    if (n.endsWith('.md')) return 'md';
    if (n.endsWith('.txt')) return 'txt';
    if (/\.(png|jpe?g|webp|gif|bmp)$/.test(n)) return 'image';
    if (/\.(html?|xhtml)$/.test(n)) return 'html';
    return 'text';
  }

  // ── IndexedDB ─────────────────────────────────────
  // 和 app.js 的 idbOpen 是同一个库、同一套 store；两边都做「缺了就建」，
  // 谁先打开都不会把另一边的数据弄丢。版本号必须一致（都是 2），否则会 VersionError。
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB 打开超时（' + DB_NAME + '）'));
      }, 8000);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(S_MAT)) db.createObjectStore(S_MAT, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(S_DOC)) {
          const s = db.createObjectStore(S_DOC, { keyPath: 'docId' });
          s.createIndex('fileHash', 'fingerprint.fileHash', { unique: false });
        }
        if (!db.objectStoreNames.contains(S_ARC)) {
          const a = db.createObjectStore(S_ARC, { keyPath: 'id' });
          a.createIndex('docId', 'docId', { unique: false });
        }
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (settled) { try { req.result.close(); } catch (e) { /* 忽略 */ } return; }
        settled = true;
        resolve(req.result);
      };
      req.onerror = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(req.error);
      };
      req.onblocked = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(new Error('IndexedDB 被占用（' + DB_NAME + '）'));
      };
    });
  }

  async function dbGet(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbAll(store) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbPut(store, rec) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(rec);
      tx.oncomplete = () => resolve(rec);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function dbDel(store, key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ── 库里的三类记录 ────────────────────────────────
  // documents: 一份文件一条，回答「这份材料现在用哪版档案」
  async function docGet(docId) { return dbGet(S_DOC, docId); }
  async function docAll() { return dbAll(S_DOC); }
  async function arcGet(id) { return dbGet(S_ARC, id); }
  async function arcAll() { return dbAll(S_ARC); }
  async function arcListOf(docId) {
    const all = await dbAll(S_ARC);
    return all.filter((a) => a.docId === docId).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  }
  async function arcCurrent(docId) {
    const doc = await docGet(docId);
    if (!doc || !doc.currentArchiveId) return null;
    return arcGet(doc.currentArchiveId);
  }

  async function docSave(doc) {
    // 版本上限：留着旧档能对照，但不能无限长
    doc.archiveIds = Array.from(new Set(doc.archiveIds || [])).slice(-TH.keepVersions);
    await dbPut(S_DOC, doc);
    return doc;
  }

  async function pruneArchives(doc) {
    const ids = await (async () => {
      const all = await arcAll();
      return all.filter((a) => a.docId === doc.docId).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0)).map((a) => a.id);
    })();
    const keep = new Set(doc.archiveIds || []);
    for (const id of ids) if (!keep.has(id)) await dbDel(S_ARC, id);
  }

  // ── 质量判定 ──────────────────────────────────────
  // 只有「抽到了、抽全了」才允许 playable=true。宁可标红，不许当好材料。
  function coverageOf({ pages, paragraphs, allChars, ms, startedAt, partial, nextPage, docPages }) {
    const chars = paragraphs.reduce((n, p) => n + String(p.text || '').length, 0);
    const paras = paragraphs.length;
    const pg = (pages && pages.length) ? pages : [{ i: 1, chars, paras, ok: true }];
    const failPages = pg.filter((p) => !p.ok).map((p) => ({ i: p.i, chars: p.chars || 0, reason: p.reason || '' }));
    const bodyRatio = (typeof allChars === 'number' && allChars > 0) ? (chars / allChars) : null;
    const reasons = [];
    if (chars < TH.minChars) reasons.push('字数太少（' + chars + ' < ' + TH.minChars + '）');
    if (paras < TH.minParas) reasons.push('段落太少（' + paras + ' < ' + TH.minParas + '）');
    if (bodyRatio != null && bodyRatio < TH.minBodyRatio) {
      reasons.push('正文占比低（' + Math.round(bodyRatio * 100) + '% < ' + Math.round(TH.minBodyRatio * 100) + '%）');
    }
    if (pg.length && (failPages.length / pg.length) > TH.maxFailRatio) {
      reasons.push('失败页 ' + failPages.length + '/' + pg.length);
    }
    return {
      pages: pg.length,
      docPages: docPages || pg.length,
      pagesOk: pg.length - failPages.length,
      pagesFail: failPages.length,
      failPages,
      chars,
      paras,
      bodyRatio,
      reasons,
      ms: ms || 0,
      startedAt: startedAt || Date.now(),
      finishedAt: Date.now(),
      partial: !!partial,
      nextPage: nextPage || null,
    };
  }

  function verdictOf(coverage) {
    if (coverage.partial) return 'partial';
    return coverage.reasons.length ? 'incomplete' : 'ok';
  }

  // ── PDF：按 Y 聚行，再按行距分段 ──────────────────
  // pdf.js 的 item 自带 transform（[a,b,c,d,e,f]，e=x，f=y）和 height。
  // 同一行的 item y 差不超过 5（Koodo 的经验值），聚完按 x 排序拼成一行；
  // 行距明显变大就当分段 —— 不靠字号/字体猜，扫描件和无样式 PDF 也适用。
  function pdfRows(items) {
    const rows = [];
    for (const it of items) {
      if (!it || !it.str || !String(it.str).trim()) continue;
      const y = it.transform[5];
      const h = Math.abs(it.height || it.transform[3] || 10) || 10;
      let row = null;
      for (const r of rows) { if (Math.abs(r.y - y) <= 5) { row = r; break; } }
      if (!row) { row = { y, h, items: [] }; rows.push(row); }
      row.items.push({ x: it.transform[4], str: String(it.str), w: Math.abs(it.width || 0), h });
      if (h > row.h) row.h = h;
    }
    rows.sort((a, b) => b.y - a.y);                     // PDF 的 y 轴向上，先读上面
    return rows.map((r) => {
      r.items.sort((a, b) => a.x - b.x);
      let text = '';
      let end = null;
      for (const it of r.items) {
        if (end !== null) {
          const gap = it.x - end;
          if (gap > it.h * 0.3 && !cjk(text.slice(-1)) && !cjk(it.str[0])) text += ' ';
        }
        text += it.str;
        end = it.x + it.w;
      }
      return { text: text.replace(/[ \t\u00a0]+/g, ' ').trim(), y: r.y, h: r.h };
    }).filter((l) => l.text);
  }

  function rowToParas(rows) {
    const out = [];
    let cur = '';
    let prev = null;
    for (const r of rows) {
      if (prev) {
        const gap = Math.abs(prev.y - r.y);
        const step = Math.max(prev.h, r.h) || 10;
        if (gap > step * 1.75 && cur) { out.push(cur); cur = ''; }
      }
      if (!cur) cur = r.text;
      else if (/[-\u2010\u2011]$/.test(cur) && /^[a-z\u00e0-\u00ff]/i.test(r.text)) cur = cur.slice(0, -1) + r.text;
      else if (cjk(cur.slice(-1)) || cjk(r.text[0])) cur += r.text;
      else cur += ' ' + r.text;
      prev = r;
    }
    if (cur) out.push(cur);
    return out.filter((p) => p.trim().length > 0);
  }

  // ── 库加载 ────────────────────────────────────────
  const libOnce = {};
  function loadScript(src) {
    if (libOnce[src]) return libOnce[src];
    libOnce[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => { delete libOnce[src]; el.remove(); reject(new Error('加载失败 ' + src)); };
      document.head.appendChild(el);
    });
    return libOnce[src];
  }

  async function ensureLib(url, globalName) {
    if (window[globalName]) return window[globalName];
    await loadScript(url);
    if (!window[globalName]) throw new Error(globalName + ' 没加载成功（' + url + '）');
    return window[globalName];
  }

  async function ensurePdfJs() {
    await ensureLib('vendor/pdf.min.js', 'pdfjsLib');
    if (window.pdfjsLib && window.pdfjsLib.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    return window.pdfjsLib;
  }

  // ── 语言 ──────────────────────────────────────────
  // 按 PDF 元数据（dc:language）选，选不到用默认；不做每页检测（SPEC §4）。
  function langFromMeta(meta, fallback) {
    const raw = [];
    try { if (meta && meta.info) raw.push(meta.info.Language, meta.info.Lang); } catch (e) { /* 忽略 */ }
    try { if (meta && meta.metadata && meta.metadata.get) raw.push(meta.metadata.get('dc:language')); } catch (e) { /* 忽略 */ }
    const s = raw.filter(Boolean).join(' ').toLowerCase();
    if (/zh|chi|cmn|hant|hans/.test(s)) return 'zh';
    if (/\bja\b|jpn/.test(s)) return 'ja';
    if (/\bko\b|kor/.test(s)) return 'ko';
    if (/\bfr\b|fre|fra/.test(s)) return 'fr';
    if (/\bde\b|ger|deu/.test(s)) return 'de';
    if (/\ben\b|eng/.test(s)) return 'en';
    return fallback || '';
  }

  function guessLangByText(text) {
    const t = String(text || '').slice(0, 2000);
    let zh = 0, latin = 0, kana = 0, hangul = 0;
    for (const ch of t) {
      const c = ch.codePointAt(0);
      if (c >= 0x3040 && c <= 0x30ff) kana++;
      else if (c >= 0xac00 && c <= 0xd7af) hangul++;
      else if (c >= 0x4e00 && c <= 0x9fff) zh++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    }
    if (kana > 20) return 'ja';
    if (hangul > 20) return 'ko';
    if (zh > 20) return 'zh';
    if (latin > 20) return 'en';
    return '';
  }

  // ── 第 3 级：OCR（自托管 Tesseract，中文 + 英文）─────
  // 只有 chi_sim / eng 两个识别模型（vendor/ocr/）。其他语言如实报「模型没装」，
  // 不许拿中文模型硬认德语 —— 那样出来的字看着像真的，才是最坏的情况。
  const OCR_LANG = { zh: 'chi_sim', en: 'eng' };
  let ocrWorkerPromise = null;

  async function ocrWorker(T) {
    if (ocrWorkerPromise) return ocrWorkerPromise;
    ocrWorkerPromise = T.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: 'vendor/ocr/worker.min.js',
      corePath: 'vendor/ocr/tesseract-core-simd-lstm.wasm.js',
      langPath: 'vendor/ocr/',
    });
    return ocrWorkerPromise;
  }

  async function ocrPageCanvas(pdf, pageNo, lang) {
    if (!OCR_LANG[lang]) return { lines: [], reason: 'ocr-lang-unavailable:' + (lang || 'unknown') };
    const T = await ensureLib('vendor/ocr/tesseract.min.js', 'Tesseract');
    const page = await pdf.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const scale = clamp(1800 / base.width, 1.5, 4);
    const vp = page.getViewport({ scale: scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const worker = await ocrWorker(T);
    const { data } = await worker.recognize(canvas);
    const lines = String(data.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return { lines, reason: lines.length ? '' : 'ocr-empty' };
  }

  async function ocrDone() {
    if (!ocrWorkerPromise) return;
    try { const w = await ocrWorkerPromise; await w.terminate(); } catch (e) { /* 已结束 */ }
    ocrWorkerPromise = null;
  }

  // ── 第 2 级：PDF 文字层 ───────────────────────────
  // 逐页抽；单页抽不到（扫描件）先记失败页，等第 3 级补。
  async function pdfExtract(bytes, { name, maxPages, levels, lang, onPage, resume }) {
    const pdfjsLib = await ensurePdfJs();
    const pdf = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: 'vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'vendor/standard_fonts/',
    }).promise;
    const total = Math.min(pdf.numPages, TH.maxPages);
    const docPages = pdf.numPages;
    let meta = null;
    try { meta = await pdf.getMetadata(); } catch (e) { /* 有的 PDF 没元数据 */ }
    const langUsed = lang || langFromMeta(meta, '');
    const paragraphs = [];
    const pages = [];
    let startPage = 1;
    if (resume && resume.nextPage) startPage = resume.nextPage;
    let paused = false;
    let nextPage = null;
    let ocrPages = 0;

    for (let n = startPage; n <= total; n++) {
      let chars = 0;
      let paras = 0;
      let ok = false;
      let reason = '';
      try {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        const rows = pdfRows(tc.items || []);
        const ps = rowToParas(rows);
        for (const text of ps) {
          paragraphs.push({ i: paragraphs.length, text, src: SRC.TEXT, page: n, y: null, conf: null });
          chars += text.length;
          paras++;
        }
        ok = chars >= TH.minPageChars;
        if (!ok) reason = '文字层只有 ' + chars + ' 字（疑似扫描页）';
      } catch (err) {
        reason = '取页失败：' + err.message;
      }
      // 第 3 级：这一页抽不到，OCR 补这一页
      if (!ok && levels.includes(3) && !paused) {
        try {
          const r = await ocrPageCanvas(pdf, n, langUsed);
          if (r.lines.length) {
            for (const text of r.lines) {
              paragraphs.push({ i: paragraphs.length, text, src: SRC.OCR, page: n, y: null, conf: null });
              chars += text.length;
              paras++;
            }
            ok = chars >= TH.minPageChars;
            reason = ok ? '' : (reason + '；OCR 后仍不足');
            ocrPages++;
          } else if (r.reason) {
            reason += '；' + r.reason;
          }
        } catch (err) {
          reason += '；OCR 失败：' + err.message;
        }
      }
      pages.push({ i: n, chars, paras, ok, reason });
      if (onPage) onPage({ page: n, total, chars, ok });
      // 分批跑：到点先落盘，下次从 nextPage 续
      if (maxPages && n >= startPage + maxPages - 1 && n < total) {
        paused = true;
        nextPage = n + 1;
        break;
      }
    }
    await ocrDone();
    try { await pdf.destroy(); } catch (e) { /* 忽略 */ }
    // 超过单次上限（TH.maxPages）也按「没转完」处理：不许拿 400 页的覆盖冒充整本
    if (!paused && total < docPages) {
      paused = true;
      nextPage = total + 1;
    }
    return { total, docPages, pages, paragraphs, langUsed, level: ocrPages ? 3 : 2, paused, nextPage };
  }

  // ── 第 1 级：HTML 抽 DOM ──────────────────────────
  // 先砍掉明显不是正文的块，再挑「段落文字最多、链接密度最低」的容器。
  // 注意：按 class 砍要留余地 —— 只看名字就删，碰上「整页包在 <div class="sidebar"> 里」
  // 的站就直接把正文删干净了（`_dom_course3.html` 实测过）。所以 class 只砍又小又全是链接的块。
  const KILL_TAGS = 'script,style,noscript,iframe,svg,form,button,input,select,nav,header,footer';
  const JUNK_CLASS = /(^|[\s_-])(nav|menu|comment|comments|sidebar|footer|header|ad|ads|advert|share|related|breadcrumb|pager|pagination|toolbar|banner|popup|modal|cookie)([\s_-]|$)/i;

  function killJunk(doc) {
    try { doc.querySelectorAll(KILL_TAGS).forEach((el) => el.remove()); } catch (e) { /* 忽略 */ }
    if (!doc.body) return;
    const bodyLen = Math.max(1, String(doc.body.textContent || '').length);
    doc.querySelectorAll('div,section,aside,ul,ol').forEach((el) => {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!cls || !JUNK_CLASS.test(cls)) return;
      const len = String(el.textContent || '').trim().length;
      const linkLen = Array.from(el.querySelectorAll('a'))
        .reduce((n, a) => n + String(a.textContent || '').trim().length, 0);
      if (len < 200 || linkLen / Math.max(len, 1) > 0.5) el.remove();
    });
  }

  function visibleChars(root) {
    if (!root) return 0;
    let n = 0;
    root.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,td').forEach((el) => {
      if (el.closest('script,style,noscript')) return;
      n += (el.textContent || '').trim().length;
    });
    if (!n) n = (root.textContent || '').trim().length;
    return n;
  }

  function pickMain(body) {
    let best = body;
    let bestScore = -1;
    body.querySelectorAll('article,main,section,div').forEach((el) => {
      const ps = el.querySelectorAll('p');
      if (ps.length < 2) return;
      let textLen = 0;
      ps.forEach((p) => { textLen += (p.textContent || '').trim().length; });
      // 小容器（页脚署名那种）不可能是正文，直接不看
      if (textLen < 120) return;
      const links = el.querySelectorAll('a');
      let linkLen = 0;
      links.forEach((a) => { linkLen += (a.textContent || '').trim().length; });
      // 链接多要扣分，但不能判死刑：目录页/书源页正文本身就以链接为主
      const ratio = clamp(linkLen / Math.max(textLen, 1), 0, 1);
      const score = textLen * (1 - 0.6 * ratio);
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return bestScore >= 0 ? best : body;
  }

  function blocksOf(root) {
    if (!root) return [];
    const sel = 'p,h1,h2,h3,h4,h5,h6,blockquote,pre,li,tr';
    const all = Array.from(root.querySelectorAll(sel));
    const set = new Set(all);
    const out = [];
    for (const el of all) {
      // 嵌套块只留最外层，否则 <li><p>..</p></li> 会被数两遍
      let anc = el.parentElement;
      let nested = false;
      while (anc && anc !== root.parentElement) {
        if (set.has(anc)) { nested = true; break; }
        anc = anc.parentElement;
      }
      if (nested) continue;
      let text = '';
      if (el.tagName === 'TR') {
        const cells = Array.from(el.children).map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
        text = cells.filter(Boolean).join(' | ');
      } else {
        text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      }
      if (!text) continue;
      out.push({ text, tag: el.tagName.toLowerCase() });
    }
    return out;
  }

  // 有些正文页没有 <p>：整章文字塞在一个 div 里，靠 <br> 和换行排版（中文小说站很常见）。
  // 按块抽不到多少字时，退到「按 <br>/换行切段」。
  function textBlocksOf(root) {
    if (!root) return [];
    const clone = root.cloneNode(true);
    try { clone.querySelectorAll('br').forEach((b) => b.replaceWith('\n')); } catch (e) { /* 忽略 */ }
    return String(clone.textContent || '')
      .split(/\n+/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((text) => ({ text, tag: 'text' }));
  }

  // 一段超过 1200 字就在句号处切开：一段一整章没法定位（听书按段累加位置），
  // 也没法在屏幕上读。
  function splitLongBlocks(blocks, max) {
    const limit = max || 1200;
    const out = [];
    for (const b of blocks) {
      if (b.text.length <= limit * 1.5) { out.push(b); continue; }
      let rest = b.text;
      while (rest.length > limit) {
        let cut = -1;
        for (let i = limit; i > limit * 0.5; i--) {
          if (/[。！？.!?；;]/.test(rest[i])) { cut = i + 1; break; }
        }
        if (cut < 0) cut = limit;
        out.push({ text: rest.slice(0, cut).trim(), tag: b.tag });
        rest = rest.slice(cut).trim();
      }
      if (rest) out.push({ text: rest, tag: b.tag });
    }
    return out.filter((b) => b.text);
  }

  function htmlExtract(html, name) {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    killJunk(doc);
    const allChars = visibleChars(doc.body);
    const main = pickMain(doc.body);
    let blocks = splitLongBlocks(blocksOf(main));
    const blockChars = blocks.reduce((n, b) => n + b.text.length, 0);
    const rootChars = String(main.textContent || '').replace(/\s+/g, ' ').trim().length;
    // 块元素只覆盖到一半的文字 → 正文根本没写在 <p> 里（中文小说站的常见排版），
    // 退到「按 <br>/换行切段」。不退就只剩标题和导航，看着像抽到了，其实全是空的。
    if (rootChars > 0 && blockChars < rootChars * 0.5) blocks = splitLongBlocks(textBlocksOf(main));
    const paragraphs = blocks.map((b, i) => ({
      i, text: b.text, src: SRC.DOM, page: 1, y: null, conf: null, tag: b.tag,
    }));
    const chars = paragraphs.reduce((n, p) => n + p.text.length, 0);
    return {
      paragraphs,
      pages: [{ i: 1, chars, paras: paragraphs.length, ok: chars >= TH.minPageChars, reason: chars >= TH.minPageChars ? '' : '正文只有 ' + chars + ' 字' }],
      allChars,
      level: 1,
      langUsed: guessLangByText(paragraphs.map((p) => p.text).join(' ')),
    };
  }

  // ── 其他格式（算第 2 级：结构化抽字）──────────────
  function chaptersFromBlocks(chapterList) {
    const paragraphs = [];
    const pages = [];
    chapterList.forEach((ch, ci) => {
      const pageNo = ci + 1;
      let chars = 0;
      let paras = 0;
      for (const b of ch.blocks) {
        if (!b.text) continue;
        paragraphs.push({ i: paragraphs.length, text: b.text, src: b.src || SRC.DOM, page: pageNo, y: null, conf: null, title: b.title || '' });
        chars += b.text.length;
        paras++;
      }
      pages.push({ i: pageNo, chars, paras, ok: chars >= TH.minPageChars, reason: chars >= TH.minPageChars ? '' : '这一章只有 ' + chars + ' 字' });
    });
    return { paragraphs, pages, level: 2, langUsed: guessLangByText(paragraphs.slice(0, 40).map((p) => p.text).join(' ')) };
  }

  async function epubExtract(bytes) {
    const JSZip = await ensureLib('vendor/jszip.min.js', 'JSZip');
    const zip = await JSZip.loadAsync(bytes);
    const container = await zip.file('META-INF/container.xml');
    if (!container) throw new Error('EPUB 缺 META-INF/container.xml');
    const cdoc = new DOMParser().parseFromString(await container.async('text'), 'application/xml');
    const rootfile = cdoc.querySelector('rootfile');
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB 找不到 OPF');
    const opf = await zip.file(opfPath);
    if (!opf) throw new Error('EPUB 的 OPF 打不开：' + opfPath);
    const odoc = new DOMParser().parseFromString(await opf.async('text'), 'application/xml');
    const baseDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const items = {};
    odoc.querySelectorAll('manifest > item').forEach((it) => {
      items[it.getAttribute('id')] = it.getAttribute('href') || '';
    });
    const chapters = [];
    for (const ref of odoc.querySelectorAll('spine > itemref')) {
      let href = items[ref.getAttribute('idref')];
      if (!href) continue;
      href = decodeURIComponent(href.split('#')[0]);
      const f = zip.file(baseDir + href);
      if (!f) continue;
      const html = await f.async('text');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      try { doc.querySelectorAll(KILL).forEach((el) => el.remove()); } catch (e) { /* 忽略 */ }
      const blocks = blocksOf(pickMain(doc.body));
      if (blocks.length) chapters.push({ blocks });
    }
    if (!chapters.length) throw new Error('EPUB 里没有可读的章节');
    return chaptersFromBlocks(chapters);
  }

  async function docxExtract(bytes) {
    const JSZip = await ensureLib('vendor/jszip.min.js', 'JSZip');
    const zip = await JSZip.loadAsync(bytes);
    const f = zip.file('word/document.xml');
    if (!f) throw new Error('DOCX 缺 word/document.xml');
    const xml = await f.async('text');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const body = doc.documentElement;
    const blocks = [];
    // 只走 w:p（段落）和 w:tbl（表格行），其余排版忽略
    const walk = (node) => {
      for (const child of Array.from(node.children)) {
        const tag = child.tagName.replace(/^.*:/, '');
        if (tag === 'p') {
          const text = Array.from(child.getElementsByTagName('*'))
            .filter((e) => e.tagName.replace(/^.*:/, '') === 't')
            .map((e) => e.textContent || '').join('')
            .replace(/\s+/g, ' ').trim();
          const style = child.getElementsByTagName('*');
          let title = '';
          for (const e of style) {
            if (e.tagName.replace(/^.*:/, '') === 'pStyle') title = e.getAttribute('w:val') || '';
          }
          if (text) blocks.push({ text, src: SRC.DOM, title });
        } else if (tag === 'tbl') {
          for (const tr of Array.from(child.getElementsByTagName('*'))) {
            if (tr.tagName.replace(/^.*:/, '') !== 'tr') continue;
            const cells = [];
            for (const tc of Array.from(tr.children)) {
              if (tc.tagName.replace(/^.*:/, '') !== 'tc') continue;
              const t = Array.from(tc.getElementsByTagName('*'))
                .filter((e) => e.tagName.replace(/^.*:/, '') === 't')
                .map((e) => e.textContent || '').join('').replace(/\s+/g, ' ').trim();
              if (t) cells.push(t);
            }
            if (cells.length) blocks.push({ text: cells.join(' | '), src: SRC.DOM });
          }
        } else {
          walk(child);
        }
      }
    };
    walk(body);
    if (!blocks.length) throw new Error('DOCX 里没抽到文字');
    return chaptersFromBlocks([{ blocks }]);
  }

  function plainExtract(text, name, kind) {
    const t = String(text || '').replace(/\r\n?/g, '\n');
    let paras;
    if (kind === 'md') {
      paras = t.split(/\n{2,}/).map((s) => s.replace(/^#{1,6}\s*/gm, '').replace(/^>\s?/gm, '').replace(/[*_`]{1,3}/g, '').trim()).filter(Boolean);
    } else {
      paras = t.split(/\n{2,}/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (paras.length < 3) paras = t.split('\n').map((s) => s.trim()).filter(Boolean);   // 没空行就按行分
    }
    const blocks = paras.map((p) => ({ text: p, src: SRC.TEXT }));
    return chaptersFromBlocks([{ blocks }]);
  }

  // ── 主入口 ────────────────────────────────────────
  // input: {file} | {bytes, name} | {html, name} | {text, name, kind}
  // opts:  {levels:[1,2,3,4], maxPages, lang, onPage, resume, keepBytes}
  async function convert(input, opts) {
    const o = opts || {};
    const t0 = Date.now();
    const startedAt = t0;
    const levels = Array.isArray(o.levels) && o.levels.length ? o.levels : [1, 2, 3, 4];
    const name = input.name || (input.file && input.file.name) || '未命名材料';
    const kind = input.kind || kindOf(name);
    let bytes = input.bytes || null;
    if (!bytes && input.file) bytes = new Uint8Array(await input.file.arrayBuffer());

    let hashSource = bytes;
    if (!hashSource && typeof input.html === 'string') hashSource = new TextEncoder().encode(input.html);
    if (!hashSource && typeof input.text === 'string') hashSource = new TextEncoder().encode(input.text);
    const fileHash = input.fileHash || (hashSource ? await sha256Hex(hashSource) : 'no-bytes-' + name);
    const docId = 'doc-' + fileHash.slice(0, 16);
    const fingerprint = { fileHash, convVersion: CONV_VERSION, promptVersion: CLEAN_PROMPT_VERSION, pipeline: 'conv/1' };

    // 续跑：上一次「分批跑」停在 nextPage，从那里接着抽，结果拼回同一份逻辑档案
    let prev = null;
    if (o.resume) {
      prev = typeof o.resume === 'string' ? await arcGet(o.resume) : o.resume;
      if (prev && prev.docId !== docId) prev = null;     // 文件变了就不能续跑
    }

    // 第 4 级要留的原文（PDF/EPUB 的字节不在这里解，太大；只留文本类）
    let snapshotText = typeof input.html === 'string' ? input.html
      : (typeof input.text === 'string' ? input.text : '');
    if (!snapshotText && bytes && (kind === 'html' || kind === 'txt' || kind === 'md' || kind === 'web')) {
      try { snapshotText = new TextDecoder().decode(bytes); } catch (e) { snapshotText = ''; }
    }
    // 「原文」给人看的是文字，不是标签；HTML 先剥成纯文本再存
    if (snapshotText && kind === 'html') {
      try {
        const d = new DOMParser().parseFromString(snapshotText, 'text/html');
        const plain = (d.body && d.body.textContent) || '';
        if (plain.trim()) snapshotText = plain.replace(/\s+/g, ' ').trim();
      } catch (e) { /* 解析不了就保留原样 */ }
    }

    let result = null;
    let partial = false;
    let nextPage = null;

    // 第 1 级：只对 HTML 有意义（PDF/DOCX 没有 DOM 可抽）
    if (levels.includes(1) && kind === 'html') {
      let html = input.html;
      if (html == null && bytes) html = new TextDecoder().decode(bytes);
      try { result = htmlExtract(html, name); } catch (err) { result = null; o.onError && o.onError(1, err); }
      if (result) {
        const cov = coverageOf({ pages: result.pages, paragraphs: result.paragraphs, allChars: result.allChars, ms: Date.now() - t0, startedAt });
        if (verdictOf(cov) !== 'ok') result = { ...result, badCoverage: cov, level: 1 };
      }
      if (result && !result.badCoverage) { /* 抽全了，不再降级 */ }
      else if (result && result.badCoverage) {
        // 抽不全：先给第 2/3 级一次机会，最后实在不行再退回这份（标红）
        result = { weak: result };
      } else result = null;
    }

    // 第 2 级：抽字
    if (!result || result.weak) {
      const weak = result && result.weak;
      let r2 = null;
      try {
        if (levels.includes(2)) {
          if (kind === 'pdf' && bytes) {
            r2 = await pdfExtract(bytes, {
              name, maxPages: o.maxPages, levels, lang: o.lang, onPage: o.onPage,
              resume: prev ? { nextPage: prev.nextPage } : (o.resume && o.resume.nextPage ? o.resume : null),
            });
            partial = !!r2.paused;
            nextPage = r2.nextPage;
            if (prev && !prev.clean) {
              // 把上次的页和段落拼在前面；页码天然连续，不用重排
              r2.paragraphs = (prev.paragraphs || []).concat(r2.paragraphs)
                .map((p, i) => ({ ...p, i }));
              r2.pages = (prev.pages || []).concat(r2.pages);
            }
          } else if (kind === 'epub' && bytes) {
            r2 = await epubExtract(bytes);
          } else if (kind === 'docx' && bytes) {
            r2 = await docxExtract(bytes);
          } else if ((kind === 'md' || kind === 'txt' || kind === 'text' || kind === 'web')
            && (bytes || typeof input.text === 'string')) {
            const txt = typeof input.text === 'string' ? input.text : new TextDecoder().decode(bytes);
            r2 = plainExtract(txt, name, kind === 'web' ? 'txt' : kind);
          }
          // HTML 没有第 2 级的网页实现：真实链路是「WebView 打印成 PDF」（原生 bridge，
          // 网页里没有）。去掉第 1 级就该一路掉到第 4 级并报红 —— 不许拿「剥标签」冒充抽字，
          // 那样正文里混进导航和页脚，界面上却是绿的。
        }
      } catch (err) {
        o.onError && o.onError(2, err);
        r2 = null;
      }
      if (r2) {
        const cov = coverageOf({ pages: r2.pages, paragraphs: r2.paragraphs, allChars: weak ? weak.allChars : null, ms: Date.now() - t0, startedAt, partial, nextPage, docPages: r2.docPages });
        // 第 3 级已经在 pdfExtract 里按页补过了，这里只判分数
        if (verdictOf(cov) === 'ok' || partial || (r2.level === 3 && verdictOf(cov) === 'incomplete' && cov.chars >= TH.minChars)) {
          result = r2;
        } else if (weak && weak.paragraphs.length > r2.paragraphs.length) {
          result = weak;                     // 抽字还不如 DOM，就用 DOM 那份（标红由 coverage 判）
        } else {
          result = r2;
        }
      } else if (weak) {
        result = weak;
      }
    }

    // 第 4 级：只存档
    let level = 4;
    if (result && result.paragraphs) level = result.level || 4;
    const paragraphs = (result && result.paragraphs) ? result.paragraphs : [];
    const pages = (result && result.pages) ? result.pages : [];
    const coverage = coverageOf({
      pages, paragraphs, allChars: result && result.allChars, ms: Date.now() - t0, startedAt, partial, nextPage,
      docPages: result && result.docPages,
    });
    // 分辨率护栏：短边不足 1600 的扫描件识别不可靠，必须标红，不许当可听
    if (o.lowRes) coverage.reasons.push("识别分辨率低（短边 < 1600），结果不可靠");
    const verdict = verdictOf(coverage);
    const archive = {
      id: docId + '@' + startedAt.toString(36),
      docId,
      name,
      kind,
      level,
      levelName: LEVEL[level] || '',
      lang: (result && result.langUsed) || o.lang || '',
      fingerprint,
      paragraphs,
      pages,
      pageMap: pages.map((p) => ({ page: p.i, from: p.paras ? 1 : 0, to: 0 })).length ? buildPageMap(paragraphs) : [],
      coverage,
      verdict,
      playable: verdict === 'ok' && level < 4,
      partial,
      nextPage,
      clean: null,
      // 第 4 级「仅存档」：把原文留一份快照，卡片上写「仅收藏」，用户还能切回原文看
      snapshot: (result && result.paragraphs && result.paragraphs.length) ? null : {
        text: String(snapshotText).slice(0, 200000),
        at: Date.now(),
      },
      view: 'text',
      startedAt,
      finishedAt: Date.now(),
    };
    await dbPut(S_ARC, archive);
    // 文档身份：currentArchiveId 指向最新一版，旧版留着对照
    const doc = (await docGet(docId)) || {
      docId, name, kind, createdAt: startedAt, fingerprint, archiveIds: [], deletedAt: null,
    };
    doc.name = name;
    doc.kind = kind;
    doc.fingerprint = fingerprint;
    doc.lang = archive.lang;
    doc.currentArchiveId = archive.id;
    doc.archiveIds = (doc.archiveIds || []).concat(archive.id);
    doc.updatedAt = Date.now();
    await docSave(doc);
    await pruneArchives(doc);
    return { doc, archive, report: reportText(archive) };
  }

  function buildPageMap(paragraphs) {
    const map = [];
    let cur = null;
    paragraphs.forEach((p) => {
      const page = p.page || 1;
      if (!cur || cur.page !== page) { cur = { page, from: p.i, to: p.i }; map.push(cur); }
      else cur.to = p.i;
    });
    return map;
  }

  // ── 三种看法 + AI 清洗稿 ──────────────────────────
  // 原文（source）就是抽字稿；「原文」在 PDF 里没有文字层，所以这里两档：
  //   text  抽字/OCR 出来的（听书用这个）
  //   ai    AI 清洗后的（默认手动触发，一次一版，落盘，每段仍标来源）
  function paragraphsOf(archive, which) {
    if (!archive) return [];
    if (which === 'ai') return (archive.clean && archive.clean.paragraphs) ? archive.clean.paragraphs : [];
    return archive.paragraphs || [];
  }

  /** 原文视图：第 4 级留下的快照（没有就返回空，界面不许假装有原文）。 */
  function sourceText(archive) {
    return (archive && archive.snapshot && archive.snapshot.text) ? archive.snapshot.text : '';
  }

  async function applyClean(archive, cleanedParas, meta) {
    if (!archive) throw new Error('没有档案');
    const paragraphs = (cleanedParas || []).map((p, i) => ({
      i,
      text: typeof p === 'string' ? p : String(p.text || ''),
      src: SRC.AI,
      page: (typeof p === 'object' && p.page) || null,
    })).filter((p) => p.text);
    if (!paragraphs.length) throw new Error('清洗稿是空的');
    const rec = { ...archive, clean: { promptVersion: CLEAN_PROMPT_VERSION, at: Date.now(), paragraphs, meta: meta || null } };
    await dbPut(S_ARC, rec);
    return rec;
  }

  // 清洗只做一次、落盘：askFn(messages) → 文本。不做默认自动（成本要可控）。
  async function cleanArchive(archive, askFn) {
    const text = (archive.paragraphs || []).map((p) => p.text).join('\n');
    const chunks = [];
    const size = 6000;
    for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
    const out = [];
    for (const chunk of chunks) {
      const res = await askFn([
        { role: 'system', content: '你在把 OCR/抽字稿整理成可朗读的正文：去掉页眉页脚、断句错乱、图注噪声；保留原意和段落；只输出正文。' },
        { role: 'user', content: chunk },
      ]);
      String(res || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean).forEach((s) => out.push(s));
    }
    return applyClean(archive, out, { chunks: chunks.length });
  }

  function setView(archive, which) {
    // 听的时候不能切，停下来再切 —— 由调用方（播放器）保证，这里只记账
    if (!['text', 'ai'].includes(which)) throw new Error('未知视图：' + which);
    return { ...archive, view: which };
  }

  // ── 逐页 OCR 写进档案（A3 + §3 第 3 级）────────────────
  // 阅读器里一页一页转，每次把「这一页」的 OCR 行并进同一份档案：同页重转是替换、不是追加。
  // docId 用「材料键」的 hash（PDF 在阅读器里未必留着原始字节，不能靠文件 hash）。
  // 页级统计（字数/段数/是否失败页）现算，所以材料页能直接显示覆盖率。
  async function upsertPageText(opts) {
    const o = opts || {};
    const key = String(o.key || o.name || 'untitled');
    const name = String(o.name || key);
    const page = Math.max(1, Number(o.page) || 1);
    const lines = (o.lines || []).map((s) => String(s || '').trim()).filter(Boolean);
    if (!lines.length) throw new Error('这一页没识别出文字');
    const docId = 'doc-' + (await sha256Hex(new TextEncoder().encode(key))).slice(0, 16);
    const doc = await docGet(docId);
    const prev = doc ? await arcCurrent(docId) : null;
    const keep = ((prev && prev.paragraphs) || []).filter((p) => (p.page || 0) !== page);
    const paragraphs = keep
      .concat(lines.map((text) => ({ text, src: SRC.OCR, page, y: null, conf: null })))
      .map((p, i) => ({ ...p, i }));

    const pageMap = new Map();
    for (const p of paragraphs) {
      const k = p.page || 1;
      const cur = pageMap.get(k) || { i: k, chars: 0, paras: 0, ok: false, reason: '' };
      cur.chars += p.text.length;
      cur.paras += 1;
      cur.ok = cur.chars >= TH.minPageChars;
      cur.reason = cur.ok ? '' : '这一页只识别到 ' + cur.chars + ' 字';
      pageMap.set(k, cur);
    }
    const pages = Array.from(pageMap.values()).sort((a, b) => a.i - b.i);
    const startedAt = prev ? prev.startedAt : Date.now();
    const coverage = coverageOf({
      pages, paragraphs, ms: o.ms || 0, startedAt,
      docPages: Math.max(Number(o.total) || 0, pages.length),
    });
    // 分辨率护栏：短边不足 1600 的扫描件识别不可靠，必须标红，不许当可听
    if (o.lowRes) coverage.reasons.push("识别分辨率低（短边 < 1600），结果不可靠");
    const verdict = verdictOf(coverage);
    const archive = {
      id: docId + '@' + Date.now().toString(36),
      docId, name, kind: o.kind || 'pdf', level: 3, levelName: LEVEL[3],
      lang: o.lang || '',
      fingerprint: (prev && prev.fingerprint) || {
        fileHash: docId.slice(4), convVersion: CONV_VERSION, promptVersion: CLEAN_PROMPT_VERSION, pipeline: 'ocr/1',
      },
      paragraphs, pages, pageMap: buildPageMap(paragraphs), coverage,
      verdict, playable: verdict === 'ok', partial: false, nextPage: null,
      clean: null, view: 'text', startedAt, finishedAt: Date.now(),
    };
    await dbPut(S_ARC, archive);
    const rec = doc || { docId, name, kind: archive.kind, createdAt: startedAt, archiveIds: [], deletedAt: null };
    rec.name = name;
    rec.kind = archive.kind;
    rec.key = key;
    rec.fingerprint = archive.fingerprint;
    rec.lang = archive.lang;
    rec.currentArchiveId = archive.id;
    rec.archiveIds = (rec.archiveIds || []).concat(archive.id);
    rec.updatedAt = Date.now();
    await docSave(rec);
    await pruneArchives(rec);
    return { doc: rec, archive, report: reportText(archive) };
  }

  // ── 报告（材料页要显示的东西）──────────────────────
  function fmtTime(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function reportText(archive) {
    if (!archive) return '（没有档案）';
    const c = archive.coverage || {};
    const fc = archive.fingerprint || {};
    const lines = [];
    lines.push('材料：' + archive.name + '（' + archive.kind + '，' + (c.paras || 0) + ' 段 / ' + (c.chars || 0) + ' 字）');
    lines.push('转换：' + (archive.levelName || '') + '（第 ' + archive.level + ' 级），用时 ' + ((c.ms || 0) / 1000).toFixed(1) + ' 秒，' + fmtTime(archive.finishedAt));
    lines.push('覆盖：' + (c.pagesOk || 0) + '/' + (c.pages || 0) + ' 页，失败 ' + (c.pagesFail || 0) + ' 页'
      + (c.bodyRatio != null ? '，正文占比 ' + Math.round(c.bodyRatio * 100) + '%' : ''));
    if (c.docPages && c.docPages > (c.pages || 0)) {
      lines.push('整份 ' + c.docPages + ' 页，这次转 ' + (c.pages || 0) + ' 页（还有 ' + (c.docPages - (c.pages || 0)) + ' 页没转）');
    }
    if (c.failPages && c.failPages.length) {
      lines.push('失败页：' + c.failPages.map((p) => 'p' + p.i + (p.reason ? '（' + p.reason + '）' : '')).join('、'));
    }
    if (c.partial) lines.push('状态：转到第 ' + (c.nextPage ? c.nextPage - 1 : c.pages) + ' 页先停下，下次从第 ' + c.nextPage + ' 页续');
    if (archive.snapshot && archive.snapshot.text) lines.push('原文：留了快照（只能看，不能听）');
    lines.push('判定：' + (archive.playable ? '可以听'
      : '不能听 —— ' + ((c.reasons || []).join('；') || (c.partial ? '还没转完（分批）' : '仅收藏'))));
    lines.push('指纹：' + String(fc.fileHash || '').slice(0, 8) + ' · ' + (fc.convVersion || '') + ' · ' + (fc.promptVersion || ''));
    return lines.join('\n');
  }

  // ── 给 app.js 用的轻量入口：把已打开的书直接建成档案 ──
  // 不重新解析文件（正文已经在内存里），只做「段落化 + 落库 + 判定」。
  async function archiveBook(book, opts) {
    const o = opts || {};
    if (!book || !book.chapters || !book.chapters.length) return null;
    const name = o.name || book.name || '未命名材料';
    const key = o.key || book.id || name;
    const chapters = book.chapters.map((c) => {
      const blocks = String(c.text || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n{2,}/)
        .map((s) => s.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
        .map((text) => ({ text, src: o.kind === 'epub' || o.kind === 'html' ? SRC.DOM : SRC.TEXT }));
      return { blocks };
    });
    const r = chaptersFromBlocks(chapters);
    const startedAt = Date.now();
    const fingerprint = {
      fileHash: await sha256Hex(new TextEncoder().encode(String(key))),
      convVersion: CONV_VERSION,
      promptVersion: CLEAN_PROMPT_VERSION,
      pipeline: 'book/1',
    };
    const docId = 'doc-' + fingerprint.fileHash.slice(0, 16);
    const coverage = coverageOf({ pages: r.pages, paragraphs: r.paragraphs, allChars: null, ms: 0, startedAt });
    const archive = {
      id: docId + '@' + startedAt.toString(36),
      docId, name, kind: o.kind || 'book', level: 2, levelName: LEVEL[2], lang: r.langUsed,
      fingerprint, paragraphs: r.paragraphs, pages: r.pages, pageMap: buildPageMap(r.paragraphs),
      coverage, verdict: verdictOf(coverage), playable: verdictOf(coverage) === 'ok',
      partial: false, nextPage: null, clean: null, view: 'text', startedAt, finishedAt: Date.now(),
    };
    await dbPut(S_ARC, archive);
    const doc = (await docGet(docId)) || { docId, name, kind: archive.kind, createdAt: startedAt, archiveIds: [], deletedAt: null };
    doc.name = name;
    doc.kind = archive.kind;
    doc.key = key;                                   // 阅读位置的键：同步时按它对位置
    doc.fingerprint = fingerprint;
    doc.lang = archive.lang;
    doc.currentArchiveId = archive.id;
    doc.archiveIds = (doc.archiveIds || []).concat(archive.id);
    doc.updatedAt = Date.now();
    await docSave(doc);
    await pruneArchives(doc);
    return archive;
  }

  // 旧档清理：文档被删除时（同步墓碑）把档案也一并归档标记，不直接删内容
  async function markDocDeleted(docId) {
    const doc = await docGet(docId);
    if (!doc) return null;
    doc.deletedAt = Date.now();
    return docSave(doc);
  }

  // 补文档级元信息（B7：网页档案要记完整网址 + 关键词 + 来源等级）
  // 只改 doc 上那几个字段，不碰档案正文，所以不会把已有段落弄丢。
  async function setDocMeta(docId, patch) {
    const doc = await docGet(docId);
    if (!doc) return null;
    const allowed = ['url', 'sourceUrl', 'keywords', 'sourceLevel', 'sourceChars', 'sourceWhy'];
    for (const k of allowed) if (patch[k] !== undefined) doc[k] = patch[k];
    doc.updatedAt = Date.now();
    return docSave(doc);
  }

  async function docByUrl(url) {
    if (!url) return null;
    const all = await docAll();
    return all.find((d) => !d.deletedAt && (d.url === url || d.sourceUrl === url)) || null;
  }

  return {
    // 常量
    CONV_VERSION, CLEAN_PROMPT_VERSION, TH, SRC, LEVEL, DB_NAME, DB_VER,
    // 主流程
    convert, archiveBook, coverageOf, verdictOf, reportText, upsertPageText,
    // 档案读写
    arcGet, arcAll, arcListOf, arcCurrent, paragraphsOf, sourceText, applyClean, cleanArchive, setView,
    docGet, docAll, markDocDeleted, setDocMeta, docByUrl,
    // 拆出来给测试/调试用
    sha256Hex, kindOf, pdfRows, rowToParas, htmlExtract, pdfExtract, plainExtract,
    langFromMeta, guessLangByText,
    // 阈值口径（测试会断言这几个数没被偷偷改）
    thresholds: () => ({ ...TH }),
  };
})();
