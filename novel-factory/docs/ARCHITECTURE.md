# 1. 시스템 아키텍처 및 작동 순서도

## 1.1 조직 구조

```mermaid
graph TD
    H[HUMAN<br/>아이디어 한 줄] --> PM

    PM[PM 에이전트<br/>목표 분석 · 배분 · 최종 승인]

    PM --> LR[LEAD_RESEARCH<br/>리서치 팀장]
    PM --> LS[LEAD_STORY<br/>스토리 팀장]
    PM --> LW[LEAD_WRITING<br/>집필 팀장]
    PM --> LQ[LEAD_QA<br/>품질 팀장]

    LR --> R[RESEARCHER<br/>고증·자료]
    LS --> W[WORLDBUILDER<br/>세계관]
    LS --> C[CHARACTER_DESIGNER<br/>인물]
    LS --> S[SYNOPSIS_WRITER<br/>시놉시스]
    LS --> O[OUTLINER<br/>회차 구성]
    LW --> W1[WRITER_1<br/>초고]
    LW --> W2[WRITER_2<br/>개고]
    LW --> E[EDITOR<br/>윤문]
    LQ --> RV[REVIEWER<br/>체크리스트 검토]
    LQ --> CR[CRITIC<br/>정량 비평]
    LQ --> CK[CONTINUITY_KEEPER<br/>연속성]

    PM -.최종 납품.-> H
```

| 계층 | 역할 | 모델 호출 | 판단 근거 |
|---|---|---|---|
| **PM** | 요구사항 → 작업 명세 번역, 배분, 최종 승인/반려 | O (승인 시 1회) | 수용 기준 표 |
| **팀장 (LEAD_\*)** | 과제 분할 배정, **수용 기준 게이트 검사**, 상급 보고 | **X (결정론적 코드)** | `_gate()` 규칙 |
| **팀원 (WORKER)** | 격리 환경에서 단일 산출물 생산 후 즉시 보고 | O | 역할 프롬프트 |

> **왜 팀장은 모델을 안 쓰는가**
> 팀장의 실제 업무는 "이 산출물이 다음 단계로 갈 자격이 있는가"를 판정하는 것이다.
> `마법 체계에 비용/한계가 있는가`, `인물에 목표·결함이 채워졌는가`, `본문이 요약본이 아닌가` 같은
> 판정은 규칙으로 쓸 수 있고, 규칙은 모델보다 **정확하고 재현 가능하며 공짜다.**
> 모델은 창작(팀원)과 최종 판단(PM)에만 쓴다.

## 1.2 전체 작동 순서도

```mermaid
flowchart TD
    A[아이디어 접수] --> B[PM: 작업 명세 번역<br/>장르·회차·분량·통과선 자동 결정]
    B --> C[1 리서치<br/>시대·기술·경제 → 창작 제약]
    C --> D[2 세계관<br/>비용과 한계가 있는 체계]
    D --> E[3 인물<br/>목표·결함·비밀·화술]
    E --> F[4 시놉시스<br/>로그라인 + 3막 + 잃는 것]
    F --> G[5 회차 구성<br/>비트·리빌·클리프행어]
    G --> H{회차 루프}

    H --> I[작가1: 초고]
    I --> J[검토: 체크리스트]
    J --> K[비평: 6축 정량 채점]
    K --> L{총점 ≥ 통과선?}
    L -- No --> M{개고 한도 / 개선폭 확인}
    M -- 여유 있음 --> N[작가2: 개고] --> J
    M -- 한도 초과 or 점수 정체 --> X[NEEDS_HUMAN 에스컬레이션]
    X --> O
    L -- Yes --> O[연속성 점검<br/>캐논 갱신·복선 추적]
    O --> P[윤문]
    P --> Q{남은 회차?}
    Q -- Yes --> H
    Q -- No --> R[MANUSCRIPT.md 조립]
    R --> S[PM 최종 승인]
    S --> T[사용자 납품]

    style X fill:#5a2d2d,color:#fff
    style T fill:#2d5a3d,color:#fff
```

**각 화살표는 전부 버스를 지난다.** 에이전트끼리 직접 말을 거는 경로는 존재하지 않는다.

