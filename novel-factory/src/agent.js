'use strict';
/**
 * 에이전트 실행기 (Agent Runner)
 *
 * 한 번의 실행 = 한 명의 팀원이 한 개의 산출물을 만들고 버스에 보고하는 것.
 *
 * 실행기가 하는 감독(supervision) 업무:
 *   1. 시스템 프롬프트 조립: 공통규칙(안전+핸드오프) → 역할 → 장르팩 → 캐논
 *   2. 출력 계약 강제: JSON 스키마 / 산문 형식 검증, 위반 시 자동 교정 요구
 *   3. 핸드오프 봉투 추출·검증. 없거나 규격 위반이면 재요구, 그래도 안 되면
 *      COMPLIANCE 위반으로 기록하고 시스템이 대신 봉투를 만든다(작업은 계속된다).
 *   4. 산출물을 샌드박스 안에 저장하고, 그 경로를 봉투에 실어 버스로 발행
 *   5. 토큰 사용량을 컨텍스트 매니저에 적립
 */
const { handoffContract, validateHandoff, makeHandoff } = require('./schema');
const { COMMON } = require('./roles');
const { extractJson, truncate, countChars, nowIso } = require('./util');

class AgentRunner {
  constructor({ registry, genre, llm, bus, guard, ctx, logger, traceId, canon }) {
    this.registry = registry;
    this.genre = genre;
    this.llm = llm;
    this.bus = bus;
    this.guard = guard;
    this.ctx = ctx;
    this.logger = logger;
    this.traceId = traceId;
    this.canon = canon; // () => string  현재 캐논 요약을 주입하는 함수
    this.common = COMMON();
    this.violations = [];
  }

  _system(role) {
    const parts = [
      this.common,
      '',
      '---',
      '',
      role.prompt,
    ];
    if (this.genre?.prompt && role.code !== 'PM') {
      parts.push('', '---', '', '## 이번 프로젝트의 장르 규약', '', this.genre.prompt);
    }
    parts.push('', '---', '', handoffContract());
    parts.push('', `- 너의 sender 코드는 정확히 \`${role.code}\` 이다.`);
    parts.push(`- 기본 receiver 는 \`${role.receiver}\` 이다.`);
    return parts.join('\n');
  }

  _user(role, { task, inputs = {}, boot = '' }) {
    const blocks = [];
    if (boot) blocks.push(boot, '');
    blocks.push('## 작업 지시', task, '');

    const canon = this.canon ? this.canon() : '';
    if (canon && role.code !== 'RESEARCHER') {
      blocks.push('## 캐논 (위반 금지)', canon, '');
    }
    for (const [k, v] of Object.entries(inputs)) {
      if (v === undefined || v === null || v === '') continue;
      const body = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
      blocks.push(`## 입력: ${k}`, truncate(body, 12000), '');
    }
    if (role.output === 'json') {
      blocks.push('## 출력 형식', '순수 JSON 객체 하나만 출력하라. 설명·코드펜스 금지.',
        role.required.length ? `필수 키: ${role.required.join(', ')}, HANDOFF_EVENT` : '필수 키: HANDOFF_EVENT');
    } else {
      blocks.push('## 출력 형식', '마크다운 본문 전문 + 마지막에 핸드오프 JSON 블록 1개.');
    }
    return blocks.join('\n');
  }

