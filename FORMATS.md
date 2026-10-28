# 多格式支持：跟 Koodo 学什么、不学什么

## Koodo Reader 的做法（可学的部分）

Koodo 支持 EPUB / PDF / MOBI / AZW3 / TXT / MD / FB2 / CBZ / CBR / DJVU / RTF / HTML 等十几种，
它的关键架构只有一条：**每种格式先转成同一个内部模型（章节 + HTML），阅读器只认这一种。**
所以加一种格式 = 加一个转换器，不改阅读器。

我们要的不是同一样东西：

| | Koodo | 我们 |
|---|---|---|
| 目标 | 把书**渲染**得好看 | 把书**抽成词**、能读 |
| 难点 | 排版（分栏、图文混排、翻页） | 抽干净的文本 |
| 结论 | 需要 epub.js 这类渲染引擎 | 只需要解析器 + 纯文本视图 |

**所以：学它的分层（转换器 → 统一模型），不学它的渲染。**

## 现状（2026-10-28）

| 格式 | 状态 | 用什么 |
|---|---|---|
| PDF（有文字层） | ✅ 已支持 | `vendor/pdf.min.js`（pdf.js），Canvas + 文字层，选中即取词 |
| EPUB | ✅ 已支持 | `vendor/jszip.min.js` 解压 → 解析 `container.xml` → `package.opf` 的 manifest/spine → 每章抽纯文本 |
| TXT / MD | ✅ 已支持 | 按空行切段，6000 字一章 |
| PDF（扫描件） | ❌ 待做 | Tesseract.js（WASM，离线）或 OCR 接口 |
| DOCX | ⬜ 好做 | JSZip + `word/document.xml`，约半天 |
| MOBI / AZW3 | ⬜ 麻烦 | Kindle 私有格式（PalmDB + 压缩）。JS 解析器稀少且不稳，建议先让用户用 Calibre/在线转 EPUB |
| CBZ / CBR | ⬜ 可做 | 就是 zip/rar 包图片，做个逐图翻页即可；对学习取词价值低 |
| DJVU | ❌ 不做 | djvu.js 体积大、场景少 |
| FB2 / RTF / HTML | ⬜ 以后 | 都是 XML/文本，抽正文很简单 |

## EPUB 解析要点（踩过/容易踩的）

1. **不要猜路径**：入口永远是 `META-INF/container.xml` 里的 `full-path`
2. **章节顺序看 spine**，不是文件名顺序（`toc.ncx`/`nav.xhtml` 只是目录）
3. **href 要 decodeURIComponent**，中文文件名/空格路径会挂
4. **`baseDir` 要拼**：opf 常在 `EPUB/` 子目录里，href 是相对它的
5. 抽正文时先删 `<head>/<script>/<style>`，再把块级标签换行，否则整章会挤成一行

## 下一步优先级

1. **DOCX**（最省事、职场资料多是它）
2. **扫描版 PDF OCR**（手头扫描件多）
3. **MOBI/AZW3**：先给"请转 EPUB"的提示，别硬做
4. CBZ/漫画：学习场景用不上，最后再说

## 不打算做的

- 精排版 EPUB 渲染（分栏、插图、翻页动画）——用 epub.js 要再加 ~200KB，且对取词没有帮助
- 自己的 OCR 模型——直接用 Tesseract.js 或现成接口
