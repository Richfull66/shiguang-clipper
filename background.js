/* 时光库 Clipper · 后台服务
 * 负责：读取配置、调用 GitHub Contents API、下载并上传图片、生成 Markdown。
 */

const DEFAULTS = {
  owner: 'Richfull66',
  repo: 'shiguang',
  branch: '',
  basePath: 'clips',
  maxImages: 30,
  maxImageMB: 8
};

const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'image/tiff': '.tif'
};

// ---------- 配置 ----------
async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get('config'),
    chrome.storage.local.get('token')
  ]);
  const config = Object.assign({}, DEFAULTS, sync.config || {});
  config.token = local.token || '';
  return config;
}

// ---------- 通用工具 ----------
const pad2 = n => String(n).padStart(2, '0');

function isoLocal(date) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function humanTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function sanitizeName(input, maxLength = 60) {
  return String(input || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, maxLength)
    .trim();
}

function yamlStr(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function utf8ToBase64(text) {
  return arrayBufferToBase64(new TextEncoder().encode(text).buffer);
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

// ---------- GitHub API ----------
function formatGhError(status, data) {
  const detail = data && data.message ? data.message : '';
  let hint = '';
  if (status === 401) hint = 'Token 无效或已过期';
  else if (status === 403) hint = '权限不足或触发限流';
  else if (status === 404) hint = '仓库、分支或文件不存在，或 Token 无权访问该私有库';
  else if (status === 409) hint = '仓库为空或分支冲突';
  else if (status === 422) hint = '请求无法处理（文件可能已存在），请重试';
  else hint = 'GitHub 返回错误';
  return detail ? `${hint}（${status}：${detail}）` : `${hint}（HTTP ${status}）`;
}

async function ghFetch(config, path, options = {}) {
  if (!config.token) throw new Error('尚未配置 GitHub Token，请打开扩展设置填写。');
  const headers = {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + config.token,
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (options.body) headers['Content-Type'] = 'application/json';
  const response = await fetch('https://api.github.com' + path, Object.assign({}, options, { headers }));
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { message: text.slice(0, 300) }; }
  }
  if (!response.ok) {
    const error = new Error(formatGhError(response.status, data));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function getRepo(config) {
  return ghFetch(config, `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`);
}

function encodeRef(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

function repoApi(config, suffix) {
  return `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}${suffix}`;
}

/**
 * 用 Git Data API 一次性提交所有文件，避免每张图片产生一个 commit。
 * files: [{ path, base64 }]
 */
async function commitFiles(config, branch, files, message) {
  const blobs = [];
  for (const file of files) {
    const blob = await ghFetch(config, repoApi(config, '/git/blobs'), {
      method: 'POST',
      body: JSON.stringify({ content: file.base64, encoding: 'base64' })
    });
    blobs.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 以分支是否真实存在判断“首次提交”，不要依赖 repo.size（小仓库会报 0）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let parent = '';
    try {
      const ref = await ghFetch(config, repoApi(config, `/git/ref/heads/${encodeRef(branch)}`));
      parent = ref.object.sha || '';
    } catch (error) {
      if (error.status !== 404) throw error;
    }

    let baseTree = '';
    if (parent) {
      const parentCommit = await ghFetch(config, repoApi(config, `/git/commits/${parent}`));
      baseTree = parentCommit.tree.sha;
    }

    const treeBody = { tree: blobs };
    if (baseTree) treeBody.base_tree = baseTree;
    const tree = await ghFetch(config, repoApi(config, '/git/trees'), {
      method: 'POST',
      body: JSON.stringify(treeBody)
    });

    const commitBody = { message, tree: tree.sha };
    if (parent) commitBody.parents = [parent];
    const newCommit = await ghFetch(config, repoApi(config, '/git/commits'), {
      method: 'POST',
      body: JSON.stringify(commitBody)
    });

    try {
      if (parent) {
        await ghFetch(config, repoApi(config, `/git/refs/heads/${encodeRef(branch)}`), {
          method: 'PATCH',
          body: JSON.stringify({ sha: newCommit.sha, force: false })
        });
      } else {
        await ghFetch(config, repoApi(config, '/git/refs'), {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: newCommit.sha })
        });
      }
      return newCommit.sha;
    } catch (error) {
      // 并发情况下分支刚被创建：重试一次，改为在已有分支上追加
      if (attempt === 0 && error.status === 422) {
        await sleep(200);
        continue;
      }
      throw error;
    }
  }
  throw new Error('提交失败，请重试');
}

// ---------- 命名 ----------
function buildSlug(title) {
  const slug = sanitizeName(title, 40).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'clip';
}

function buildFolder(config, clip) {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  const base = String(config.basePath || 'clips').replace(/^\/+|\/+$/g, '');
  const parts = [base, date, `${buildSlug(clip.title || 'clip')}-${time}`].filter(Boolean);
  return parts.join('/');
}

function extensionFor(contentType, urlPath) {
  if (MIME_EXT[contentType]) return MIME_EXT[contentType];
  const match = String(urlPath || '').match(/\.(jpe?g|png|gif|webp|svg|avif|bmp|tiff?)$/i);
  if (match) return '.' + match[1].toLowerCase().replace('jpeg', 'jpg').replace('tiff', 'tif');
  return '.jpg';
}

function imageFileName(image, index, contentType) {
  let urlPath = '';
  try { urlPath = new URL(image.url).pathname.split('/').pop() || ''; } catch (e) { /* ignore */ }
  let base = '';
  try { base = decodeURIComponent(urlPath); } catch (e) { base = urlPath; }
  base = sanitizeName(base.replace(/\.[a-z0-9]{2,5}$/i, ''), 40).replace(/\s+/g, '-') || 'image';
  const ext = extensionFor(contentType, urlPath);
  return `${String(index).padStart(2, '0')}-${base}${ext}`;
}

// ---------- 图片上传 ----------
async function downloadImage(config, image, index) {
  const maxBytes = Math.max(1, Number(config.maxImageMB) || 8) * 1024 * 1024;
  try {
    const response = await fetch(image.url, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`);
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/')) throw new Error(`返回类型不是图片（${contentType || '未知'}）`);
    const blob = await response.blob();
    if (blob.size > maxBytes) {
      throw new Error(`图片 ${(blob.size / 1024 / 1024).toFixed(1)}MB，超过 ${config.maxImageMB}MB 上限`);
    }
    const buffer = await blob.arrayBuffer();
    const name = imageFileName(image, index, contentType);
    return {
      index: image.index,
      ok: true,
      path: `images/${name}`,
      base64: arrayBufferToBase64(buffer),
      size: blob.size
    };
  } catch (error) {
    return { index: image.index, ok: false, url: image.url, error: error.message };
  }
}

function applyImageResults(markdown, results) {
  let output = String(markdown || '');
  for (const result of results) {
    const token = `__IMG_${result.index}__`;
    const replacement = result.ok
      ? result.path
      : (/[()\s]/.test(result.url) ? `<${result.url}>` : result.url);
    output = output.split(token).join(replacement);
  }
  return output.replace(/__IMG_\d+__/g, '');
}

// ---------- Markdown ----------
function buildMarkdown(clip, mode, imageResults) {
  const title = (clip.title || '未命名页面').trim() || '未命名页面';
  const url = clip.url || '';
  const site = clip.site || '';
  const now = new Date();
  let body = applyImageResults(clip.markdown || '', imageResults).trim();
  if (!body) body = '（页面正文为空）';
  if (mode === 'selection') body = '## 选中内容\n\n' + body;
  if (mode === 'image') body = '## 图片\n\n' + body;

  const front = ['---', `title: ${yamlStr(title)}`, `source: ${yamlStr(url)}`];
  if (site) front.push(`site: ${yamlStr(site)}`);
  if (clip.author) front.push(`author: ${yamlStr(clip.author)}`);
  if (clip.description) front.push(`description: ${yamlStr(clip.description)}`);
  if (clip.published) front.push(`published: ${yamlStr(clip.published)}`);
  front.push(`saved_at: ${yamlStr(isoLocal(now))}`);
  front.push(`mode: ${yamlStr(mode)}`);
  front.push('---');

  const sourceLine = site && url
    ? `> 来源：[${site}](${url}) · 保存于 ${humanTime(now)}`
    : `> 保存于 ${humanTime(now)}`;

  let output = `${front.join('\n')}\n\n# ${title}\n\n${sourceLine}\n\n${body}\n`;

  const failed = imageResults.filter(item => !item.ok);
  if (failed.length) {
    output += `\n> 注：${failed.length} 张图片未能下载，已在正文中保留原始链接。\n`;
  }
  return output;
}

// ---------- 主流程 ----------
async function saveClip(clip, mode, notify = () => {}) {
  const config = await getSettings();
  if (!config.token) throw new Error('尚未配置 GitHub Token，请打开扩展设置填写。');
  if (!clip || !clip.meta) throw new Error('没有抓到页面内容，请刷新页面后重试。');
  if (!['page', 'selection', 'image'].includes(mode)) mode = 'page';

  notify({ phase: 'connect', message: '正在连接 GitHub…' });
  const repo = await getRepo(config);
  if (repo.permissions && repo.permissions.push === false) {
    throw new Error('该 Token 没有此仓库的写入权限，请检查 Token 的 Contents 权限。');
  }
  const branch = String(config.branch || '').trim() || repo.default_branch || 'main';

  const folder = buildFolder(config, clip);
  const images = Array.isArray(clip.images) ? clip.images : [];
  const limit = Math.max(1, Math.min(Number(config.maxImages) || 30, 60));
  const selectedImages = images.slice(0, limit);
  const imageResults = [];
  const files = [];

  for (let i = 0; i < selectedImages.length; i += 1) {
    const image = selectedImages[i];
    notify({
      phase: 'image',
      current: i + 1,
      total: selectedImages.length,
      message: `下载图片 ${i + 1}/${selectedImages.length}`
    });
    const result = await downloadImage(config, image, i + 1);
    imageResults.push(result);
    if (result.ok) files.push({ path: `${folder}/${result.path}`, base64: result.base64 });
    if (i < selectedImages.length - 1) await sleep(120);
  }

  notify({ phase: 'commit', message: '正在提交到 GitHub…' });
  const markdown = buildMarkdown(clip, mode, imageResults);
  const mdPath = `${folder}/index.md`;
  files.push({ path: mdPath, base64: utf8ToBase64(markdown) });
  await commitFiles(config, branch, files, `保存网页：${clip.title || ''}`);

  const okImages = imageResults.filter(item => item.ok).length;
  return {
    folder,
    branch,
    filePath: mdPath,
    url: `https://github.com/${config.owner}/${config.repo}/blob/${encodePath(branch)}/${encodePath(mdPath)}`,
    imagesOk: okImages,
    imagesFailed: imageResults.length - okImages,
    chars: markdown.length
  };
}

// ---------- 角标 ----------
function setBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color: color || '#2F5597' });
  chrome.action.setBadgeText({ text: text || '' });
}

function flashBadge(text, color, ms) {
  setBadge(text, color);
  setTimeout(() => setBadge(''), ms);
}

async function runMenuSave(clipPromise, mode) {
  try {
    setBadge('…', '#B7791F');
    const clip = await clipPromise;
    const result = await saveClip(clip, mode);
    flashBadge('✓', '#2F855A', 8000);
    await chrome.storage.local.set({ lastResult: Object.assign({ ok: true, time: Date.now() }, result) });
  } catch (error) {
    flashBadge('!', '#C53030', 15000);
    await chrome.storage.local.set({ lastResult: { ok: false, error: error.message, time: Date.now() } });
  }
}

// ---------- 从标签页提取 ----------
async function extractTab(tabId, mode) {
  const config = await getSettings();
  const request = { type: 'EXTRACT', mode, maxImages: config.maxImages };
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, request);
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    response = await chrome.tabs.sendMessage(tabId, request);
  }
  if (!response || !response.ok) {
    throw new Error((response && response.error) || '无法读取当前页面（chrome:// 等受限页面不支持）');
  }
  return response;
}

