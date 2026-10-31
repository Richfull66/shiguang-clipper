/* 时光库 Clipper · 设置页 */
const DEFAULTS = {
  owner: 'Richfull66',
  repo: 'shiguang',
  branch: '',
  basePath: 'clips',
  maxImages: 30,
  maxImageMB: 8
};

const $ = id => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function readForm() {
  const owner = $('owner').value.trim();
  const repo = $('repo').value.trim();
  const branch = $('branch').value.trim();
  let basePath = $('basePath').value.trim().replace(/\\/g, '/');
  basePath = basePath.replace(/^\/+|\/+$/g, '');
  basePath = basePath.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
  const maxImages = Math.max(1, Math.min(60, parseInt($('maxImages').value, 10) || 30));
  const maxImageMB = Math.max(1, Math.min(50, parseInt($('maxImageMB').value, 10) || 8));
  return {
    token: $('token').value.trim(),
    config: { owner, repo, branch, basePath: basePath || 'clips', maxImages, maxImageMB }
  };
}

function validate({ token, config }) {
  if (!config.owner) return '请填写仓库所有者';
  if (!config.repo) return '请填写仓库名';
  if (!/^[A-Za-z0-9_.-]+$/.test(config.owner)) return '仓库所有者只能包含字母、数字、下划线和短横线';
  if (!/^[A-Za-z0-9_.-]+$/.test(config.repo)) return '仓库名只能包含字母、数字、下划线和短横线';
  if (!token) return '请填写 GitHub Token';
  if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
    // 不强制拦截，只提示
    return '';
  }
  return '';
}

async function save() {
  const values = readForm();
  const error = validate(values);
  if (error) {
    setStatus(error, 'err');
    return;
  }
  try {
    await chrome.storage.sync.set({ config: values.config });
    await chrome.storage.local.set({ token: values.token });
    if (!values.token) {
      setStatus('已保存，但还没有填写 Token，暂时无法上传。', 'err');
    } else {
      setStatus('设置已保存。', 'ok');
    }
  } catch (error2) {
    setStatus('保存失败：' + error2.message, 'err');
  }
}

function testConnection() {
  const values = readForm();
  if (!values.token) {
    setStatus('请先填写 Token 再测试。', 'err');
    return;
  }
  if (!values.config.owner || !values.config.repo) {
    setStatus('请先填写仓库所有者和仓库名。', 'err');
    return;
  }
  setStatus('正在连接 GitHub…');
  chrome.runtime.sendMessage(
    { type: 'TEST_CONNECTION', config: values.config, token: values.token },
    response => {
      if (!response) {
        setStatus('没有收到后台响应，请重新加载扩展后再试。', 'err');
        return;
      }
      if (!response.ok) {
        let message = '连接失败：' + response.error;
        if (response.account) {
          message += `。这个 Token 属于账号 ${response.account}，目标仓库是 ${response.repo}`;
        }
        setStatus(message, 'err');
        return;
      }
      const parts = ['连接成功'];
      if (response.account) parts.push('Token 账号 ' + response.account);
      parts.push('默认分支 ' + response.defaultBranch);
      parts.push(response.isPrivate ? '私有仓库' : '公开仓库');
      if (response.canPush) parts.push('有写入权限');
      else parts.push('⚠ Token 没有写入权限');
      setStatus(parts.join(' · '), response.canPush ? 'ok' : 'err');
    }
  );
}

async function init() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get('config'),
    chrome.storage.local.get('token')
  ]);
  const config = Object.assign({}, DEFAULTS, sync.config || {});
  $('token').value = local.token || '';
  $('owner').value = config.owner || '';
  $('repo').value = config.repo || '';
  $('branch').value = config.branch || '';
  $('basePath').value = config.basePath || 'clips';
  $('maxImages').value = config.maxImages || 30;
  $('maxImageMB').value = config.maxImageMB || 8;

  $('saveBtn').addEventListener('click', save);
  $('testBtn').addEventListener('click', testConnection);
  $('toggleToken').addEventListener('click', () => {
    const input = $('token');
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    $('toggleToken').textContent = isPassword ? '隐藏' : '显示';
  });
}

document.addEventListener('DOMContentLoaded', init);
