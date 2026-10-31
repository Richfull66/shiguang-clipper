/* 时光库 Clipper · 弹窗逻辑 */
const $ = id => document.getElementById(id);

let activeTab = null;
let pagePreview = null;
let busy = false;
let lastSavedUrl = '';

const STATUS = {
  ready: '已连接 GitHub，选择保存方式',
  noToken: '尚未配置 GitHub Token，请先打开「设置」',
  unsupported: '当前页面不支持保存（请打开普通网页）',
  error: '读取页面失败'
};

function setStatus(text, kind) {
  const el = $('statusBar');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function setButtons(enabled) {
  $('savePage').disabled = !enabled || busy;
  $('saveSelection').disabled = !enabled || busy || !pagePreview || pagePreview.selectionLength === 0;
}

function showProgress(message, percent) {
  $('progressWrap').hidden = false;
  $('progressText').textContent = message;
  $('barFill').style.width = Math.max(2, Math.min(100, percent)) + '%';
}

function hideResult() {
  $('resultWrap').hidden = true;
}

function showResult(result) {
  $('resultWrap').hidden = false;
  $('resultWrap').className = 'result success';
  $('resultTitle').textContent = '已保存到时光库';
  const images = result.imagesFailed
    ? `图片 ${result.imagesOk} 张，失败 ${result.imagesFailed} 张`
    : `图片 ${result.imagesOk} 张`;
  $('resultMeta').textContent = `${result.folder}/index.md · ${images} · ${result.chars} 字符`;
  const link = $('resultLink');
  link.href = result.url;
  link.style.display = '';
  $('copyBtn').style.display = '';
  lastSavedUrl = result.url;
}

function showError(message) {
  $('resultWrap').hidden = false;
  $('resultWrap').className = 'result fail';
  $('resultTitle').textContent = '保存失败';
  $('resultMeta').textContent = message;
  $('resultLink').style.display = 'none';
  $('copyBtn').style.display = 'none';
}

async function messageTab(tabId, payload) {
  try {
    return await chrome.tabs.sendMessage(tabId, payload);
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, payload);
  }
}

async function save(mode) {
  if (busy || !activeTab) return;
  busy = true;
  setButtons(true);
  hideResult();
  showProgress('正在提取页面内容…', 4);

  try {
    const stored = await chrome.storage.sync.get('config');
    const maxImages = (stored.config && stored.config.maxImages) || 30;
    const clip = await messageTab(activeTab.id, { type: 'EXTRACT', mode, maxImages });
    if (!clip || !clip.ok) throw new Error((clip && clip.error) || '页面内容提取失败');

    showProgress('正在连接 GitHub…', 8);
    const result = await sendToBackground(clip, mode);
    if (result && result.ok === false) return; // 错误已在 onMessage 中展示

    showProgress('完成', 100);
    setStatus(STATUS.ready, 'ok');
  } catch (error) {
    showError(error.message || String(error));
    setStatus(STATUS.error, 'err');
  } finally {
    busy = false;
    setButtons(true);
    setTimeout(() => { $('progressWrap').hidden = true; }, 900);
  }
}

function sendToBackground(clip, mode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const port = chrome.runtime.connect({ name: 'clip-save' });

    port.onMessage.addListener(message => {
      if (!message) return;
      if (message.type === 'progress') {
        let percent = 10;
        if (message.phase === 'connect') percent = 8;
        else if (message.phase === 'image' && message.total) {
          percent = 10 + (message.current / message.total) * 82;
        } else if (message.phase === 'markdown' || message.phase === 'commit') percent = 95;
        showProgress(message.message || '处理中…', percent);
        return;
      }
      if (message.type === 'done') {
        settled = true;
        try { port.disconnect(); } catch (error) { /* ignore */ }
        if (message.ok) {
          showResult(message);
          resolve(message);
        } else {
          showError(message.error || '保存失败');
          setStatus(STATUS.error, 'err');
          resolve({ ok: false });
        }
      }
    });

    port.onDisconnect.addListener(() => {
      if (settled) return;
      // 弹窗关闭或后台中断：任务可能已在后台完成，引导用户去仓库确认
      resolve({ ok: false });
    });

    port.postMessage({ type: 'start', clip, mode });
  });
}

async function loadPreview() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tabs && tabs[0];
  if (!activeTab || !/^https?:/i.test(activeTab.url || '')) {
    setStatus(STATUS.unsupported, 'err');
    $('previewCard').hidden = true;
    setButtons(false);
    return;
  }

  try {
    pagePreview = await messageTab(activeTab.id, { type: 'PREVIEW' });
  } catch (error) {
    pagePreview = null;
  }

  if (!pagePreview || !pagePreview.ok) {
    setStatus(STATUS.unsupported, 'err');
    $('previewCard').hidden = true;
    setButtons(false);
    return;
  }

  $('pageTitle').textContent = pagePreview.title || activeTab.title || '';
  $('selCount').textContent = pagePreview.selectionLength || 0;
  $('imgCount').textContent = pagePreview.imageCount || 0;
  $('previewCard').hidden = false;
  setButtons(true);
}

async function loadStatus() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, response => {
      resolve(response || {});
    });
  });
}

async function loadLastResult() {
  const stored = await chrome.storage.local.get('lastResult');
  const last = stored.lastResult;
  if (!last || Date.now() - last.time > 5 * 60 * 1000) return;
  if (last.ok) showResult(last);
  else showError(last.error || '上次保存失败');
}

async function init() {
  $('savePage').addEventListener('click', () => save('page'));
  $('saveSelection').addEventListener('click', () => save('selection'));
  $('settingsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('optionsLink').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('repoLink').addEventListener('click', event => {
    event.preventDefault();
    chrome.tabs.create({ url: $('repoLink').href });
  });
  $('copyBtn').addEventListener('click', async () => {
    if (!lastSavedUrl) return;
    try {
      await navigator.clipboard.writeText(lastSavedUrl);
      const button = $('copyBtn');
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = original; }, 1200);
    } catch (error) { /* ignore */ }
  });

  const status = await loadStatus();
  if (status.owner && status.repo) {
    $('repoLabel').textContent = `${status.owner}/${status.repo}`;
    $('repoLink').href = `https://github.com/${status.owner}/${status.repo}`;
  }

  await loadPreview();

  if (!status.configured) {
    setStatus(STATUS.noToken, 'err');
    setButtons(false);
  } else if (activeTab && /^https?:/i.test(activeTab.url || '')) {
    setStatus(STATUS.ready, 'ok');
  }

  await loadLastResult();
}

document.addEventListener('DOMContentLoaded', init);
