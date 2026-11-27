'use strict';

/**
 * 预览票据（B13）：短期、可吊销、**服务端项目绑定**。
 *
 * - 登录票据可为 admin（主 token 登录），但 Vision 内部票据必须 admin:false 且绑定 projectId；
 * - 预览授权按 ticket.projectId 严格匹配 /p/<id>/，不再因 admin 分支绕过项目；
 * - 设备票据校验设备未吊销与项目 ACL；
 * - 全部只在内存，不落盘。
 */

const crypto = require('crypto');

function createPreviewTicketStore(options = {}) {
  const enabled = options.enabled === true;
  const devices = options.devices || null;
  const defaultTtlMs = Number(options.defaultTtlMs || 4 * 60 * 60 * 1000);
  const tickets = new Map();

  function prune() {
    const now = Date.now();
    for (const [value, ticket] of tickets) {
      if (now > ticket.expiresAt) tickets.delete(value);
    }
  }

  function issue({
    projectId = null,
    deviceId = null,
    admin = false,
    sessionKey = null,
    ttlMs = defaultTtlMs,
  } = {}) {
    if (!enabled) return null;
    prune();
    const value = crypto.randomBytes(32).toString('base64url');
    tickets.set(value, {
      projectId: projectId || null,
      deviceId: deviceId || null,
      admin: admin === true,
      sessionKey: sessionKey || null,
      expiresAt: Date.now() + Number(ttlMs || defaultTtlMs),
    });
    return value;
  }

  function revoke(predicate) {
    let removed = 0;
    for (const [value, ticket] of tickets) {
      if (!predicate || predicate(ticket)) {
        tickets.delete(value);
        removed += 1;
      }
    }
    return removed;
  }

  function authorize(value, projectId) {
    if (!enabled) return true;
    if (!value) return false;
    const ticket = tickets.get(value);
    if (!ticket) return false;
    if (Date.now() > ticket.expiresAt) {
      tickets.delete(value);
      return false;
    }
    if (ticket.deviceId) {
      const device = devices ? devices.get(ticket.deviceId) : null;
      if (!device || device.revoked) return false;
      if (projectId && devices && !devices.isProjectAllowed(device, projectId)) return false;
      return true;
    }
    // B13：admin 只对“未绑定项目”的登录票据生效；Vision 票据绑定项目后按项目校验
    if (ticket.admin && !ticket.projectId) return true;
    if (projectId && ticket.projectId && ticket.projectId !== projectId) return false;
    if (!projectId && ticket.projectId) return true; // 全局检查，具体项目在路由层再校验
    return Boolean(ticket.projectId);
  }

  return {
    enabled,
    issue,
    revoke,
    authorize,
    size: () => tickets.size,
  };
}

module.exports = { createPreviewTicketStore };
