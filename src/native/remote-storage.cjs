// SPDX-License-Identifier: GPL-3.0-only
// LAN extension: never create a missing share root or fall back to a local directory.
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function contained(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function absoluteRoot(root) {
  if (typeof root !== 'string' || !root.trim() || !path.isAbsolute(root.trim())) {
    throw new Error('保存目录必须是本机绝对路径；Windows 可用 UNC，Linux/WSL 请先挂载共享目录。');
  }
  return path.resolve(root.trim());
}
async function requireNetworkMount(root) {
  if (process.platform !== 'linux') throw new Error('网络挂载检查只适用于 Linux/WSL；Windows UNC 无需启用此项。');
  const unescape = s => s.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
  const mounts = (await fs.readFile('/proc/self/mountinfo', 'utf8')).trim().split('\n').map(line => {
    const [before, after] = line.split(' - ');
    return { dir: unescape(before.split(' ')[4]), type: after?.split(' ')[0] };
  }).filter(m => contained(m.dir, root)).sort((a, b) => b.dir.length - a.dir.length);
  if (!mounts.length || !['cifs', 'smb3', 'nfs', 'nfs4'].includes(mounts[0].type)) {
    throw new Error('共享目录没有位于已挂载的 CIFS/SMB/NFS 文件系统中，已阻止写入本地空挂载点。');
  }
}
async function checkStorage(root, { requireMount = false, write = true } = {}) {
  const configured = absoluteRoot(root);
  const realRoot = await fs.realpath(configured).catch(() => { throw new Error('保存目录不存在或共享不可达；请先连接共享，不会自动创建或回退。'); });
  if (!(await fs.stat(realRoot)).isDirectory()) throw new Error('保存位置不是文件夹。');
  if (requireMount) await requireNetworkMount(realRoot);
  if (write) {
    const probe = path.join(realRoot, '.hongguo-write-test-' + crypto.randomUUID());
    let handle;
    try {
      handle = await fs.open(probe, 'wx', 0o600);
      await handle.writeFile('hongguo LAN storage probe\n');
      await handle.sync();
    } finally {
      if (handle) { await handle.close(); await fs.unlink(probe); }
    }
  }
  let freeBytes = null;
  try { const stat = await fs.statfs(realRoot); freeBytes = Number(stat.bavail) * Number(stat.bsize); } catch (_) {}
  return { success: true, root: configured, realRoot, writable: write, freeBytes, networkMountRequired: requireMount };
}
async function assertDestination(root, target) {
  const realRoot = await fs.realpath(absoluteRoot(root));
  if (!contained(root, target)) throw new Error('任务路径不在当前保存目录内，远程操作已拒绝。');
  let cursor = path.resolve(target);
  for (;;) {
    let resolved;
    try { resolved = await fs.realpath(cursor); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('无法验证任务目录。');
      cursor = parent; continue;
    }
    if (!contained(realRoot, resolved)) throw new Error('路径通过符号链接或目录联接越出了保存目录。');
    return;
  }
}
module.exports = { contained, absoluteRoot, requireNetworkMount, checkStorage, assertDestination };