// ---------- 事件 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sg-save-page', title: '保存整页到时光库', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'sg-save-selection', title: '保存选中文字到时光库', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'sg-save-image', title: '保存这张图片到时光库', contexts: ['image'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;

  if (info.menuItemId === 'sg-save-page') {
    runMenuSave(extractTab(tab.id, 'page'), 'page');
    return;
  }

  if (info.menuItemId === 'sg-save-selection') {
    runMenuSave(extractTab(tab.id, 'selection'), 'selection');
    return;
  }

  if (info.menuItemId === 'sg-save-image') {
    const src = info.srcUrl || '';
    const imageClip = (async () => {
      if (!/^https?:/i.test(src)) throw new Error('该图片不是普通网络图片，无法保存。');
      const injected = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          title: document.title,
          url: location.href,
          site: location.hostname,
          author: '',
          description: '',
          published: ''
        })
      });
      const meta = injected[0].result;
      return {
        meta,
        title: meta.title,
        url: meta.url,
        site: meta.site,
        author: '',
        description: '',
        published: '',
        markdown: '![图片](__IMG_1__)',
        images: [{ index: 1, url: src, alt: info.selectionText || '' }]
      };
    })();
    runMenuSave(imageClip, 'image');
  }
});

// 弹窗通过长连接发送任务，连接保持期间 Service Worker 不会被回收
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'clip-save') return;
  port.onMessage.addListener(async message => {
    if (!message || message.type !== 'start') return;
    const notify = payload => {
      try { port.postMessage(Object.assign({ type: 'progress' }, payload)); } catch (e) { /* 弹窗已关闭 */ }
    };
    try {
      const result = await saveClip(message.clip, message.mode, notify);
      await chrome.storage.local.set({ lastResult: Object.assign({ ok: true, time: Date.now() }, result) });
      try { port.postMessage(Object.assign({ type: 'done', ok: true }, result)); } catch (e) { /* ignore */ }
    } catch (error) {
      await chrome.storage.local.set({ lastResult: { ok: false, error: error.message, time: Date.now() } });
      try { port.postMessage({ type: 'done', ok: false, error: error.message }); } catch (e) { /* ignore */ }
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === 'SAVE_CLIP') {
    saveClip(message.clip, message.mode, () => {})
      .then(result => sendResponse(Object.assign({ ok: true }, result)))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === 'TEST_CONNECTION') {
    (async () => {
      const config = Object.assign({}, DEFAULTS, message.config || {});
      config.token = message.token || '';
      const target = `${config.owner}/${config.repo}`;

      // 先确认 Token 本身有效，并取出它所属的账号
      let account = '';
      try {
        const user = await ghFetch(config, '/user');
        account = user.login || '';
      } catch (error) {
        sendResponse({ ok: false, error: 'Token 校验失败：' + error.message, account: '', repo: target });
        return;
      }

      try {
        const repo = await getRepo(config);
        sendResponse({
          ok: true,
          account,
          repo: target,
          defaultBranch: repo.default_branch,
          isPrivate: !!repo.private,
          canPush: !repo.permissions || repo.permissions.push !== false
        });
      } catch (error) {
        sendResponse({ ok: false, error: error.message, account, repo: target });
      }
    })();
    return true;
  }

  if (message.type === 'GET_STATUS') {
    getSettings().then(config => {
      sendResponse({
        ok: true,
        configured: !!config.token,
        owner: config.owner,
        repo: config.repo,
        branch: config.branch,
        basePath: config.basePath
      });
    });
    return true;
  }

  return false;
});
