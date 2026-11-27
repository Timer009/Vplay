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

  function sleepSync(ms) {
    const buffer = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(buffer), 0, 0, ms);
  }

  /** B11 / C10-06：设备存储的读-改-写互斥，避免 revoke 与 create 互相覆盖。 */
  function withLock(fn) {
    const lockFile = `${file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        let info = null;
        try {
          info = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
        } catch {
          info = null;
        }
        let stale = false;
        if (info) {
          try {
            process.kill(Number(info.pid), 0);
            stale = Date.now() - Number(info.at || 0) > 30000;
          } catch {
            stale = true;
          }
        } else {
          try {
            stale = Date.now() - fs.statSync(lockFile).mtimeMs > 5000;
          } catch {
            stale = false;
          }
        }
        if (stale) {
          try {
            fs.rmSync(lockFile, { force: true });
          } catch {
            // 忽略
          }
          continue;
        }
        if (Date.now() > deadline) {
          const error2 = new Error('device store is busy');
          error2.code = 'DEVICE_STORE_BUSY';
          throw error2;
        }
        sleepSync(20);
      }
    }
    try {
      return fn();
    } finally {
      try {
        fs.rmSync(lockFile, { force: true });
      } catch {
        // 忽略
      }
    }
  }

  function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  function normalizeProjects(projects) {
    if (!projects) return [];
    const list = Array.isArray(projects)
      ? projects
      : String(projects)
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
    return [...new Set(list)];
  }

  function createDevice({ name, projects } = {}) {
    const scoped = normalizeProjects(projects);
    // C10-09：无项目参数不再 fail-open 到全部项目；必须显式给出 '*'。
    if (scoped.length === 0) {
      const error = new Error(
        'device must be scoped to at least one project (pass --projects=<id,...> or explicit "*")',
      );
      error.code = 'DEVICE_PROJECTS_REQUIRED';
      throw error;
    }
    return withLock(() => {
      const state = read();
      const token = `vdt_${crypto.randomBytes(24).toString('base64url')}`;
      const device = {
        id: `dev_${crypto.randomBytes(6).toString('hex')}`,
        name: String(name || 'device').slice(0, 60),
        tokenHash: tokenHash(token),
        projects: scoped,
        createdAt: new Date().toISOString(),
        lastSeen: null,
        revoked: false,
      };
      state.devices.push(device);
      write(state);
      return { device: { ...device, tokenHash: undefined }, token };
    });
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
    return withLock(() => {
      const state = read();
      const device = state.devices.find((item) => item.id === id);
      if (!device) return false;
      device.revoked = true;
      device.revokedAt = new Date().toISOString();
      write(state);
      return true;
    });
  }

  /**
   * C10-06：鉴权只读，不做整表回写。
   * 过去每次 authenticate 都 read-modify-write lastSeen，可能把并发 revoke 的结果覆盖回
   * `revoked:false`；现在 lastSeen 不再在鉴权路径持久化（需要时由运维/日志统计）。
   */
  function authenticate(token) {
    if (!token || !String(token).startsWith('vdt_')) return null;
    const hash = tokenHash(token);
    const state = read();
    const device = state.devices.find((item) => !item.revoked && item.tokenHash === hash);
    if (!device) return null;
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
