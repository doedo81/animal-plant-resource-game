'use strict';
/**
 * 역할 레지스트리
 *
 * 프롬프트의 단일 진실 원천은 prompts/ 디렉터리의 마크다운이다.
 * 코드가 프롬프트를 문자열로 들고 있지 않기 때문에, 프롬프트만 고쳐도 조직이 바뀐다.
 */
const fs = require('fs');
const path = require('path');
const { readText } = require('./util');

const PROMPT_DIR = path.join(__dirname, '..', 'prompts');

/** 아주 단순한 frontmatter 파서 (key: value 만 지원) */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
    else if (val === 'true' || val === 'false') val = val === 'true';
    else if (val.includes(',')) val = val.split(',').map((s) => s.trim()).filter(Boolean);
    meta[key] = val;
  }
  return { meta, body: m[2] };
}

function loadRoleFile(file) {
  const { meta, body } = parseFrontmatter(readText(file));
  if (!meta.code) throw new Error(`역할 파일에 code 가 없습니다: ${file}`);
  return {
    code: meta.code,
    team: meta.team || 'PM',
    output: meta.output || 'prose',
    temperature: meta.temperature ?? 0.8,
    maxTokens: meta.maxTokens ?? 4000,
    required: meta.required ? (Array.isArray(meta.required) ? meta.required : [meta.required]) : [],
    receiver: meta.receiver || 'PM',
    prompt: body.trim(),
    file,
  };
}

function loadRoles() {
  const registry = {};
  const pm = loadRoleFile(path.join(PROMPT_DIR, 'pm.md'));
  registry[pm.code] = pm;

  const roleDir = path.join(PROMPT_DIR, 'roles');
  for (const f of fs.readdirSync(roleDir).filter((f) => f.endsWith('.md'))) {
    const role = loadRoleFile(path.join(roleDir, f));
    registry[role.code] = role;
  }
  return registry;
}

function loadGenres() {
  const dir = path.join(PROMPT_DIR, 'genres');
  const out = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const { meta, body } = parseFrontmatter(readText(path.join(dir, f)));
    const key = meta.preset || path.basename(f, '.md');
    out[key] = {
      preset: key,
      label: meta.label || key,
      chapters: meta.chapters || 3,
      targetChars: meta.targetChars || 3000,
      passScore: meta.passScore || 82,
      studio: meta.studio || 'STUDIO_LEAD', // 이 장르를 총괄하는 스튜디오 팀장 코드
      prompt: body.trim(),
    };
  }
  return out;
}

const COMMON = () => readText(path.join(PROMPT_DIR, 'common.md')).trim();

/** 조직도: 팀장 ← 팀원 */
const ORG = {
  PM: ['LEAD_RESEARCH', 'LEAD_STORY', 'LEAD_WRITING', 'LEAD_QA'],
  LEAD_RESEARCH: ['RESEARCHER'],
  LEAD_STORY: ['WORLDBUILDER', 'CHARACTER_DESIGNER', 'SYNOPSIS_WRITER', 'OUTLINER'],
  LEAD_WRITING: ['WRITER_1', 'WRITER_2', 'EDITOR'],
  LEAD_QA: ['REVIEWER', 'CRITIC', 'CONTINUITY_KEEPER'],
};

function leaderOf(roleCode, registry) {
  return registry[roleCode]?.team || 'PM';
}

module.exports = { loadRoles, loadGenres, COMMON, ORG, leaderOf, parseFrontmatter, PROMPT_DIR };
