'use strict';
/**
 * 안전 게이트 (Sandbox Guard)
 *
 * bypass permissions 로 자동 실행하되, "쓸 수 있는 곳"과 "할 수 있는 일"을 좁힌다.
 *  - 모든 파일 쓰기는 workspace 루트 하위로만 허용 (경로 탈출 차단)
 *  - deny 패턴(시스템 경로, .env, .ssh, .git 등)은 읽기/쓰기 모두 차단
 *  - 덮어쓰기/삭제 전 백업 캐시 생성 → 되돌리기 가능
 *  - 모델 출력에 섞인 API 키/개인키는 저장 전 마스킹
 *  - 위험 명령 패턴은 실행 요청 자체를 거부
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, nowIso, writeText, appendText } = require('./util');

class GuardError extends Error {
  constructor(msg, meta) { super(msg); this.name = 'GuardError'; this.meta = meta; }
}

class Guard {
  constructor(workspaceRoot, cfg = {}, logger = null) {
    this.root = path.resolve(workspaceRoot);
    this.cfg = cfg;
    this.logger = logger;
    this.backupDir = path.join(this.root, '.cache', 'backups');
    this.auditLog = path.join(this.root, '.cache', 'guard-audit.log');
    this.denyPath = (cfg.denyPathPatterns || []).map((p) => new RegExp(p));
    this.denyCmd = (cfg.denyCommandPatterns || []).map((p) => new RegExp(p, 'i'));
    this.secrets = (cfg.secretPatterns || []).map((p) => new RegExp(p, 'g'));
    ensureDir(this.root);
  }

  _audit(action, detail) {
    appendText(this.auditLog, `[${nowIso()}] ${action} ${JSON.stringify(detail)}\n`);
  }

  /** 경로를 검증하고 절대경로로 정규화한다. 위반 시 예외. */
  resolveSafe(p) {
    const abs = path.resolve(this.root, p);
    const rel = path.relative(this.root, abs);

    if (!this.cfg.allowWriteOutsideWorkspace && (rel.startsWith('..') || path.isAbsolute(rel))) {
      this._audit('DENY_ESCAPE', { requested: p, resolved: abs });
      throw new GuardError(`샌드박스 밖 경로 접근 차단: ${p}`, { root: this.root, resolved: abs });
    }
    for (const re of this.denyPath) {
      if (re.test(abs)) {
        this._audit('DENY_PATTERN', { requested: p, pattern: re.source });
        throw new GuardError(`금지 경로 패턴에 걸림: ${p} (${re.source})`);
      }
    }
    return abs;
  }

  /** 위험 명령 검사 — 실제 실행은 하지 않고 허용 여부만 판정 */
  assertCommandAllowed(cmd) {
    for (const re of this.denyCmd) {
      if (re.test(cmd)) {
        this._audit('DENY_COMMAND', { cmd, pattern: re.source });
        throw new GuardError(`금지된 명령: ${cmd} (${re.source})`);
      }
    }
    return true;
  }

  /** 비밀값 마스킹 — 원문 훼손 없이 저장물에서만 가린다 */
  redact(text) {
    if (!text) return text;
    let out = String(text);
    let hit = 0;
    for (const re of this.secrets) {
      out = out.replace(re, (m) => { hit++; return `«REDACTED:${m.slice(0, 4)}…»`; });
    }
    if (hit) this._audit('REDACT', { count: hit });
    return out;
  }

  /** 기존 파일이 있으면 타임스탬프 백업을 남긴다 */
  backup(absPath) {
    if (!this.cfg.backupBeforeOverwrite) return null;
    if (!fs.existsSync(absPath)) return null;
    const rel = path.relative(this.root, absPath).replace(/[\\/]/g, '__');
    const stamp = nowIso().replace(/[:.]/g, '-');
    const dest = path.join(ensureDir(path.join(this.backupDir, stamp)), rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(absPath, dest);
    this._audit('BACKUP', { from: absPath, to: dest });
    return dest;
  }

  /** 안전 쓰기: 경로검증 → 백업 → 마스킹 → 크기제한 → 기록 */
  write(relPath, content) {
    const abs = this.resolveSafe(relPath);
    const text = this.redact(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    const bytes = Buffer.byteLength(text, 'utf8');
    const max = this.cfg.maxWriteBytes || 4 * 1024 * 1024;
    if (bytes > max) {
      throw new GuardError(`쓰기 용량 초과: ${bytes} > ${max} bytes (${relPath})`);
    }
    this.backup(abs);
    writeText(abs, text);
    this._audit('WRITE', { path: relPath, bytes });
    return abs;
  }

  writeJson(relPath, obj) {
    return this.write(relPath, JSON.stringify(obj, null, 2) + '\n');
  }

  read(relPath, fallback = '') {
    const abs = this.resolveSafe(relPath);
    try { return fs.readFileSync(abs, 'utf8'); } catch { return fallback; }
  }

  /** 삭제는 반드시 백업 후에만 */
  remove(relPath) {
    const abs = this.resolveSafe(relPath);
    if (!fs.existsSync(abs)) return false;
    this.backup(abs);
    fs.rmSync(abs, { recursive: false, force: true });
    this._audit('DELETE', { path: relPath });
    return true;
  }

  /** 워크스페이스 상대경로로 되돌린다 (핸드오프 payload 경로 표기에 사용) */
  rel(absOrRel) {
    return path.relative(this.root, path.resolve(this.root, absOrRel)).split(path.sep).join('/');
  }
}

module.exports = { Guard, GuardError };
