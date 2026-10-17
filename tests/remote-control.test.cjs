// SPDX-License-Identifier: GPL-3.0-only
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createRemoteControl, validateConfig, normalizeConfig, isLanAddress, seriesId, TOOLS } = require('../src/native/remote-control.cjs');
const { checkStorage, assertDestination, contained } = require('../src/native/remote-storage.cjs');
const SECRET = 'test-private-data-not-to-be-exported';
async function freePort() {
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  return port;
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-lan-test-'));
  const root = path.join(dir, 'share'); await fs.mkdir(root);
  const configFile = path.join(dir, 'remote.json'), port = await freePort();
  const config = { enabled: true, host: '127.0.0.1', port, allowedHosts: [], requireNetworkMount: false };
  await fs.writeFile(configFile, JSON.stringify(config));
  const tasks = [], calls = [];
  const data = { series_id: '1234', series_title: '测试剧', episodes: [1, 2, 3].map(n => ({ vid: 'vid' + n, vid_index: n, title: '第' + n + '集', locked: n === 3 })) };
  const destinationFor = (_data, ep) => path.join(root, 'series', ep.vid_index + '.mp4');
  const invoke = async (channel, ...args) => {
    calls.push(channel);
    if (options.beforeInvoke) await options.beforeInvoke(channel);
    if (channel === 'search-series') return { success: true, results: [{ series_id: '1234', title: '测试剧' }] };
    if (channel === 'search-resolve') return { success: true, data };
    if (channel === 'get-queue-status') return { active: 0, queued: tasks.filter(x => x.status === 'pending').length, maxConcurrent: 3 };
    if (channel === 'hongguo-download-batch') {
      let count = 0;
      for (const ep of args[0].episodes) if (!tasks.some(t => t.hongguoInfo.vid === ep.vid)) {
        tasks.push({ id: 'task' + ep.vid_index, savePath: destinationFor(data, ep), status: 'pending', progress: 0,
          hongguoInfo: { vid: ep.vid, vid_index: ep.vid_index, series_id: '1234' }, title: ep.title }); count++;
      }
      return { success: true, count };
    }
    if (channel === 'stop-download' || channel === 'retry-task') {
      const task = tasks.find(t => t.id === args[0]);
      if (!task) return { success: false, error: '任务不存在' };
      task.status = channel === 'stop-download' ? 'stopped' : 'pending';
      return { success: true };
    }
    throw new Error('Unexpected handler ' + channel);
  };
  const args = { configFile, invoke, getRoot: () => root, getTaskSnapshot: () => tasks, destinationFor };
  const api = createRemoteControl(args); await api.start();
  t.after(async () => { await api.stop(); await fs.rm(dir, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + port;
  const request = (route, init = {}) => fetch(url + route, init);
  const rpc = (method, params, id = 1, headers = {}) => request('/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params === undefined ? {} : { params }) })
  });
  return { api, args, data, tasks, calls, dir, root, config, request, rpc, url };
}
const batch = (request_id = 'r1', numbers = [1, 2]) => ({ series_id: '1234', episode_numbers: numbers, request_id });

test('disabled by default; no token is generated or stored', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hongguo-lan-default-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const api = createRemoteControl({ configFile: path.join(dir, 'remote.json'), invoke() {}, getRoot: () => dir, getTaskSnapshot: () => [], destinationFor() {} });
  const s = await api.start(); assert.equal(s.enabled, false); assert.equal(s.running, false); assert.equal(s.token, undefined); assert.equal(s.authentication, 'none');
  assert.equal((await fs.readFile(path.join(dir, 'remote.json'), 'utf8')).includes('token'), false);
});
test('MCP initialization negotiates supported protocol', async t => {
  const f = await fixture(t);
  const r = await f.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const data = await r.json(); assert.equal(r.status, 200); assert.equal(data.result.protocolVersion, '2025-06-18'); assert.ok(data.result.capabilities.tools);
});
test('MCP notifications get 202; GET gets 405', async t => {
  const f = await fixture(t);
  const r = await f.request('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(r.status, 202); assert.equal(await r.text(), ''); assert.equal((await f.request('/mcp')).status, 405);
});
test('MCP exposes only the eight specific tools, not arbitrary IPC or deletion', async t => {
  const f = await fixture(t), r = await f.rpc('tools/list'), d = await r.json();
  assert.equal(d.result.tools.length, 8); assert.equal(d.result.tools.some(t => /delete|shell|file_read|settings/.test(t.name)), false);
  assert.equal(TOOLS.find(t => t.name === 'storage_status').annotations.readOnlyHint, false);
});
test('all endpoints work without Authorization; leftover headers do not gate access', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.url + '/api/status')).status, 200);
  assert.equal((await fetch(f.url + '/api/tools')).status, 200);
  assert.equal((await fetch(f.url + '/mcp')).status, 405);
  assert.equal((await f.rpc('ping', {})).status, 200);
  const r = await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'queue_status', arguments: {} }) });
  assert.equal(r.status, 200);
  assert.equal((await f.request('/api/status', { headers: { Authorization: 'Bearer obsolete' } })).status, 200);
});
test('blocks browser Origin and forged Host without relying on authentication', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/status', { headers: { Origin: 'null' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/api/status', { headers: { Host: 'evil.example:' + f.config.port } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostStatus, 403);
});
test('MCP rejects unsupported protocol headers and missing Accept types', async t => {
  const f = await fixture(t);
  assert.equal((await f.rpc('ping', {}, 1, { 'MCP-Protocol-Version': 'invalid' })).status, 400);
  assert.equal((await f.rpc('ping', {}, 1, { Accept: 'application/json' })).status, 406);
});
test('REST status explicitly reports no authentication and LAN scope', async t => {
  const f = await fixture(t); const text = await (await f.request('/api/status')).text();
  assert.equal(JSON.parse(text).authentication, 'none'); assert.equal(JSON.parse(text).accessScope, 'lan-only'); assert.equal(JSON.parse(text).token, undefined);
});
test('invalid JSON / media types / oversized payloads fail', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(65537) })).status, 413);
});
test('search/resolve routes use original handlers and hide raw media IDs in episode output', async t => {
  const f = await fixture(t);
  const a = await f.api.call('search_series', { keyword: '测试剧' }); assert.equal(a.results.length, 1);
  const b = await f.api.call('resolve_series', { series_id: '1234' }); assert.equal(b.episodes.length, 3); assert.equal(b.episodes[0].vid, undefined);
});
test('resolve_series returns string IDs without rounding long or prefixed IDs', async t => {
  const f = await fixture(t);
  for (const id of [1234, '1234567890123456789', 'hema:episode_1', 'xifan:series-2']) {
    f.data.series_id = id;
    const result = await f.api.call('resolve_series', { series_id: String(id) });
    assert.equal(result.series_id, String(id));
  }
});
test('download submits a job, returns IDs without waiting for media download', async t => {
  const f = await fixture(t), r = await f.api.call('download_episodes', batch());
  assert.equal(r.count, 2); assert.equal(r.tasks[0].id, 'task1'); assert.equal(r.tasks[0].status, 'pending');
});
test('simultaneous duplicate request_id is executed once', async t => {
  const f = await fixture(t, { beforeInvoke: async channel => { if (channel === 'search-resolve') await new Promise(r => setTimeout(r, 15)); } });
  const [a, b] = await Promise.all([f.api.call('download_episodes', batch()), f.api.call('download_episodes', batch())]);
  assert.equal(a.tasks[0].id, b.tasks[0].id); assert.equal(f.calls.filter(x => x === 'hongguo-download-batch').length, 1);
});
test('request_id conflict fails; idempotency survives restart', async t => {
  const f = await fixture(t); await f.api.call('download_episodes', batch());
  await assert.rejects(f.api.call('download_episodes', batch('r1', [1])), /request_id/);
  await f.api.stop(); const other = createRemoteControl(f.args); await other.start();
  t.after(() => other.stop());
  const replay = await other.call('download_episodes', batch()); assert.equal(replay.replayed, true);
  assert.equal(f.calls.filter(x => x === 'hongguo-download-batch').length, 1);
  await other.stop();
});
test('missing or locked episode rejects entire batch before queue mutation', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.call('download_episodes', batch('missing', [1, 9])), /不存在/);
  await assert.rejects(f.api.call('download_episodes', batch('locked', [1, 3])), /未开放/);
  assert.equal(f.tasks.length, 0);
});
test('input validation rejects arbitrary URLs, path overrides and duplicate numbers', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.call('resolve_series', { series_id: 'http://127.0.0.1/admin' }), /series_id/);
  await assert.rejects(f.api.call('download_episodes', { ...batch(), output: '/tmp/escape' }), /参数/);
  await assert.rejects(f.api.call('download_episodes', batch('dup', [1, 1])), /参数/);
  await assert.rejects(f.api.call('delete_file', { path: '/tmp/a' }), /未开放/);
});
test('pagination and allowlisted task serialization', async t => {
  const f = await fixture(t); await f.api.call('download_episodes', batch());
  f.tasks[0].secret = SECRET; f.tasks[0].writer = { circular: null }; f.tasks[0].writer.circular = f.tasks[0].writer;
  const list = await f.api.call('list_downloads', { limit: 1 });
  assert.equal(list.total, 2); assert.equal(list.next_offset, 1); assert.equal(JSON.stringify(list).includes(SECRET), false);
});
test('list_downloads exposes optional read-only task_id filtering over MCP and REST', async t => {
  const f = await fixture(t);
  f.tasks.push(...['task1', 'task10'].map(id => ({ id, savePath: path.join(f.root, id + '.mp4'),
    status: 'pending', hongguoInfo: { series_id: '1234' } })));
  const tools = (await (await f.rpc('tools/list')).json()).result.tools;
  assert.equal(tools.length, 8);
  const spec = tools.find(tool => tool.name === 'list_downloads');
  assert.equal(spec.inputSchema.properties.task_id?.type, 'string');
  assert.equal(spec.inputSchema.required.includes('task_id'), false);
  assert.equal(spec.annotations.readOnlyHint, true);
  assert.deepEqual((await (await f.request('/api/tools')).json()).tools, tools);
  const rpc = await (await f.rpc('tools/call', { name: 'list_downloads', arguments: { task_id: 'task1', limit: 1 } })).json();
  assert.equal(rpc.result.isError, false);
  const result = JSON.parse(rpc.result.content[0].text);
  assert.equal(result.total, 1); assert.equal(result.offset, 0); assert.equal(result.next_offset, null);
  assert.deepEqual(result.tasks.map(task => task.id), ['task1']);
  const rest = await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'list_downloads', arguments: { task_id: 'task1' } }) });
  assert.equal(rest.status, 200); assert.deepEqual(await rest.json(), result);
  assert.deepEqual(f.calls, []); assert.ok(f.tasks.every(task => task.status === 'pending'));
});
test('task serialization returns string series IDs and preserves missing metadata', async t => {
  const f = await fixture(t);
  for (const id of [1234, '1234567890123456789', 'hema:episode_1', 'xifan:series-2', null, undefined]) {
    f.tasks.splice(0, f.tasks.length, { id: 'task1', savePath: path.join(f.root, '1.mp4'),
      status: 'pending', hongguoInfo: { series_id: id } });
    const result = await f.api.call('list_downloads', { task_id: 'task1' });
    assert.equal(result.tasks[0].series_id, id == null ? id : String(id));
  }
  f.tasks[0].hongguoInfo = undefined;
  assert.equal((await f.api.call('list_downloads', {})).tasks[0].series_id, undefined);
});
test('task_id filter returns empty for unknown, partial, case-changed or path values', async t => {
  const f = await fixture(t);
  const savePath = path.join(f.root, 'task1.mp4');
  f.tasks.push({ id: 'task1', savePath, status: 'pending', hongguoInfo: { series_id: '1234' } });
  for (const task_id of ['unknown', 'task', 'TASK1', ' task1 ', savePath, '../task1.mp4']) {
    assert.deepEqual(await f.api.call('list_downloads', { task_id }), { total: 0, offset: 0, next_offset: null, tasks: [] });
  }
  for (const task_id of [1, null, {}, [], '', 'a'.repeat(129), 'task1\n']) {
    await assert.rejects(f.api.call('list_downloads', { task_id }), /参数/);
  }
  await assert.rejects(f.api.call('list_downloads', { path: savePath }), /参数/);
  assert.deepEqual(f.calls, []);
});
test('task_id and series_id intersect before pagination without changing unfiltered pages', async t => {
  const f = await fixture(t);
  f.tasks.push(...[1234, 5678, 1234].map((id, index) => ({ id: 'task' + index,
    savePath: path.join(f.root, index + '.mp4'), status: 'pending', hongguoInfo: { series_id: id } })));
  const matched = await f.api.call('list_downloads', { task_id: 'task2', series_id: '1234', limit: 1 });
  assert.equal(matched.total, 1); assert.equal(matched.next_offset, null);
  assert.deepEqual(matched.tasks.map(task => task.id), ['task2']);
  assert.deepEqual(await f.api.call('list_downloads', { task_id: 'task2', series_id: '5678' }),
    { total: 0, offset: 0, next_offset: null, tasks: [] });
  assert.deepEqual(await f.api.call('list_downloads', { task_id: 'task2', offset: 1, limit: 1 }),
    { total: 1, offset: 1, next_offset: null, tasks: [] });
  await assert.rejects(f.api.call('list_downloads', { task_id: 'task2', series_id: '../' }), /series_id/);
  const first = await f.api.call('list_downloads', { limit: 1 });
  assert.equal(first.total, 3); assert.equal(first.offset, 0); assert.equal(first.next_offset, 1);
  assert.deepEqual(first.tasks.map(task => task.id), ['task0']);
  const next = await f.api.call('list_downloads', { offset: 1, limit: 1 });
  assert.equal(next.total, 3); assert.equal(next.offset, 1); assert.equal(next.next_offset, 2);
  assert.deepEqual(next.tasks.map(task => task.id), ['task1']);
  const series = await f.api.call('list_downloads', { series_id: '1234', limit: 1 });
  assert.equal(series.total, 2); assert.equal(series.next_offset, 1);
  const last = await f.api.call('list_downloads', { series_id: '1234', offset: 1, limit: 1 });
  assert.equal(last.total, 2); assert.equal(last.next_offset, null);
  assert.deepEqual(last.tasks.map(task => task.id), ['task2']);
});
test('task_id filtering remains confined to the current storage root', async t => {
  const f = await fixture(t);
  f.tasks.push(
    { id: 'outside', savePath: path.join(f.dir, 'other.mp4'), status: 'completed' },
    { id: 'sibling', savePath: path.join(f.root + '-other', '1.mp4'), status: 'pending' },
    { id: 'traversal', savePath: path.join(f.root, '..', 'escape.mp4'), status: 'pending' },
    { id: 'no-path', status: 'pending' }
  );
  for (const task of f.tasks) {
    assert.deepEqual(await f.api.call('list_downloads', { task_id: task.id }),
      { total: 0, offset: 0, next_offset: null, tasks: [] });
  }
  assert.deepEqual(f.calls, []);
});
test('task_id filtering still verifies completed file availability without changing records', async t => {
  const f = await fixture(t);
  const savePath = path.join(f.root, '1.mp4');
  f.tasks.push({ id: 'task1', savePath, status: 'completed', hongguoInfo: { series_id: '1234' } });
  const read = async () => (await f.api.call('list_downloads', { task_id: 'task1' })).tasks[0];
  let result = await read();
  assert.equal(result.status, 'file_unavailable'); assert.equal(result.file_available, false);
  assert.equal(result.recorded_status, 'completed'); assert.ok(result.file_error);
  await fs.writeFile(savePath, Buffer.alloc(102400));
  result = await read();
  assert.equal(result.status, 'file_unavailable'); assert.equal(result.file_available, false);
  await fs.writeFile(savePath, Buffer.alloc(102401));
  result = await read();
  assert.equal(result.status, 'completed'); assert.equal(result.file_available, true);
  assert.equal(result.file_size, 102401); assert.equal(result.recorded_status, 'completed');
  await fs.unlink(savePath); await fs.mkdir(savePath);
  result = await read();
  assert.equal(result.status, 'file_unavailable'); assert.equal(result.file_available, false);
  assert.equal(f.tasks[0].status, 'completed'); assert.deepEqual(f.calls, []);
});
test('task_id filtering does not report completed files through an escaping junction as available', async t => {
  const f = await fixture(t);
  const outside = path.join(f.dir, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, '1.mp4'), Buffer.alloc(102401));
  const link = path.join(f.root, 'linked');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('OS disallows symlink creation'); throw e; }
  f.tasks.push({ id: 'linked', savePath: path.join(link, '1.mp4'), status: 'completed' });
  const result = await f.api.call('list_downloads', { task_id: 'linked' });
  assert.equal(result.tasks[0].status, 'file_unavailable'); assert.equal(result.tasks[0].file_available, false);
  assert.equal(result.tasks[0].recorded_status, 'completed'); assert.match(result.tasks[0].file_error, /越出/);
  assert.equal(f.tasks[0].status, 'completed'); assert.deepEqual(f.calls, []);
});
test('remote task operations cannot touch a different storage root', async t => {
  const f = await fixture(t);
  f.tasks.push({ id: 'outside', savePath: path.join(f.dir, 'other.mp4'), status: 'pending', hongguoInfo: {} });
  await assert.rejects(f.api.call('stop_download', { task_id: 'outside' }), /目录/);
  assert.equal((await f.api.call('list_downloads', {})).total, 0);
});
test('stop remains possible when share is disconnected; retry is blocked', async t => {
  const f = await fixture(t); await f.api.call('download_episodes', batch());
  await fs.rename(f.root, f.root + '-offline');
  assert.equal((await f.api.call('stop_download', { task_id: 'task1' })).success, true);
  await assert.rejects(f.api.call('retry_download', { task_id: 'task1' }), /不可达/);
  await assert.rejects(f.api.call('download_episodes', batch('offline', [1])), /不可达/);
  await assert.rejects(fs.stat(f.root), { code: 'ENOENT' });
});
test('stop completed task is a no-op; retry active task is a no-op', async t => {
  const f = await fixture(t); await f.api.call('download_episodes', batch());
  assert.equal((await f.api.call('retry_download', { task_id: 'task1' })).unchanged, true);
  f.tasks[0].status = 'completed';
  assert.equal((await f.api.call('stop_download', { task_id: 'task1' })).unchanged, true); assert.equal(f.tasks[0].status, 'completed');
});
test('root probe cleans up; absent root is not created', async t => {
  const f = await fixture(t); assert.equal((await checkStorage(f.root)).writable, true);
  assert.deepEqual(await fs.readdir(f.root), []);
  await assert.rejects(checkStorage(path.join(f.root, 'not-mounted')), /不可达/);
  await assert.rejects(fs.stat(path.join(f.root, 'not-mounted')), { code: 'ENOENT' });
});
test('rejects path traversal and symlink escapes', async t => {
  const f = await fixture(t);
  assert.equal(contained(f.root, f.root + '-other/a'), false);
  await fs.mkdir(path.join(f.dir, 'outside'));
  try { await fs.symlink(path.join(f.dir, 'outside'), path.join(f.root, 'series'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') return t.skip('OS disallows symlink creation'); throw e; }
  await assert.rejects(assertDestination(f.root, path.join(f.root, 'series', '1.mp4')), /越出/);
  await assert.rejects(f.api.call('download_episodes', batch()), /越出/); assert.equal(f.tasks.length, 0);
});
test('network mount requirement rejects ordinary local directory', async t => {
  const f = await fixture(t);
  await assert.rejects(checkStorage(f.root, { requireMount: true }), /挂载|Linux/);
});
test('legacy tokens are removed from disk and status during migration', async t => {
  const f = await fixture(t); await f.api.stop();
  await fs.writeFile(f.args.configFile, JSON.stringify({ ...f.config, token: SECRET, rotateToken: true }));
  const other = createRemoteControl(f.args); t.after(() => other.stop());
  const status = await other.start();
  assert.equal(status.token, undefined);
  const saved = JSON.parse(await fs.readFile(f.args.configFile, 'utf8'));
  assert.equal(saved.token, undefined); assert.equal(saved.rotateToken, undefined);
  assert.equal((await f.request('/api/status')).status, 200);
  await other.stop();
});
test('bad reconfiguration preserves listener; public bind addresses are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.reconfigure({ port: 80 }), /端口/);
  await assert.rejects(f.api.reconfigure({ host: '8.8.8.8' }), /公网/);
  assert.equal((await f.request('/api/status')).status, 200);
  assert.throws(() => validateConfig({ ...f.config, port: 80 }), /端口/);
});
test('busy operations prevent reconfiguration', async t => {
  let unlock; const gate = new Promise(resolve => { unlock = resolve; });
  const f = await fixture(t, { beforeInvoke: async channel => { if (channel === 'search-resolve') await gate; } });
  const running = f.api.call('resolve_series', { series_id: '1234' });
  await assert.rejects(f.api.reconfigure({ port: 17654 }), /运行中/); unlock(); await running;
});
test('MCP tool errors are isError=true, and unknown RPC method returns -32601', async t => {
  const f = await fixture(t);
  const d = await (await f.rpc('tools/call', { name: 'resolve_series', arguments: { series_id: '../' } })).json();
  assert.equal(d.result.isError, true);
  assert.equal((await (await f.rpc('does/not/exist')).json()).error.code, -32601);
});
test('REST tool invocation reaches the same service as MCP', async t => {
  const f = await fixture(t);
  const r = await f.request('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'download_episodes', arguments: batch() }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).count, 2);
  const rpc = await (await f.rpc('tools/call', { name: 'queue_status', arguments: {} })).json();
  assert.equal(JSON.parse(rpc.result.content[0].text).queued, 2);
});

test('completed records do not claim an unavailable file is ready', async t => {
  const f = await fixture(t); await f.api.call('download_episodes', batch());
  f.tasks[0].status = 'completed';
  const result = await f.api.call('list_downloads', {});
  assert.equal(result.tasks[0].recorded_status, 'completed');
  assert.equal(result.tasks[0].status, 'file_unavailable');
  assert.equal(result.tasks[0].file_available, false);
});

test('LAN peer rules accept private IPv4 and reject public or malformed addresses', () => {
  for (const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','172.31.255.254','192.168.1.2','169.254.2.1','100.64.0.1','100.127.255.254','::ffff:192.168.1.2']) assert.equal(isLanAddress(ip), true, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','172.15.1.1','172.32.0.1','192.169.1.2','100.63.255.255','100.128.0.1','0.0.0.0','255.255.255.255','192.168.evil','::1',null,undefined]) assert.equal(isLanAddress(ip), false, String(ip));
});
test('old token controls are ignored rather than re-enabling authentication', async t => {
  const f = await fixture(t);
  const saved = await f.api.reconfigure({ token: 'short', rotateToken: true });
  assert.equal(saved.settings.token, undefined);
  assert.equal(saved.settings.authentication, 'none');
  assert.equal((await f.request('/api/status')).status, 200);
  assert.equal(JSON.parse(await fs.readFile(f.args.configFile, 'utf8')).token, undefined);
});
test('Host allowlist does not override Origin validation', async t => {
  const f = await fixture(t); await f.api.reconfigure({ allowedHosts: ['download.lan'] });
  const status = headers => new Promise((resolve, reject) => {
    const req = http.request(f.url + '/api/status', { headers }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(await status({ Host: 'download.lan:' + f.config.port }), 200);
  assert.equal(await status({ Host: 'download.lan:' + f.config.port, Origin: 'http://download.lan:' + f.config.port }), 403);
});
test('forwarded headers cannot bypass the Host gate', async t => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/api/status', { headers: { Host: 'evil.example:' + f.config.port, 'X-Forwarded-For': '192.168.1.1', 'X-Forwarded-Host': '127.0.0.1:' + f.config.port } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 403);
});
test('config normalization keeps approved settings only', () => {
  const saved = normalizeConfig({ enabled: true, host: '0.0.0.0', token: SECRET, unknown: 'not retained' });
  assert.equal(saved.enabled, true); assert.equal(saved.host, '0.0.0.0'); assert.equal(saved.port, 17653);
  assert.equal(saved.token, undefined); assert.equal(saved.unknown, undefined);
  assert.throws(() => normalizeConfig(null));
});
