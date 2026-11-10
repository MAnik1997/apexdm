const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clamp } = require('../shared/files');

const DEFAULT_SETTINGS = {
  downloadDir: '',
  maxActive: 3,
  connections: 8,
  minSegmentBytes: 1024 * 1024,
  dynamicSplit: true,
  speedLimitBps: 0,
  resumeOnLaunch: true,
  clipboardWatch: true,
  clipboardFilesOnly: true,
  clipboardConfirm: true,
  confirmCapture: true,
  captureTimeoutSec: 90,
  captureTimeoutAction: 'browser',
  notify: true,
  sound: true,
  scanPrograms: false,
  port: 17633,
  token: '',
  schedule: {
    enabled: false,
    start: '01:00',
    end: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
  },
};

function normalizeSettings(input) {
  const source = input || {};
  const schedule = { ...DEFAULT_SETTINGS.schedule, ...(source.schedule || {}) };
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    downloadDir: source.downloadDir || '',
    maxActive: clamp(source.maxActive ?? DEFAULT_SETTINGS.maxActive, 1, 8),
    connections: clamp(source.connections ?? DEFAULT_SETTINGS.connections, 1, 32),
    minSegmentBytes: clamp(source.minSegmentBytes ?? DEFAULT_SETTINGS.minSegmentBytes, 256 * 1024, 32 * 1024 * 1024),
    speedLimitBps: Math.max(0, Number(source.speedLimitBps) || 0),
    captureTimeoutSec: clamp(source.captureTimeoutSec ?? 90, 15, 600),
    captureTimeoutAction: source.captureTimeoutAction === 'download' ? 'download' : 'browser',
    port: clamp(source.port || DEFAULT_SETTINGS.port, 1024, 65535),
    token: source.token || '',
    schedule: {
      ...schedule,
      days: Array.isArray(schedule.days) ? schedule.days.map(Number).filter((day) => day >= 0 && day <= 6) : [0, 1, 2, 3, 4, 5, 6],
    },
  };
}

class Library {
  constructor(file) {
    this.file = file;
    this.settings = normalizeSettings();
    this.items = [];
  }

  load(overrides = {}) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      data = {};
    }
    this.settings = normalizeSettings(data.settings);
    if (!this.settings.downloadDir && overrides.downloadDir) this.settings.downloadDir = overrides.downloadDir;
    if (!this.settings.token) this.settings.token = crypto.randomBytes(18).toString('hex');
    this.items = Array.isArray(data.items) ? data.items.filter((item) => item && item.id && item.url && item.finalPath) : [];
    for (const item of this.items) {
      item.speed = 0;
      item.segments = Array.isArray(item.segments) ? item.segments : [];
      item.priority = item.priority || 0;
      if (item.status === 'downloading') {
        item.status = this.settings.resumeOnLaunch === false ? 'paused' : 'queued';
        if (item.status === 'paused') item.pausedByUser = true;
      } else if (item.status === 'awaiting') {
        item.status = 'cancelled';
      }
    }
    this.save();
  }

  save() {
    const data = JSON.stringify({ settings: this.settings, items: this.items });
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data);
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      fs.copyFileSync(tmp, this.file);
      fs.rmSync(tmp, { force: true });
    }
  }
}

module.exports = { Library, DEFAULT_SETTINGS, normalizeSettings };
