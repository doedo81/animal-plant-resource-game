'use strict';
/**
 * 컨텍스트 감시 · 캐싱 · 리셋 · 재개 (Context Reset Loop)
 *
 * 긴 작업에서 세션이 터지는 것을 막는 핵심 장치.
 *   50%  → WARN  : 요약본 선제 저장
 *   80%  → CACHE : 상태를 latest_summary.json 으로 확정 저장하고 리셋 신호 발행
 *   92%  → RESET : 즉시 세션 폐기 (새 세션이 스냅샷을 읽고 이어받는다)
 *
 * 재개의 단위는 "대화"가 아니라 "체크포인트"다.
 * 실제 원고/캐논은 파일로 남아 있으므로, 새 세션은 요약본 + 파일만 있으면 100% 복원된다.
 */
const path = require('path');
const { readJson, writeJson, nowIso, estimateTokens } = require('./util');

const LEVEL = { OK: 'OK', WARN: 'WARN', CACHE: 'CACHE', RESET: 'RESET' };

class ContextManager {
  constructor({ cfg, projectDir, sessionStateRoot, logger, projectId }) {
    this.cfg = cfg;
    this.logger = logger;
    this.projectId = projectId;
    this.stateFile = path.join(projectDir, 'session_state', 'latest_summary.json');
    // 규격 호환: 루트 ./session_state/latest_summary.json 에도 최신 포인터를 남긴다.
    this.globalStateFile = path.join(sessionStateRoot, 'latest_summary.json');
    this.used = 0;
    this.sessionSeq = 1;
    this.resets = 0;
  }

  get window() { return this.cfg.windowTokens; }
  get ratio() { return this.used / this.window; }

  /** 호출 1건의 토큰을 누적 */
  add(tokens) {
    this.used += (tokens?.in || 0) + (tokens?.out || 0);
    return this.level();
  }

  addText(text) {
    return this.add({ in: estimateTokens(text), out: 0 });
  }

  level() {
    const r = this.ratio;
    if (r >= this.cfg.hardResetRatio) return LEVEL.RESET;
    if (r >= this.cfg.cacheRatio) return LEVEL.CACHE;
    if (r >= this.cfg.warnRatio) return LEVEL.WARN;
    return LEVEL.OK;
  }

  /**
   * 체크포인트 저장. 세션을 비우기 전 반드시 호출된다.
   * @param {object} state {stage, completed[], remaining[], canonPaths, chapters, lastHandoff}
   */
  snapshot(state) {
    const doc = {
      schema_version: '1.0',
      saved_at: nowIso(),
      project_id: this.projectId,
      session_seq: this.sessionSeq,
      context: {
        used_tokens: this.used,
        window_tokens: this.window,
        ratio: Number(this.ratio.toFixed(3)),
        level: this.level(),
        resets_so_far: this.resets,
      },
      ...state,
    };
    writeJson(this.stateFile, doc);
    writeJson(this.globalStateFile, doc);
    this.logger?.debug(`체크포인트 저장 (ratio=${(this.ratio * 100).toFixed(1)}%)`, { file: this.stateFile });
    return doc;
  }

  /** 저장된 체크포인트 로드 */
  load() {
    return readJson(this.stateFile, null);
  }

  /**
   * 세션 리셋. 대화 컨텍스트를 0으로 되돌린다.
   * 파일 산출물은 그대로 남으므로 손실은 "대화 기억"뿐이다.
   */
  reset(reason = 'threshold') {
    this.resets += 1;
    this.sessionSeq += 1;
    const before = this.used;
    this.used = 0;
    this.logger?.warn(`컨텍스트 리셋 실행 (#${this.resets}, 사유=${reason}, 회수=${before} 토큰) → 세션 ${this.sessionSeq} 로 재개`);
    return { session_seq: this.sessionSeq, freed: before };
  }

  /**
   * 스테이지 경계마다 호출. 필요하면 스냅샷 저장 + 리셋까지 자동 수행.
   * @returns {{level:string, reset:boolean}}
   */
  checkpoint(stateProvider) {
    const lvl = this.level();
    if (lvl === LEVEL.OK) return { level: lvl, reset: false };

    const state = typeof stateProvider === 'function' ? stateProvider() : (stateProvider || {});
    this.snapshot({ ...state, checkpoint_reason: lvl });

    if (lvl === LEVEL.CACHE || lvl === LEVEL.RESET) {
      this.reset(lvl);
      return { level: lvl, reset: true };
    }
    this.logger?.warn(`컨텍스트 ${(this.ratio * 100).toFixed(0)}% 도달 — 선제 스냅샷 저장`);
    return { level: lvl, reset: false };
  }

  /**
   * 새 세션에 주입할 최소 부트 컨텍스트.
   * 전체 대화가 아니라 "지금 필요한 것"만 담는다 — 이것이 무한 굴레를 끊는 핵심.
   */
  bootContext() {
    const s = this.load();
    if (!s) return '';
    return [
      '### 세션 복원 컨텍스트 (이전 세션 요약)',
      `- 프로젝트: ${s.project_id} / 세션 #${s.session_seq}`,
      `- 현재 단계: ${s.stage || '-'}`,
      `- 완료: ${(s.completed || []).join(', ') || '-'}`,
      `- 남은 작업: ${(s.remaining || []).join(', ') || '-'}`,
      `- 캐논 파일: ${(s.canon_paths || []).join(', ') || '-'}`,
      s.last_handoff ? `- 마지막 핸드오프: ${s.last_handoff.sender} → ${s.last_handoff.receiver} (${s.last_handoff.status}) ${s.last_handoff.summary}` : '',
      '위 정보와 파일 시스템의 산출물만으로 중단점부터 재개하라. 이전 대화를 복원하려 하지 마라.',
    ].filter(Boolean).join('\n');
  }
}

module.exports = { ContextManager, LEVEL };
