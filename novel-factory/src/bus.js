'use strict';
/**
 * 핸드오프 버스 (Handoff Bus)
 *
 * 설계 원칙
 *  1) append-only 원장(events.jsonl) — 모든 사건은 삭제되지 않는다. 감사/재생(replay) 가능.
 *  2) 수신자별 큐(queue/<RECEIVER>/) — 릴레이 방식 전달. ack 되면 done/ 으로 이동.
 *  3) 규격 위반 메시지는 실리지 않는다(reject). 재시도 초과분은 dlq/(dead letter)로 격리.
 *  4) 파일 기반이라 프로세스가 죽어도 상태가 남는다 → 컨텍스트 리셋 후 재개의 근거가 된다.
 */
const fs = require('fs');
const path = require('path');
const { ensureDir, writeJson, readJson, appendText, nowIso, newId, pad } = require('./util');
const { validateHandoff, makeHandoff } = require('./schema');

class Bus {
  constructor(root, { maxAttempts = 3, logger = null } = {}) {
    this.root = root;
    this.maxAttempts = maxAttempts;
    this.logger = logger;
    this.ledger = path.join(root, 'events.jsonl');
    this.queueDir = path.join(root, 'queue');
    this.doneDir = path.join(root, 'done');
    this.dlqDir = path.join(root, 'dlq');
    this.rejectDir = path.join(root, 'rejected');
    this.seqFile = path.join(root, '.seq');
    [this.queueDir, this.doneDir, this.dlqDir, this.rejectDir].forEach(ensureDir);
  }

  _nextSeq() {
    const cur = parseInt(fs.existsSync(this.seqFile) ? fs.readFileSync(this.seqFile, 'utf8') : '0', 10) || 0;
    const next = cur + 1;
    fs.writeFileSync(this.seqFile, String(next), 'utf8');
    return next;
  }

  /**
   * 메시지를 버스에 싣는다.
   * @returns {{ok:boolean, event?:object, errors?:string[]}}
   */
  publish(raw) {
    const check = validateHandoff(raw);
    if (!check.ok) {
      const rej = { ts: nowIso(), errors: check.errors, raw };
      writeJson(path.join(this.rejectDir, `${newId('rej')}.json`), rej);
      appendText(this.ledger, JSON.stringify({ type: 'REJECT', ts: nowIso(), errors: check.errors }) + '\n');
      this.logger?.warn('버스 반려: 핸드오프 규격 위반', { errors: check.errors });
      return { ok: false, errors: check.errors };
    }

    const body = check.value;
    const seq = this._nextSeq();
    const envelope = {
      seq,
      event_id: body.event_id || newId('evt'),
      ts: body.ts || nowIso(),
      attempt: body.attempt || 1,
      ...body,
    };

    appendText(this.ledger, JSON.stringify({ type: 'PUBLISH', ...envelope }) + '\n');

    const qdir = ensureDir(path.join(this.queueDir, envelope.receiver));
    writeJson(path.join(qdir, `${pad(seq, 6)}-${envelope.event_id}.json`), { HANDOFF_EVENT: envelope });

    this.logger?.info(`BUS ▸ ${envelope.sender} → ${envelope.receiver} [${envelope.status}] ${envelope.summary.slice(0, 70)}`);
    return { ok: true, event: envelope };
  }

  /** 규격에 맞는 봉투를 만들어 바로 발행 */
  emit(fields) {
    return this.publish(makeHandoff(fields));
  }

  /** 수신자 큐에서 가장 오래된 메시지 하나를 꺼낸다(비파괴 — ack 전까지 큐에 남음). */
  peek(receiver) {
    const qdir = path.join(this.queueDir, receiver);
    if (!fs.existsSync(qdir)) return null;
    const files = fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) return null;
    const file = path.join(qdir, files[0]);
    const data = readJson(file);
    return data ? { file, event: data.HANDOFF_EVENT } : null;
  }

  /** 수신자 큐 전체 조회 */
  pending(receiver) {
    const qdir = path.join(this.queueDir, receiver);
    if (!fs.existsSync(qdir)) return [];
    return fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).sort()
      .map((f) => readJson(path.join(qdir, f))?.HANDOFF_EVENT)
      .filter(Boolean);
  }

  /** 처리 완료 → done 으로 이동 */
  ack(file, result = {}) {
    if (!fs.existsSync(file)) return false;
    const data = readJson(file);
    ensureDir(this.doneDir);
    fs.renameSync(file, path.join(this.doneDir, path.basename(file)));
    appendText(this.ledger, JSON.stringify({
      type: 'ACK', ts: nowIso(), event_id: data?.HANDOFF_EVENT?.event_id, result,
    }) + '\n');
    return true;
  }

  /** 처리 실패 → 재시도 또는 DLQ 격리 */
  nack(file, error) {
    const data = readJson(file);
    if (!data) return false;
    const ev = data.HANDOFF_EVENT;
    ev.attempt = (ev.attempt || 1) + 1;
    appendText(this.ledger, JSON.stringify({
      type: 'NACK', ts: nowIso(), event_id: ev.event_id, attempt: ev.attempt, error: String(error),
    }) + '\n');

    if (ev.attempt > this.maxAttempts) {
      fs.renameSync(file, path.join(ensureDir(this.dlqDir), path.basename(file)));
      this.logger?.error(`BUS ▸ DLQ 격리 (재시도 ${this.maxAttempts}회 초과)`, { event_id: ev.event_id });
      return 'DLQ';
    }
    writeJson(file, { HANDOFF_EVENT: ev });
    return 'RETRY';
  }

  /**
   * 수신자가 대기 메시지를 모두 처리했음을 확정한다.
   * 실행기가 실제로 그 역할을 수행한 직후 호출되며, 이후 queue/ 에 남은 것은
   * "아직 아무도 처리하지 않은 진짜 미결 업무"만을 뜻하게 된다.
   */
  drain(receiver, note = 'processed') {
    const qdir = path.join(this.queueDir, receiver);
    if (!fs.existsSync(qdir)) return 0;
    const files = fs.readdirSync(qdir).filter((f) => f.endsWith('.json')).sort();
    for (const f of files) this.ack(path.join(qdir, f), { note });
    return files.length;
  }

  /** 원장 최근 n건 */
  tail(n = 30) {
    if (!fs.existsSync(this.ledger)) return [];
    const lines = fs.readFileSync(this.ledger, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  /** 특정 프로젝트(trace_id)의 전체 흐름 재구성 */
  trace(traceId) {
    if (!fs.existsSync(this.ledger)) return [];
    return fs.readFileSync(this.ledger, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((e) => e && e.trace_id === traceId);
  }

  stats() {
    const events = this.tail(Number.MAX_SAFE_INTEGER);
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    const dlq = fs.existsSync(this.dlqDir) ? fs.readdirSync(this.dlqDir).length : 0;
    const rejected = fs.existsSync(this.rejectDir) ? fs.readdirSync(this.rejectDir).length : 0;
    return { total: events.length, byType, dlq, rejected };
  }
}

module.exports = { Bus };
