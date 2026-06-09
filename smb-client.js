'use strict';

const SMB2 = require('@marsaud/smb2');
const fs   = require('fs');
const path = require('path');

// ── SMB Client ──────────────────────────────────────────────────────────────

class SmbClient {
  constructor(config) {
    this.config = config;
    this._client = null;
  }

  _connect() {
    if (this._client) return;
    this._client = new SMB2({
      share:           `\\\\${this.config.host}\\${this.config.share}`,
      domain:          this.config.domain   || 'WORKGROUP',
      username:        this.config.username || 'guest',
      password:        this.config.password || '',
      autoCloseTimeout: 10000,
    });
  }

  async listDir(smbPath) {
    this._connect();
    const winPath = smbPath.replace(/\//g, '\\');
    const entries = await this._client.readdir(winPath || '\\');
    return entries;
  }

  async readFile(smbPath) {
    this._connect();
    const winPath = smbPath.replace(/\//g, '\\');
    return await this._client.readFile(winPath);
  }

  async exists(smbPath) {
    try {
      this._connect();
      await this._client.readdir(smbPath);
      return true;
    } catch {
      try {
        await this._client.readFile(smbPath);
        return true;
      } catch {
        return false;
      }
    }
  }

  disconnect() {
    if (this._client) {
      this._client.disconnect();
      this._client = null;
    }
  }

  get type() { return 'smb'; }
}

// ── Local Client ─────────────────────────────────────────────────────────────

class LocalClient {
  constructor(config) {
    this.root = config.path;
  }

  async listDir(relPath) {
    const fullPath = path.join(this.root, relPath);
    return fs.promises.readdir(fullPath);
  }

  async readFile(relPath) {
    const fullPath = path.join(this.root, relPath);
    return fs.promises.readFile(fullPath);
  }

  async exists(relPath) {
    try {
      await fs.promises.access(path.join(this.root, relPath));
      return true;
    } catch {
      return false;
    }
  }

  disconnect() {}

  get type() { return 'local'; }
}

// ── Factory ───────────────────────────────────────────────────────────────────

function createClient(libConfig) {
  if (!libConfig || !libConfig.type) return null;
  if (libConfig.type === 'smb')   return new SmbClient(libConfig);
  if (libConfig.type === 'local') return new LocalClient(libConfig);
  throw new Error(`Unknown library type: ${libConfig.type}`);
}

module.exports = { createClient };