  /**
   * @param {string} roleCode
   * @param {{task:string, inputs?:object, meta?:object, outFile:string, receiver?:string, boot?:string}} opts
   * @returns {Promise<{role:string, data:object|null, text:string, handoff:object, path:string}>}
   */
  async run(roleCode, opts) {
    const role = this.registry[roleCode];
    if (!role) throw new Error(`등록되지 않은 역할: ${roleCode}`);

    const system = this._system(role);
    const user = this._user(role, opts);
    const receiver = opts.receiver || role.receiver;
    const meta = {
      role: roleCode,
      receiver,
      payloadPath: opts.outFile,
      idea: opts.meta?.idea,
      ...opts.meta,
    };

    this.logger?.info(`AGENT ▸ ${roleCode} 실행 (→ ${receiver})`);

    let data = null;
    let text = '';
    let tokens = { in: 0, out: 0 };

    if (role.output === 'json') {
      const req = { system, user, temperature: role.temperature, maxTokens: role.maxTokens, label: roleCode, meta };
      const res = await this.llm.completeStructured(req, [...role.required], 2);
      data = res.data;
      text = res.raw;
      tokens = { in: 0, out: 0 };
    } else {
      const res = await this.llm.complete({
        system, user, temperature: role.temperature, maxTokens: role.maxTokens, label: roleCode, meta,
      });
      text = res.text;
      tokens = res.tokens;
    }
    this.ctx?.add(tokens);

    // ── 핸드오프 봉투 추출 & 감독 ──────────────────────────────
    let handoff = this._extractHandoff(role, data, text);
    let check = validateHandoff(handoff || {});

    if (!check.ok) {
      const repaired = await this._repairHandoff(role, receiver, opts.outFile, check.errors, text);
      handoff = repaired.handoff;
      check = validateHandoff(handoff);
      if (!check.ok) {
        // 시스템이 대신 발행한다. 작업은 멈추지 않되 위반 사실은 남는다.
        this.violations.push({ ts: nowIso(), role: roleCode, errors: check.errors });
        this.logger?.warn(`COMPLIANCE ▸ ${roleCode} 핸드오프 규격 미준수 — 시스템이 대체 발행`, { errors: check.errors });
        handoff = makeHandoff({
          sender: roleCode, receiver,
          status: 'COMPLETE',
          summary: `${roleCode} 산출물 생성 완료 (봉투 자동 보정)`,
          next_action: `${receiver} 는 산출물을 검수하고 다음 단계를 수행하라.`,
          data_payload_path: opts.outFile,
        }).HANDOFF_EVENT;
      }
    }

    // 발신자 위조 방지 — 봉투의 sender 는 실행기가 확정한다.
    handoff.sender = roleCode;
    if (!handoff.receiver || handoff.receiver === roleCode) handoff.receiver = receiver;
    handoff.trace_id = this.traceId;
    handoff.data_payload_path = opts.outFile;
    handoff.metrics = {
      ...(handoff.metrics || {}),
      chars: countChars(role.output === 'json' ? JSON.stringify(data) : text),
      context_ratio: this.ctx ? Number(this.ctx.ratio.toFixed(3)) : null,
    };

    // ── 산출물 저장 (샌드박스) ────────────────────────────────
    let savedPath;
    if (role.output === 'json') {
      const clean = { ...data };
      delete clean.HANDOFF_EVENT;
      savedPath = this.guard.writeJson(opts.outFile, clean);
    } else {
      const body = String(text).replace(/```json\s*\{[\s\S]*?"HANDOFF_EVENT"[\s\S]*?```/g, '').trim();
      savedPath = this.guard.write(opts.outFile, body + '\n');
      text = body;
    }

    // ── 버스 발행 ─────────────────────────────────────────────
    this.bus.publish({ HANDOFF_EVENT: handoff });

    return { role: roleCode, data, text, handoff, path: this.guard.rel(savedPath) };
  }

  _extractHandoff(role, data, text) {
    if (role.output === 'json' && data && data.HANDOFF_EVENT) return data.HANDOFF_EVENT;
    const found = extractJson(String(text).match(/```json[\s\S]*?```/g)?.slice(-1)[0] || '');
    if (found?.HANDOFF_EVENT) return found.HANDOFF_EVENT;
    const anywhere = extractJson(text);
    if (anywhere?.HANDOFF_EVENT) return anywhere.HANDOFF_EVENT;
    return null;
  }

  /** 봉투만 다시 요구하는 경량 교정 호출 (본문 재생성 없음 → 토큰 절약) */
  async _repairHandoff(role, receiver, outFile, errors, text) {
    try {
      const res = await this.llm.complete({
        system: handoffContract(),
        user: [
          '직전 출력의 핸드오프 봉투가 규격을 위반했다.',
          `위반 사유: ${errors.join(' / ')}`,
          `sender 는 "${role.code}", receiver 는 "${receiver}", data_payload_path 는 "${outFile}" 로 고정하라.`,
          '아래 산출물 요약을 참고해 **HANDOFF_EVENT JSON 객체 하나만** 다시 출력하라.',
          '---',
          truncate(text, 2000),
        ].join('\n'),
        temperature: 0.1,
        maxTokens: 700,
        json: true,
        label: `${role.code}:handoff-repair`,
        meta: { role: role.code, receiver, payloadPath: outFile },
      });
      const parsed = extractJson(res.text);
      return { handoff: parsed?.HANDOFF_EVENT || parsed };
    } catch (err) {
      this.logger?.warn(`핸드오프 교정 호출 실패: ${err.message}`);
      return { handoff: null };
    }
  }
}

module.exports = { AgentRunner };
