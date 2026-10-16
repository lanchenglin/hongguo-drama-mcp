// SPDX-License-Identifier: GPL-3.0-only
import React, { useEffect, useState } from 'react';

export default function RemoteControlSettings({ active = true }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const load = async () => {
    try { setDraft(await window.electronAPI.getRemoteSettings()); setError(''); }
    catch (e) { setError(e.message || '远程设置加载失败'); }
  };
  useEffect(() => { if (active) void load(); }, [active]);
  const change = (key, value) => { setDraft(old => ({ ...old, [key]: value })); setNotice(''); setError(''); };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.electronAPI.saveRemoteSettings(draft);
      if (!result.success) throw new Error(result.error || '保存失败');
      setDraft(result.settings); setNotice('配置已保存；内网免令牌访问，Hermes 只需填写 MCP 地址。');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const testRoot = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await window.electronAPI.testDownloadRoot();
      if (!result.success) throw new Error(result.error);
      setNotice(`已保存的目录可写：${result.root}${result.freeBytes === null ? '' : `；剩余 ${(result.freeBytes / 1024 ** 3).toFixed(1)} GiB`}`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  if (!draft) return <section className="settings-card"><h3>局域网 / Hermes MCP</h3><p role="alert">{error || '加载中…'}</p><button className="btn btn-outline" onClick={load}>重新加载</button></section>;
  return <fieldset className="settings-card" disabled={busy}>
    <h3>局域网 / Hermes MCP</h3>
    <p className="settings-hint">这是机器调用接口，不是浏览器网页版。软件必须保持运行；最小化即可，关闭应用会停止接口。</p>
    <label className="proxy-switch-row"><input type="checkbox" checked={draft.enabled} onChange={e => change('enabled', e.target.checked)} />启用远程控制（内网免令牌）</label>
    <label className="proxy-switch-row"><input type="checkbox" checked={draft.host === '0.0.0.0'} onChange={e => change('host', e.target.checked ? '0.0.0.0' : '127.0.0.1')} />允许其他局域网设备连接</label>
    <div className="settings-group"><label className="settings-label" htmlFor="lan-bind">监听 IPv4 地址</label><input id="lan-bind" className="input-field" value={draft.host} onChange={e => change('host', e.target.value)} /></div>
    <div className="settings-group"><label className="settings-label" htmlFor="lan-port">监听端口</label><input id="lan-port" className="input-field" type="number" min="1024" max="65535" value={draft.port} onChange={e => change('port', Number(e.target.value))} /></div>
    {draft.platform === 'linux' && <label className="proxy-switch-row"><input type="checkbox" checked={draft.requireNetworkMount} onChange={e => change('requireNetworkMount', e.target.checked)} />要求目录已挂载 CIFS/SMB/NFS（避免共享卸载后误写到本机）</label>}
    <p className="settings-hint">先在本页“下载目录”中保存 UNC 或已挂载共享路径，再测试。当前已保存目录：<code>{draft.root}</code>。SMB 账号和密码由操作系统管理，不通过 MCP 传递。</p>
    <p className="settings-hint">运行状态：{draft.running ? '正在监听' : '未监听'}；{draft.error || ''} 连接地址示例：<code>http://下载电脑的局域网IP:{draft.port}/mcp</code></p>
    <p className="settings-hint">内网免令牌：能访问此端口的内网设备可操作下载任务。保留来源 IP、Host/Origin 和路径检查；不要做公网端口映射或公开反向代理。可用防火墙仅放行 Hermes 后端 IP。</p>
    <div className="preset-row"><button type="button" className="btn btn-primary" onClick={save}>保存接口设置</button><button type="button" className="btn btn-outline" onClick={testRoot}>测试已保存目录</button><button type="button" className="btn btn-outline" onClick={load}>刷新状态</button></div>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </fieldset>;
}
