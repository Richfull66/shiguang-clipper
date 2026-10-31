# 时光库 Clipper

把网页的**正文和图片**一键保存到 GitHub 仓库 [`Richfull66/shiguang`](https://github.com/Richfull66/shiguang)，自动整理成 Markdown。

## 功能

- **整页保存**：自动识别正文区域，转成 Markdown，并下载页面中的图片
- **选中保存**：只保存当前选中的文字
- **图片保存**：右键任意图片，单独存到仓库
- **右键菜单**：整页 / 选中文字 / 单张图片三种入口
- 自动生成 YAML 头信息（标题、来源、站点、作者、保存时间）
- 图片按 `images/01-xxx.jpg` 命名，Markdown 使用相对路径引用
- 图片下载失败不中断，保留原始链接
- 每次保存只生成**一个 Git 提交**（图片和 Markdown 一起提交）
- Token 仅保存在本机，不上传任何第三方

## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions/`
2. 右上角开启 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本文件夹：`C:\Users\jessi\Desktop\课程用软件\shiguang-clipper`
5. 点扩展图标旁的图钉，固定到工具栏

> 修改代码后，在 `chrome://extensions/` 里点该扩展的「重新加载」即可生效。

## 配置 Token

插件需要你的 GitHub Token 才能写入仓库。**不要把 Token 发给任何人。**

推荐使用 Fine-grained Token（权限更小）：

1. 打开 <https://github.com/settings/personal-access-tokens/new>
2. Token name 随便填，例如 `shiguang-clipper`
3. Expiration 按需选择
4. **Repository access** 选 `Only select repositories` → 勾选 `shiguang`
5. **Permissions** → `Repository permissions` → 找到 **Contents** → 设为 `Read and write`
6. 点 `Generate token`，复制生成的 `github_pat_...`

然后：

1. 点扩展图标 → 右上角齿轮（或「设置」）
2. 粘贴 Token
3. 确认：所有者 `Richfull66`，仓库 `shiguang`，分支留空（自动用默认分支），目录前缀 `clips`
4. 点 **测试连接**，看到「连接成功 · 有写入权限」即可
5. 点 **保存设置**

> 如果仓库是私有的，Token 必须勾选该仓库，否则会返回 404。
> 经典 Token（classic）需要勾选 `repo` 权限。

## 使用

**方式一：工具栏弹窗**

1. 打开要收藏的网页
2. 点扩展图标
3. 点「保存整个页面」或「保存选中内容」
4. 完成后点「在 GitHub 查看」

**方式二：右键菜单**

- 页面空白处右键 → **保存整页到时光库**
- 选中文字后右键 → **保存选中文字到时光库**
- 图片上右键 → **保存这张图片到时光库**

保存成功时，扩展图标会短暂显示绿色 ✓；失败显示红色 `!`。

## 仓库里的结构

```
clips/
└── 2026-10-31/
    └── 文章标题-183012/
        ├── index.md
        └── images/
            ├── 01-photo.jpg
            └── 02-chart.png
```

`index.md` 示例：

```markdown
---
title: "文章标题"
source: "https://example.com/article"
site: "示例站点"
author: "作者名"
saved_at: "2026-10-31T18:30:12+08:00"
mode: "page"
---

# 文章标题

> 来源：[示例站点](https://example.com/article) · 保存于 2026-10-31 18:30

正文内容……

![配图](images/01-photo.jpg)
```

## 常见问题

**保存失败，提示 404**
- 仓库名或所有者拼错
- 仓库是私有的，但 Token 没有勾选这个仓库
- Token 过期或被撤销

**提示没有写入权限**
重新生成 Token，确保 `Contents` 权限为 **Read and write**。

**部分图片没下载下来**
- 网站有防盗链，拒绝扩展的下载请求；Markdown 中会保留原始链接
- 图片超过单张大小上限（默认 8MB，可在设置里调大）
- 图片是 `data:` 内嵌格式或需要登录才能访问

**图片太多，保存很慢**
在设置里把「单次最多图片数」调小（默认 30 张）。图片是逐张下载的，避免触发 GitHub 限流。图片很多时建议用工具栏弹窗保存——弹窗打开期间后台不会休眠。

**仓库是空的**
插件会自动完成第一个提交，不需要手动初始化 README。

**当前页面不支持保存**
`chrome://`、`edge://`、扩展商店等受限页面无法注入脚本，请换普通网页。本地 `file://` 页面需要在扩展详情里额外开启「允许访问文件网址」。

**为什么目录名后面有一串数字**
那是保存时间（时分秒），用来避免同名页面互相覆盖。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 扩展清单（Manifest V3） |
| `background.js` | 调用 GitHub API、下载上传图片、生成 Markdown |
| `content.js` | 提取页面正文 / 选中内容，转 Markdown |
| `popup.html/css/js` | 工具栏弹窗 |
| `options.html/css/js` | 设置页 |
| `icons/` | 图标 |

## 安全

- Token 存放在 `chrome.storage.local`，不参与 Chrome 账号同步
- 扩展只与 `api.github.com` 通信（图片则从原始网站下载）
- 保存的是网页内容，若仓库公开，请避免收藏含隐私信息的页面
- 若 Token 泄露，立即到 GitHub 撤销并重新生成
