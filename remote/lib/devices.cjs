'use strict';

/**
 * 设备身份与项目授权（C07-P1-04）。
 *
 * - 主 token（REMOTE_TOKEN）始终是管理员：可查看全部任务/项目。
 * - 设备 token 由管理员通过 CLI 创建：`node remote/cli.cjs device add <name> [--projects a,b]`
 *   token 只在创建时输出一次，服务端仅保存 sha256。
 * - 设备只能看到自己创建的任务；事件流只广播元数据（X-03 跨端协同）。
 * - 项目白名单：`*` 或具体 projectId 列表。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createDeviceStore(options = {}) {
  const file = path.resolve(options.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, ''));
      if (!Array.isArray(parsed.devices)) return { devices: [] };
      return { devices: parsed.devices };
    } catch {
      return { devices: [] };
    }
  }

  function write(state) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  }

  function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  function normalizeProjects(projects) {
    if (!projects) return ['*'];
    const list = Array.isArray(projects)
      ? projects
      : String(projects)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
    return list.length ? list : ['*'];
  }

  function createDevice({ name, projects } = {}) {
    const state = read();
    const token = `vdt_${crypto.randomBytes(24).toString('base64url')}`;
    const device = {
      id: `dev_${crypto.randomBytes(6).toString('hex')}`,
      name: String(name || 'device').slice(0, 60),
      tokenHash: tokenHash(token),
      projects: normalizeProjects(projects),
      createdAt: new Date().toISOString(),
      lastSeen: null,
      revoked: false,
    };
    state.devices.push(device);
    write(state);
    return { device: { ...device, tokenHash: undefined }, token };
  }

  function list() {
    return read().devices.map((device) => ({ ...device, tokenHash: undefined }));
  }

  /** 按 id 读取设备（含 revoked 标记），供运行期吊销检查。 */
  function get(id) {
    const device = read().devices.find((item) => item.id === id);
    return device ? { ...device, tokenHash: undefined } : null;
  }

  /** 设备是否仍有效（未吊销）。管理员/未知设备返回 false。 */
  function isActive(id) {
    const device = read().devices.find((item) => item.id === id);
    return Boolean(device && !device.revoked);
  }

  function revoke(id) {
    const state = read();
    const device = state.devices.find((item) => item.id === id);
    if (!device) return false;
    device.revoked = true;
    device.revokedAt = new Date().toISOString();
    write(state);
    return true;
  }

  function authenticate(token) {
    if (!token || !String(token).startsWith('vdt_')) return null;
    const hash = tokenHash(token);
    const state = read();
    const device = state.devices.find((item) => !item.revoked && item.tokenHash === hash);
    if (!device) return null;
    device.lastSeen = new Date().toISOString();
    try {
      write(state);
    } catch {
      // lastSeen 写入失败不影响鉴权
    }
    return { id: device.id, name: device.name, projects: device.projects.slice() };
  }

  function isProjectAllowed(device, projectId) {
    if (!device) return false;
    if (device.projects.includes('*')) return true;
    return device.projects.includes(projectId);
  }

  return { file, createDevice, list, get, isActive, revoke, authenticate, isProjectAllowed };
}

module.exports = { createDeviceStore };
