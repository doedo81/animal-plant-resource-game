'use strict';
const path = require('path');
const { nowIso, appendText, ensureDir } = require('./util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
  agent: '\x1b[35m', ok: '\x1b[32m', reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
};

class Logger {
  constructor({ level = 'info', file = null, quiet = false } = {}) {
    this.level = LEVELS[level] || LEVELS.info;
    this.file = file;
    this.quiet = quiet;
    if (file) ensureDir(path.dirname(file));
  }

  _emit(level, msg, meta) {
    const line = `[${nowIso()}] [${level.toUpperCase()}] ${msg}` +
      (meta ? ` ${JSON.stringify(meta)}` : '');
    if (this.file) appendText(this.file, line + '\n');
    if (this.quiet || LEVELS[level] < this.level) return;
    const c = COLOR[level] || '';
    process.stdout.write(`${c}${line}${COLOR.reset}\n`);
  }

  debug(m, meta) { this._emit('debug', m, meta); }
  info(m, meta) { this._emit('info', m, meta); }
  warn(m, meta) { this._emit('warn', m, meta); }
  error(m, meta) { this._emit('error', m, meta); }

  /** 파이프라인 진행 상황을 사람이 읽기 좋게 */
  stage(title) {
    if (!this.quiet) {
      process.stdout.write(`\n${COLOR.bold}${COLOR.agent}▶ ${title}${COLOR.reset}\n`);
    }
    if (this.file) appendText(this.file, `[${nowIso()}] [STAGE] ${title}\n`);
  }

  ok(msg) {
    if (!this.quiet) process.stdout.write(`${COLOR.ok}  ✔ ${msg}${COLOR.reset}\n`);
    if (this.file) appendText(this.file, `[${nowIso()}] [OK] ${msg}\n`);
  }
}

module.exports = { Logger, COLOR };
