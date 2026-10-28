# 学习机 Lite

> 线上：https://aw6202.github.io/zenus-lite/
> 决策记录见 [DECISIONS.md](DECISIONS.md) · 同步选型见 [SYNC.md](SYNC.md)

一个静态 PWA：**电脑上生成内容 → 手机打开就是最新版**。没有后端、没有数据库服务、没有构建步骤。

- 手机端：刷卡片 / 做测验（选择+填空，本地生成，不联网）/ 问 AI（直连 DeepSeek），进度存本机
- 电脑端：改 `pack.json`（内容）或改代码，`git push` 即发布
- 不依赖任何一台电脑开机——页面和数据都在 GitHub Pages 上

## 为什么是这个形状

原来的 Zenus（FastAPI + Next + 85 个接口）是「一个本地服务端应用」。要让它上手机，只有两条路：
把服务端搬上去（组件编译、后台被杀），或者把服务端留在家（家里关机就废）。
这个版本把「学习机」拆成两样东西：**内容（数据）** 和 **一个壳（约 500 行网页）**。
AI 能力不靠自建后端，直接调 OpenAI 兼容接口。于是「软件更新」= 网页更新，手机不用重装。

## 目录

```
index.html            界面（含样式）
app.js                逻辑：调度 / 渲染 / AI 流式对话
pack.json             内容包 ← 要改内容就改这个
manifest.webmanifest  PWA 清单（可加到主屏幕）
sw.js                 Service Worker：外壳缓存、内容包网络优先
icons/                图标
```

## 五个页签

| 页签 | 做什么 |
|---|---|
| 复习 | 间隔重复刷卡片；**点任意英文词都能读**；翻面看释义 + 例句 + 译文 |
| 浏览 | 列出本科所有卡片和到期状态 |
| **测验** | 混合 10 题（选择题 + 例句填空），**本机生成、不联网、无需 key**；也可让 AI 另编新题 |
| 问 AI | 直接问，或卡片上「问 AI 讲讲这道」 |
| 设置 | API Key / 语速 / 每天新卡上限 / 导入导出进度 |

## 内容包格式

```jsonc
{
  "version": "2026-10-28.1",
  "courses": [{
    "id": "en-things",
    "title": "英语 · 日常实物词",
    "kind": "vocab",            // vocab: 翻面背；quiz: 选择题
    "cards": [{
      "id": "en-001",           // 全局唯一，改了 id 等于新卡
      "front": "salmon",        // 正面：单词 / 题干
      "hint": "/ˈsæmən/",       // 可选，翻面前显示
      "back": "三文鱼",          // 背面。quiz 时必须和某个 option 完全一致
      "options": ["…"],         // 仅 quiz
      "explain": "…"            // 可选，翻面后显示
    }]
  }]
}
```

**加内容 = 往 `courses[].cards` 里追加对象，push。** 手机刷新即见；已学过的卡进度不受影响（按 `id` 记）。

## 发版

```bash
git add -A && git commit -m "content: xxx" && git push
```

GitHub Pages 会自动重新发布（约 1 分钟）。手机上刷新一次，`pack.json` 走「网络优先」，拿到的就是新内容。

## 手机上装

1. 手机浏览器打开 Pages 地址
2. 菜单 →「添加到主屏幕」
3. 首次进入「设置」→ 填 API Key（DeepSeek：`https://api.deepseek.com/v1`，模型 `deepseek-chat`）

Key 只存在这台手机的 localStorage，不会进仓库。

## 要 APK

用 [PWABuilder](https://www.pwabuilder.com/) 把这个 URL 打成签名 APK（TWA）。
壳里加载的仍是同一个网址，所以**内容更新照样不用重装**。

## 进度同步

设置页「导出进度」→ 得到一个 JSON。放进任意 git 仓库或网盘即可。
换手机时「导入进度」，合并规则是**取复习次数更多/到期更晚的那份**，不会把旧进度盖掉新的。

## 已知简化（下一步）

- 调度用的是手写 SM-2 变体，**下一切换 `ts-fsrs`**（FSRS-6，Anki 同源）
- 复习流水已按「每次评分一条」存 `zenus.log.v1`，换算法/换 App 都不丢历史

## 已知边界

- 断网只能看已缓存的内容，**出题/讲解/对话需要联网**（LLM 在云上，这条绕不过去）
- 没有 RAG 检索、没有资料摄入、没有知识图谱——那些确实需要后端，留在 Zenus 里
