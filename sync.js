'use strict';
// ── 记录级同步（A 批 · 地基 4）────────────────────────────────────
//
// 为什么不用「整包覆盖」：两台设备交替用，整包只能二选一，进度会互相盖掉。
// 这里按 SPEC §2.4 做记录级：**一本书一条**（指纹 / 档案指针 / 位置 / 更新时间 / 删除墓碑），
// 合并按记录各算各的，A 改了《狄公案》、B 改了《教材》，两边都不丢。
//
// 云端布局（一人一仓，每设备一个文件，永远不写同一个文件）：
//   zenus-state/<人>/<设备>.json
// 不填「人」时退回旧布局 devices/<设备>.json，老数据照样能读（迁移不丢）。
//
// 合并规则：
//   位置 / 档案指针 / 书名 → 整条记录按 updatedAt 新的赢（LWW）
//   位置历史 history       → 并集（按 device+at 去重），所以「两边各自的进度」都留得住
//   删除                  → 墓碑单调：删了就是删了，旧记录不能把它复活；
//                           只有显式 revivedAt > deletedAt 才算真复活（重导入时写它）
//
// 读取走 GitHub API 并带 ETag（SPEC §9.4：raw 有 CDN 缓存，会读到旧版）。
// 这个文件不碰 app.js 的全局变量：状态从外面传进来，结果传出去，好测。

