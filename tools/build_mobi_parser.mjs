// 构建 vendor/mobi-parser.mjs 的记录脚本（2026-11-27）。
// 任务书原文要求放在 zenus-lite/tools/，但本轮禁止改主检出，故随 PWA 工作树落盘。
//
// 已核事实：
//   包      @lingo-reader/mobi-parser@0.4.7（MIT，实现源自 foliate-js）
//   入口    node_modules/@lingo-reader/mobi-parser/dist/index.browser.mjs
//   依赖    fflate + @lingo-reader/shared（由 esbuild 一并打进单文件）
//   实测    临时目录 npm i esbuild @lingo-reader/mobi-parser@0.4.7 后：
//           npx esbuild <入口> --bundle --format=esm --platform=browser --minify \
//             --legal-comments=none \
//             --banner:js='/* @lingo-reader/mobi-parser@0.4.7 | MIT | bundled 2026-11-27 | esbuild browser ESM */' \
//             --outfile=../zl-cards-wb/vendor/mobi-parser.mjs
//   产物    66,704 B（65.1 KB），真样本 book.azw3 解析 101 章 / 10 条 TOC / 16 ms
//
// 重跑方式（不依赖项目 package.json，依赖装在临时目录）：
//   MOBI_BUILD_DIR='C:/VS CC/.scratch/mobi-build' node tools/build_mobi_parser.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../vendor/mobi-parser.mjs');
const BUILD_DIR = process.env.MOBI_BUILD_DIR || 'C:/VS CC/.scratch/mobi-build';
const ENTRY = join(BUILD_DIR, 'node_modules/@lingo-reader/mobi-parser/dist/index.browser.mjs');
const BANNER = '/* @lingo-reader/mobi-parser@0.4.7 | MIT | bundled 2026-11-27 | esbuild browser ESM */';

const { build } = await import(pathToFileURL(join(BUILD_DIR, 'node_modules/esbuild/lib/main.js')).href);
await mkdir(dirname(OUT), { recursive: true });
const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  minify: true,
  legalComments: 'none',
  banner: { js: BANNER },
  write: false,
});
await writeFile(OUT, result.outputFiles[0].contents);
console.log(`built ${OUT} (${result.outputFiles[0].contents.length} bytes)`);
