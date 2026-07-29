'use strict';
/**
 * 공용 유틸리티.
 * 외부 의존성 0 — Node 18+ 표준 모듈만 사용한다.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() {
  return new Date().toISOString();
}

/** 정렬 가능한 짧은 ID (prefix_시간36진수_랜덤) */
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return file;
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function appendText(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text, 'utf8');
  return file;
}

/**
 * 토큰 수 추정. 한글은 토크나이저에서 영문보다 비싸므로 가중치를 다르게 준다.
 * 정확한 과금용이 아니라 컨텍스트 감시(50%/80%)용 근사치다.
 */
function estimateTokens(input) {
  if (!input) return 0;
  const str = typeof input === 'string' ? input : JSON.stringify(input);
  const hangul = (str.match(/[가-힣㄰-㆏]/g) || []).length;
  const cjk = (str.match(/[一-鿿぀-ヿ]/g) || []).length;
  const rest = Math.max(0, str.length - hangul - cjk);
  return Math.ceil(hangul / 1.4 + cjk / 1.2 + rest / 3.6);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

function truncate(str, max) {
  if (!str) return '';
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max) + `\n…(${s.length - max}자 생략)`;
}

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (typeof base !== 'object' || base === null) {
    return override === undefined ? base : override;
  }
  if (typeof override !== 'object' || override === null) {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

/**
 * 모델 응답에서 JSON 블록을 최대한 관대하게 추출한다.
 * ```json 펜스, 앞뒤 잡담, 단일 객체/배열을 모두 처리.
 */
function extractJson(text) {
  if (!text) return null;
  const raw = String(text).trim();

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  const fence = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    const parsed = tryParse(fence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // 균형 잡힌 첫 번째 { … } 또는 [ … ] 스캔
  for (const [open, close] of [['{', '}'], ['[', ']']]) {
    const start = raw.indexOf(open);
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          const parsed = tryParse(raw.slice(start, i + 1));
          if (parsed !== undefined) return parsed;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** 한국어 기준 대략적 원고 분량(공백 제외 글자수) */
function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

module.exports = {
  nowIso, newId, ensureDir,
  readJson, writeJson, readText, writeText, appendText,
  estimateTokens, sleep, pad, truncate, deepMerge,
  extractJson, countChars,
};