window.ZSync = (function () {
  const SCHEMA = 2;
  const CACHE_KEY = 'zenus.ghcache.v1';
  const CACHE_MAX = 60;

  function safeName(s) {
    return String(s || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 64);
  }

  // 人 → 设备.json；没填人就走旧路径，老设备文件还能读到
  function pathOf(person, device) {
    const p = safeName(person);
    return (p ? p + '/' : 'devices/') + safeName(device) + '.json';
  }

  function emptyState(person, device) {
    return { schema: SCHEMA, person: safeName(person), device: safeName(device), updatedAt: 0, records: {} };
  }

  // ── 一条记录 ──────────────────────────────────────
  function recordOf({ doc, archive, position, device }) {
    const fp = (doc && doc.fingerprint) || {};
    const cov = (archive && archive.coverage) || {};
    return {
      docId: doc.docId,
      key: doc.key || doc.docId,          // 阅读位置在 readPositions 里的键
      name: doc.name || '',
      kind: doc.kind || '',
      fingerprint: { fileHash: fp.fileHash || '', convVersion: fp.convVersion || '', promptVersion: fp.promptVersion || '' },
      archive: archive ? {
        id: archive.id,
        level: archive.level,
        verdict: archive.verdict,
        playable: !!archive.playable,
        chars: cov.chars || 0,
        paras: cov.paras || 0,
        fingerprint: archive.fingerprint || null,
      } : null,
      position: position ? {
        at: position.at || 0, ch: position.ch || 0, page: position.page || 0, ratio: position.ratio || 0,
        device: safeName(device),
      } : null,
      history: position ? [{ at: position.at || 0, ch: position.ch || 0, page: position.page || 0, ratio: position.ratio || 0, device: safeName(device) }] : [],
      updatedAt: Math.max((doc && doc.updatedAt) || 0, (position && position.at) || 0, (doc && doc.deletedAt) || 0),
      deleted: !!(doc && doc.deletedAt),
      deletedAt: (doc && doc.deletedAt) || null,
      revivedAt: (doc && doc.revivedAt) || null,
    };
  }

  function unionHistory(a, b) {
    const seen = new Set();
    const out = [];
    for (const h of (a || []).concat(b || [])) {
      if (!h) continue;
      const k = h.device + '@' + h.at;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(h);
    }
    out.sort((x, y) => (x.at || 0) - (y.at || 0));
    return out.slice(-20);
  }

  // 单条记录的合并：墓碑 > 时间戳
  // 注意「两个轴」：位置按 position.at 比（读到哪跟档案建立时间无关），
  // 书名/档案指针按 updatedAt 比。混成一个时间戳会出现「新设备刚建档案就把老设备读到的位置顶掉」。
  function mergeRecord(a, b) {
    if (!a) return b;
    if (!b) return a;
    const tombA = a.deleted ? (a.deletedAt || 0) : 0;
    const tombB = b.deleted ? (b.deletedAt || 0) : 0;
    if (tombA || tombB) {
      const tomb = tombA >= tombB ? a : b;
      const revA = a.revivedAt || 0;
      const revB = b.revivedAt || 0;
      if (Math.max(revA, revB) > (tomb.deletedAt || 0)) {
        const live = revA >= revB ? a : b;
        return { ...live, deleted: false, deletedAt: null, revivedAt: Math.max(revA, revB) };
      }
      return { ...tomb, history: unionHistory(a.history, b.history) };
    }
    const newer = (b.updatedAt || 0) > (a.updatedAt || 0) ? b : a;
    const posA = (a.position && a.position.at) || 0;
    const posB = (b.position && b.position.at) || 0;
    const position = posB > posA ? b.position : (a.position || b.position || null);
    return {
      ...newer,
      position,
      history: unionHistory(a.history, b.history),
      updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    };
  }

  // 两份设备状态的合并
  function mergeStates(local, remote) {
    const out = {
      ...local,
      schema: SCHEMA,
      records: { ...((local && local.records) || {}) },
      updatedAt: Math.max((local && local.updatedAt) || 0, (remote && remote.updatedAt) || 0),
    };
    let taken = 0;
    const revived = [];
    const tombstones = [];
    for (const [id, rec] of Object.entries((remote && remote.records) || {})) {
      const cur = out.records[id];
      const win = mergeRecord(cur, rec);
      if (win !== cur) {
        out.records[id] = win;
        taken++;
        if (win.deleted) tombstones.push(id);
        if (!win.deleted && cur && cur.deleted) revived.push(id);
      }
    }
    return { state: out, taken, tombstones, revived };
  }

  // ── GitHub 传输层（带 ETag，读过的文件 304 就不再下正文）──────────
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64decode(b64) {
    const bin = atob(String(b64 || '').replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function ghTransport({ token, repo, fetchImpl }) {
    const f = fetchImpl || ((...a) => fetch(...a));
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (e) { cache = {}; }
    const saveCache = () => {
      const keys = Object.keys(cache);
      if (keys.length > CACHE_MAX) for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 配额满就别缓存了 */ }
    };
    const headers = () => ({
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    });
    const api = 'https://api.github.com/repos/' + repo + '/contents/';

    async function get(path) {
      const etag = cache[path] && cache[path].etag;
      const r = await f(api + path, {
        headers: etag ? { ...headers(), 'If-None-Match': etag } : headers(),
        cache: 'no-store',
      });
      if (r.status === 304 && cache[path]) return { ...cache[path].json, cached: true };
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
      const j = await r.json();
      cache[path] = { etag: (r.headers && r.headers.get && r.headers.get('etag')) || '', json: j };
      saveCache();
      return j;
    }

    async function list(dir) {
      const r = await f(api + dir, { headers: headers(), cache: 'no-store' });
      if (r.status === 404) return [];
      if (!r.ok) throw new Error('列目录失败 HTTP ' + r.status);
      const j = await r.json();
      return Array.isArray(j) ? j : [];
    }

    async function put(path, text, sha) {
      const body = { message: 'sync ' + new Date().toISOString(), content: b64encode(text) };
      if (sha) body.sha = sha;
      const r = await f(api + path, {
        method: 'PUT',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error('写入失败 HTTP ' + r.status + ' ' + String(await r.text()).slice(0, 120));
      const j = await r.json();
      delete cache[path];                              // 写完 etag 失效，下次重新取
      saveCache();
      return j;
    }

    return { get, list, put, _cache: () => cache };
  }

  // 目录名：人目录（或旧 devices/）
  function dirOf(person) {
    const p = safeName(person);
    return p || 'devices';
  }

  // ── 一轮同步 ──────────────────────────────────────
  // deps: { transport, person, device, records, now }
  // 返回 { state, taken, tombstones, revived, devices, uploaded, path }
  async function syncNow(deps) {
    const { transport, person, device, records, now } = deps;
    const mine = emptyState(person, device);
    mine.records = records || {};
    mine.updatedAt = now || Date.now();
    const path = pathOf(person, device);

    const dir = dirOf(person);
    let files = [];
    try { files = await transport.list(dir); } catch (err) { files = []; }
    let state = mine;
    let taken = 0;
    let tombstones = [];
    let revived = [];
    const seenDevices = [];
    const myName = safeName(device) + '.json';
    for (const f of files) {
      if (!f || !f.name || !f.name.endsWith('.json')) continue;
      seenDevices.push(f.name.replace(/\.json$/, ''));
      if (f.name === myName) continue;
      let one = null;
      try { one = await transport.get(dir + '/' + f.name); } catch (err) { continue; }
      if (!one || !one.content) continue;
      let remote = null;
      try { remote = JSON.parse(b64decode(one.content)); } catch (err) { continue; }   // 坏文件跳过，不带崩同步
      const r = mergeStates(state, remote);
      state = r.state;
      taken += r.taken;
      tombstones = tombstones.concat(r.tombstones);
      revived = revived.concat(r.revived);
    }

    // 推自己：先取 sha（ETag 命中时用缓存里的 sha）
    const own = await transport.get(path).catch(() => null);
    const payload = JSON.stringify(state);
    await transport.put(path, payload, own && own.sha);
    return { state, taken, tombstones, revived, devices: seenDevices, uploaded: payload.length, path };
  }

  return {
    SCHEMA, pathOf, dirOf, safeName, emptyState,
    recordOf, mergeRecord, mergeStates, unionHistory,
    ghTransport, b64encode, b64decode, syncNow,
  };
})();