## 1.3 한 스텝을 확대하면

```mermaid
sequenceDiagram
    participant PM
    participant L as 팀장
    participant BUS as 버스
    participant W as 팀원
    participant G as 안전게이트
    participant CTX as 컨텍스트 감시

    PM->>BUS: HANDOFF (PM → 팀장, 과제 배분)
    BUS->>L: 큐 적재
    L->>BUS: HANDOFF (팀장 → 팀원, 세부 지시)
    BUS->>W: 큐 적재
    Note over W: 시스템프롬프트 =<br/>공통규칙 + 역할 + 장르팩 + 캐논
    W->>W: 산출물 생성
    W-->>W: 출력 계약 위반 시 자가 교정 (최대 2회)
    W->>G: 산출물 저장 요청
    G->>G: 경로 검증 → 백업 → 비밀값 마스킹
    G-->>W: 저장 완료 (샌드박스 경로)
    W->>BUS: HANDOFF (팀원 → 팀장, 완료 보고)
    BUS->>BUS: 봉투 규격 검증 (위반 시 폐기·반려)
    BUS->>L: 큐 적재
    L->>L: 수용 기준 게이트 검사
    alt 게이트 탈락
        L->>BUS: HANDOFF (status=ERROR, 반려 사유)
        BUS->>W: 재작업 지시 (1회)
    end
    L->>BUS: HANDOFF (팀장 → PM, 검수 완료)
    BUS->>PM: 큐 적재
    PM->>CTX: 체크포인트 확인
    alt 컨텍스트 ≥ 80%
        CTX->>CTX: latest_summary.json 저장 → 세션 리셋
    end
```

## 1.4 모듈 지도

```
novel-factory/
├── src/
│   ├── cli.js          진입점 — run / resume / status / bus / presets / doctor
│   ├── pm.js           오케스트레이터. 파이프라인·회차 루프·팀장 게이트·에스컬레이션
│   ├── agent.js        에이전트 실행기. 프롬프트 조립·출력 계약 강제·핸드오프 감독
│   ├── bus.js          핸드오프 버스. 원장 / 수신자 큐 / ack·nack / DLQ
│   ├── schema.js       HANDOFF_EVENT 규격 정의 및 검증기
│   ├── guard.js        샌드박스. 경로 격리 · 백업 · 비밀값 마스킹 · 금지 명령
│   ├── context.js      컨텍스트 감시(50/80/92%) · 캐싱 · 리셋 · 재개
│   ├── llm.js          프로바이더 어댑터(openai/anthropic/mock) + 재시도 + 예산
│   ├── roles.js        역할·장르 레지스트리 (prompts/ 를 단일 진실 원천으로 로드)
│   ├── mock-writer.js  오프라인 결정론적 더미 작가
│   ├── logger.js       구조화 로그
│   └── util.js         JSON 관대 파서, 한글 가중 토큰 추정 등
├── prompts/            ← 프롬프트의 단일 진실 원천. 여기만 고쳐도 조직이 바뀐다
│   ├── pm.md           PM 시스템 프롬프트
│   ├── common.md       팀장/팀원 공통 (안전 + 핸드오프 규칙)
│   ├── roles/*.md      역할별 프롬프트 11종
│   └── genres/*.md     작가 유형 팩 3종
├── config/default.json 통과선·개고 한도·컨텍스트 임계치·deny list·예산
└── test/smoke.test.js  21건 자체 검증
```

## 1.5 데이터 흐름의 원칙

**대화는 휘발되지만 파일은 남는다.**

에이전트 사이를 오가는 것은 원고 본문이 아니라 **경로**다(`data_payload_path`).
본문은 항상 샌드박스 파일로 존재하고, 봉투는 주소표 역할만 한다. 그래서:

- 세션이 죽어도 산출물이 살아남는다 → 재개가 가능하다
- 봉투가 작아서 버스가 가볍다 → 원장 전체를 메모리에 올려 감사할 수 있다
- 어느 단계 산출물이든 사람이 직접 열어보고 고칠 수 있다 → 부분 개입이 가능하다
