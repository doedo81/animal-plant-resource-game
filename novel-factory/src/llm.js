'use strict';
/**
 * LLM 어댑터 + 통제 계층 (Control Layer)
 *
 * "ChatGPT 를 어떻게 통제하는가"의 실제 구현부.
 *  1) 출력 계약 강제 — 역할별 스키마(필수 키)를 만족할 때까지 자동 재요청(repair loop)
 *  2) 온도/최대토큰/타임아웃 상한을 역할별로 고정 → 창작 폭주 방지
 *  3) 실패 재시도 + 지수 백오프, 호출/토큰 예산 카운터로 무한 호출 차단
 *  4) 모든 호출을 원장에 남겨 재현 가능(prompt/response 아카이브)
 *
 * provider: openai | anthropic | mock
 *  - mock 은 네트워크 없이 전 파이프라인을 끝까지 돌리기 위한 결정론적 더미 작가다.
 */
const { estimateTokens, sleep, extractJson, newId, nowIso } = require('./util');

class BudgetExceededError extends Error {
  constructor(msg) { super(msg); this.name = 'BudgetExceededError'; }
}
class ContractError extends Error {
  constructor(msg, meta) { super(msg); this.name = 'ContractError'; this.meta = meta; }
}

class LLM {
  constructor(cfg, { logger = null, budget = {}, archive = null } = {}) {
    this.cfg = cfg;
    this.name = cfg.provider;
    this.pcfg = cfg.providers[cfg.provider];
    if (!this.pcfg) throw new Error(`알 수 없는 provider: ${cfg.provider}`);
    this.logger = logger;
    this.archive = archive; // (label, {system,user,output}) => void
    this.budget = {
      maxAgentCalls: budget.maxAgentCalls || 200,
      maxTotalTokens: budget.maxTotalTokens || 2_000_000,
    };
    this.usage = { calls: 0, promptTokens: 0, completionTokens: 0, repairs: 0, retries: 0 };
  }

  get apiKey() {
    return this.pcfg.apiKeyEnv ? process.env[this.pcfg.apiKeyEnv] : null;
  }

  _checkBudget(estimated) {
    if (this.usage.calls >= this.budget.maxAgentCalls) {
      throw new BudgetExceededError(`에이전트 호출 예산 초과 (${this.budget.maxAgentCalls}회)`);
    }
    const total = this.usage.promptTokens + this.usage.completionTokens + estimated;
    if (total > this.budget.maxTotalTokens) {
      throw new BudgetExceededError(`토큰 예산 초과 (${this.budget.maxTotalTokens})`);
    }
  }

  /**
   * 원시 호출 (재시도 포함)
   * @param {{system:string,user:string,temperature?:number,maxTokens?:number,json?:boolean,label?:string}} req
   */
  async complete(req) {
    const est = estimateTokens(req.system) + estimateTokens(req.user);
    this._checkBudget(est);

    const backoff = this.cfg.backoffMs || [2000, 4000, 8000, 16000];
    const maxRetries = this.cfg.maxRetries ?? 3;
    let lastErr;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const started = Date.now();
        const text = await this._dispatch(req);
        const outTokens = estimateTokens(text);
        this.usage.calls += 1;
        this.usage.promptTokens += est;
        this.usage.completionTokens += outTokens;
        this.logger?.debug(`LLM ${this.name}/${this.pcfg.model} ${req.label || ''} ` +
          `in≈${est} out≈${outTokens} ${Date.now() - started}ms`);
        if (this.archive) this.archive(req.label || 'call', { system: req.system, user: req.user, output: text });
        return { text, tokens: { in: est, out: outTokens } };
      } catch (err) {
        lastErr = err;
        if (err instanceof BudgetExceededError) throw err;
        if (attempt === maxRetries) break;
        this.usage.retries += 1;
        const wait = backoff[Math.min(attempt, backoff.length - 1)];
        this.logger?.warn(`LLM 호출 실패 (재시도 ${attempt + 1}/${maxRetries}, ${wait}ms 대기): ${err.message}`);
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  /**
   * 계약 강제 호출: JSON 스키마(필수 키)를 만족할 때까지 최대 repairAttempts 회 자가 수정 요구.
   * @returns {{data:object, raw:string}}
   */
  async completeStructured(req, requiredKeys = [], repairAttempts = 2) {
    let feedback = '';
    for (let i = 0; i <= repairAttempts; i++) {
      const { text } = await this.complete({
        ...req,
        json: true,
        user: feedback ? `${req.user}\n\n### 직전 출력 반려 사유 (반드시 교정)\n${feedback}` : req.user,
        label: `${req.label || 'structured'}${i ? `#repair${i}` : ''}`,
      });
      const data = extractJson(text);
      if (!data) {
        feedback = 'JSON 파싱 실패. 설명·인사말 없이 순수 JSON 객체 하나만 출력하라.';
        this.usage.repairs += 1;
        continue;
      }
      const missing = requiredKeys.filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
      if (missing.length) {
        feedback = `필수 키 누락: ${missing.join(', ')}. 모든 필수 키를 채운 JSON 을 다시 출력하라.`;
        this.usage.repairs += 1;
        continue;
      }
      return { data, raw: text };
    }
    throw new ContractError(`출력 계약 위반 — ${repairAttempts}회 교정 후에도 스키마 불충족`, { requiredKeys, feedback });
  }

  async _dispatch(req) {
    switch (this.name) {
      case 'openai': return this._openai(req);
      case 'anthropic': return this._anthropic(req);
      case 'mock': return this._mock(req);
      default: throw new Error(`미지원 provider: ${this.name}`);
    }
  }

  async _fetchJson(url, options) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs || 180000);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      const body = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        const err = new Error(`HTTP ${res.status}: ${body.slice(0, 400)}`);
        err.retryable = retryable;
        throw err;
      }
      return JSON.parse(body);
    } finally {
      clearTimeout(timer);
    }
  }

  async _openai(req) {
    if (!this.apiKey) throw new Error(`${this.pcfg.apiKeyEnv} 환경변수가 없습니다.`);
    const payload = {
      model: this.pcfg.model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
      temperature: req.temperature ?? 0.8,
      max_tokens: req.maxTokens ?? 4000,
    };
    if (req.json && this.pcfg.jsonMode) payload.response_format = { type: 'json_object' };

    const data = await this._fetchJson(`${this.pcfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI 응답에 본문이 없습니다.');
    return text;
  }

  async _anthropic(req) {
    if (!this.apiKey) throw new Error(`${this.pcfg.apiKeyEnv} 환경변수가 없습니다.`);
    const data = await this._fetchJson(`${this.pcfg.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.pcfg.version || '2023-06-01',
      },
      body: JSON.stringify({
        model: this.pcfg.model,
        system: req.system,
        max_tokens: req.maxTokens ?? 4000,
        temperature: req.temperature ?? 0.8,
        messages: [{ role: 'user', content: req.user }],
      }),
    });
    const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (!text) throw new Error('Anthropic 응답에 본문이 없습니다.');
    return text;
  }

  /** 결정론적 더미 작가 — API 키 없이 전 파이프라인 검증용 */
  async _mock(req) {
    const { mockRespond } = require('./mock-writer');
    await sleep(5);
    return mockRespond(req);
  }
}

module.exports = { LLM, BudgetExceededError, ContractError };
