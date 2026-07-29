'use strict';
/**
 * HANDOFF_EVENT 규격 정의 및 검증기.
 *
 * 에이전트 간에는 자유 대화가 오가지 않는다. 오직 이 봉투(envelope)만 버스를 통과한다.
 * 규격을 어긴 메시지는 버스에 실리지 않고 즉시 반려(REPAIR)된다.
 */

const SCHEMA_VERSION = '1.0';

const STATUS = ['COMPLETE', 'IN_PROGRESS', 'ERROR', 'BLOCKED', 'NEEDS_HUMAN'];

/** 조직도에 등록된 발신/수신 주체만 허용 (오배송·유령 에이전트 방지) */
const ACTORS = [
  'HUMAN',
  'PM',
  'BUS',
  // 팀장
  'LEAD_STORY',      // 스토리 팀장 (세계관/인물/시놉시스/플롯)
  'LEAD_WRITING',    // 집필 팀장 (작가1/작가2/윤문)
  'LEAD_QA',         // 품질 팀장 (검토/비판/연속성)
  'LEAD_RESEARCH',   // 리서치 팀장 (역사/고증/자료)
  // 팀원
  'RESEARCHER',
  'TREND_ANALYST',
  'STYLE_ARCHITECT',
  'WORLDBUILDER',
  'CHARACTER_DESIGNER',
  'SYNOPSIS_WRITER',
  'OUTLINER',
  'WRITER_1',
  'REVIEWER',
  'CRITIC',
  'WRITER_2',
  'CONTINUITY_KEEPER',
  'POLISHER',
  'EDITOR',
];

const REQUIRED = ['sender', 'receiver', 'status', 'summary', 'next_action', 'data_payload_path'];

/**
 * @returns {{ok:boolean, errors:string[], value:object|null}}
 */
function validateHandoff(input) {
  const errors = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['핸드오프 객체가 비어 있거나 객체가 아님'], value: null };
  }

  const body = input.HANDOFF_EVENT ? input.HANDOFF_EVENT : input;

  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === null || body[key] === '') {
      errors.push(`필수 필드 누락: ${key}`);
    }
  }

  if (body.status && !STATUS.includes(body.status)) {
    errors.push(`status 값 불허: ${body.status} (허용: ${STATUS.join('|')})`);
  }
  if (body.sender && !ACTORS.includes(body.sender)) {
    errors.push(`미등록 sender: ${body.sender}`);
  }
  if (body.receiver && !ACTORS.includes(body.receiver)) {
    errors.push(`미등록 receiver: ${body.receiver}`);
  }
  if (body.summary && String(body.summary).length > 2000) {
    errors.push('summary 는 2000자 이하여야 함 (본문이 아니라 요약이다)');
  }
  if (body.data_payload_path && /\.\./.test(String(body.data_payload_path))) {
    errors.push('data_payload_path 에 상위 경로 탈출(..) 금지');
  }

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? body : null };
}

/** 규격에 맞는 봉투를 만든다. 시스템이 직접 발행할 때 사용. */
function makeHandoff(fields) {
  const { newId, nowIso } = require('./util');
  const body = {
    schema_version: SCHEMA_VERSION,
    event_id: fields.event_id || newId('evt'),
    trace_id: fields.trace_id || null,
    ts: fields.ts || nowIso(),
    sender: fields.sender,
    receiver: fields.receiver,
    status: fields.status || 'COMPLETE',
    summary: fields.summary || '',
    next_action: fields.next_action || '',
    data_payload_path: fields.data_payload_path || '',
    attempt: fields.attempt || 1,
    metrics: fields.metrics || {},
    context: fields.context || {},
  };
  return { HANDOFF_EVENT: body };
}

/** 에이전트 프롬프트에 붙일 규격 안내문 */
function handoffContract() {
  return [
    '### 핸드오프 출력 규칙 (절대 준수)',
    '작업을 끝내면 본문 마지막에 아래 JSON 블록을 정확히 한 번 출력한다.',
    '```json',
    JSON.stringify({
      HANDOFF_EVENT: {
        sender: '<본인 역할 코드>',
        receiver: '<수신 역할 코드>',
        status: 'COMPLETE | IN_PROGRESS | ERROR | BLOCKED | NEEDS_HUMAN',
        summary: '<핵심 작업 요약 (2000자 이하)>',
        next_action: '<수신 에이전트가 즉시 수행할 지시>',
        data_payload_path: '<결과물 저장 경로>',
      },
    }, null, 2),
    '```',
    `- sender/receiver 는 다음 코드만 사용: ${ACTORS.join(', ')}`,
    '- 이 블록 밖에서 다른 에이전트에게 말을 걸지 않는다. 모든 전달은 버스를 통한다.',
    '- 규격 위반 시 메시지는 폐기되고 재작성 요구가 돌아온다.',
  ].join('\n');
}

module.exports = { SCHEMA_VERSION, STATUS, ACTORS, REQUIRED, validateHandoff, makeHandoff, handoffContract };
