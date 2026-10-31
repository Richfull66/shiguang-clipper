# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目是什么

Chrome Manifest V3 扩展「时光库 Clipper」：把当前网页的正文、选中文字或单张图片保存到 GitHub 仓库（默认 `Richfull66/shiguang`），整理为 Markdown + 本地图片。纯原生 JS，无构建步骤、无依赖、无自动化测试。界面文案全部为中文。

## 运行与调试

```bash
# 没有 build / lint / test 命令。改动后至少做语法检查：
node --check background.js
node --check content.js
node --check popup.js
node --check options.js

# 校验 manifest JSON：
python -c "import json; json.load(open('manifest.json', encoding='utf-8'))"
```

加载与重载：

1. `chrome://extensions/` → 开启开发者模式 → 「加载已解压的扩展程序」→ 选择本目录。
2. 改完代码点该扩展卡片上的「重新加载」。`content.js` 是声明式注入，已打开的标签页必须刷新才会用上新代码。
3. 调试入口：扩展卡片上的「服务工作进程」看后台日志；弹窗和设置页上右键 →「检查」。

没有测试套件。验证一次完整保存需要真实 Token 和网络，属于手动测试；不要在仓库里伪造 Token。

## 架构

三个运行上下文，职责严格分开：

| 上下文 | 文件 | 职责 |
| --- | --- | --- |
| Content script（隔离世界） | `content.js` | 只读 DOM，提取正文/选区 → Markdown，收集图片 URL |
| Service worker | `background.js` | 所有网络 I/O：GitHub API、图片下载、配置读取、提交 |
| UI | `popup.*`、`options.*` | 预览、触发保存、展示进度/结果、配置 Token |

### 消息与控制流

- 弹窗 → content script：`PREVIEW`、`EXTRACT`（参数 `mode: page|selection|image`、`maxImages`）。发送失败时用 `chrome.scripting.executeScript` 注入 `content.js` 后重试（`popup.js` 的 `messageTab`、`background.js` 的 `extractTab`）。
- 弹窗 → 后台：**长连接** `chrome.runtime.connect({name:'clip-save'})`，消息为 `start` / `progress` / `done`。用端口而不是一次性消息，是为了在保存期间保持 MV3 service worker 存活；弹窗关闭后保存可能中断。
- 右键菜单：直接在后台执行 `extractTab` + `saveClip`，没有端口保活。
- 一次性消息：`GET_STATUS`、`TEST_CONNECTION`、`SAVE_CLIP`。

### 配置存储（重要）

- `chrome.storage.sync` → key `config`：`owner`、`repo`、`branch`、`basePath`、`maxImages`、`maxImageMB`，默认值在 `background.js` 的 `DEFAULTS`。
- `chrome.storage.local` → `token` 和 `lastResult`。
- **Token 必须只放 local**：sync 会跨设备同步，不能把密钥放进去。
- 「测试连接」使用设置页当前输入框的值，不需要先保存；「保存设置」才写入 storage。

### 提取流程（content.js）

1. `pickRoot()` 在 `article/main/.post/.content` 等候选里按文本长度 + 段落数打分，低于 200 字回退 `body`。
2. 克隆节点，`removeNoise()` 删除导航、页脚、广告、评论、隐藏元素等。
3. `renderNode()` 递归转 Markdown：标题、段落、列表（含嵌套）、引用、代码块、表格、链接、加粗/斜体。
4. 图片经 `renderImage()` 变成 `![alt](__IMG_n__)` 占位符；按 URL 去重、过滤 `<100px` 的小图、跳过 `data:`/`blob:`，数量受 `maxImages` 限制（上限 60）。
5. `window.__shiguangClipperLoaded` 防止重复注入。

### 提交流程（background.js）

`saveClip()`：

1. 读取配置 → `GET /repos/{owner}/{repo}` 校验仓库和写权限。
2. `branch = config.branch || repo.default_branch || 'main'`。
3. 目录：`{basePath}/{YYYY-MM-DD}/{标题slug}-{HHmmss}`。
4. 逐张下载图片（顺序执行，间隔 120ms）：校验返回类型是 `image/*`、不超过 `maxImageMB`；失败不中断，Markdown 里回退为原始 URL，并在文末加说明。
5. `commitFiles()` 用 Git Data API 一次性提交：逐文件创建 blob → 创建 tree（已有分支时带 `base_tree`）→ 创建 commit → 创建或 PATCH ref。**一次保存只有一个 commit**。
6. 返回 GitHub 网页链接，写入 `lastResult`。

## 必须保持的约定

- **`__IMG_n__` 占位符协议**：`content.js` 生成、`background.js` 的 `applyImageResults()` 替换。改任何一边都要同步另一边；未替换的占位符会被清空。
- **不要用 `repo.size` 判断空仓库**。很小的仓库（只有一个 README）`size` 也会是 0，曾导致向已存在的 `main` 创建 ref 时报 422。首次提交的判定依据是 `GET /git/ref/heads/{branch}` 返回 404。`commitFiles()` 对 422 有一次重试，用于并发创建分支。
- **Markdown 行尾两个空格是硬换行**：`tidyMarkdown()` 特意不清除行尾空格，`cleanParagraph()` 用 `'  \n'` 连接段落内的 `<br>`。不要加回「删除行尾空格」的清理。
- **路径与分支要按段编码**：`encodePath()`、`encodeRef()` 对 `/` 分段 `encodeURIComponent`，不要把整个路径一次性编码。
- **扩展页面不能有内联脚本**（MV3 CSP）：`popup.html`、`options.html` 只引用外部 `.js`。
- **中文界面的排版统一**：正文微软雅黑、代码 Consolas、主色 `#2F5597`；`content.js` 输出的 Markdown 用中文标点保持原文。

## GitHub API 行为

- 所有请求走 `ghFetch()`：Bearer Token、`Accept: application/vnd.github+json`、API 版本头。
- 错误按状态码翻译：401 Token 无效/过期；403 权限不足或限流；404 仓库/分支/文件不存在或 Token 无权访问私有库；409 仓库为空或分支冲突；422 参数错误/文件已存在。
- `TEST_CONNECTION` 先 `GET /user` 取 Token 所属账号，再 `GET /repos/...`；设置页会把账号和目标仓库一起显示，用于排查 404（账号不对 / Fine-grained Token 没勾选仓库）。
- 仓库为空时，Git Data API 的 ref 不存在，`commitFiles()` 会 `POST /git/refs` 创建默认分支；仓库非空时用 `PATCH`，`force: false`。

## 仓库输出格式（对外契约）

```
{basePath}/{YYYY-MM-DD}/{slug}-{HHmmss}/
├── index.md          # YAML frontmatter + 正文
└── images/01-xxx.jpg
```

`index.md` 的 frontmatter 字段：`title`、`source`、`site`、`author`、`description`、`published`、`saved_at`、`mode`。字段值用 `JSON.stringify()` 生成 YAML 双引号字符串。图片用相对路径 `images/...` 引用。

## 权限说明

`host_permissions: <all_urls>` 同时用于两件事：向任意网页注入 content script、在 service worker 里跨域下载图片。`scripting` 用于注入回退和右键菜单的单张图片保存。新增权限时优先复用现有权限，避免扩大范围。

## 参考

安装步骤、Token 权限配置、常见 404/权限问题见 `README.md`，不要在本文件里重复。
