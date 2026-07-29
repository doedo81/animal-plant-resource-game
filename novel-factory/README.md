# 소설 공장 (Novel Factory)

한 줄 아이디어를 넣으면 **PM → 팀장 → 팀원** 조직이 릴레이로 작품을 만들어 납품하는 다중 에이전트 시스템.

```
아이디어 한 줄  →  리서치 → 세계관 → 인물 → 시놉시스 → 회차구성
                 → [작가1 초고 → 검토 → 비평 → 작가2 개고] × 회차 반복
                 → 연속성 점검 → 윤문 → PM 승인 → 원고 납품
```

사람이 하는 일은 **아이디어를 주는 것**과 **완성본을 받는 것** 둘뿐이다.
그 사이의 모든 지시·보고·반려는 버스(Bus)를 통한 핸드오프 봉투로만 오간다.

---

## 빠른 시작

```bash
cd novel-factory
node src/cli.js doctor                       # 환경 점검
node test/smoke.test.js                      # 21건 자체 검증

# API 키 없이 전 구간 돌려보기 (mock 작가)
node src/cli.js run --idea "기억을 파는 대가로 마력을 얻는 소년" --chapters 2

# 실제 집필
export OPENAI_API_KEY=sk-...
node src/cli.js run \
  --idea "기억을 파는 대가로 마력을 얻는 소년" \
  --preset webnovel --chapters 5 --provider openai --model gpt-4o
```

결과물은 `workspace/<projectId>/` 아래에 쌓인다.

| 경로 | 내용 |
|---|---|
| `MANUSCRIPT.md` | **최종 납품 원고** |
| `canon/` | 리서치·세계관·인물·시놉시스·아웃라인·연속성 장부 |
| `chapters/` | 회차별 초고 / 검토 / 비평 / 개고 / 최종고 전 이력 |
| `bus/events.jsonl` | 모든 핸드오프의 append-only 원장 |
| `reports/` | PM 최종 보고서, 실행 요약 |
| `session_state/latest_summary.json` | 컨텍스트 리셋 후 재개용 체크포인트 |

## 명령어

```bash
node src/cli.js run --idea "..." [--preset webnovel|romance|epic] [--chapters n]
                    [--chars n] [--pass n] [--provider openai|anthropic|mock]
                    [--model id] [--notes "수위/톤/금기"] [--no-research]
node src/cli.js resume <projectId>    # 중단점에서 재개 (완료 단계는 건너뜀)
node src/cli.js status <projectId>    # 진행 상황·회차 점수·컨텍스트 사용률
node src/cli.js bus    <projectId>    # 에이전트 간 대화 흐름을 눈으로 확인
node src/cli.js presets               # 작가 유형 목록
```

## 작가 유형 (프리셋)

| 프리셋 | 성격 | 기본값 |
|---|---|---|
| `webnovel` | 연재형 웹소설. 회차 클리프행어, 고구마 금지, 짧은 문단 | 5화 / 3,000자 / 통과선 80 |
| `romance` | 감정선이 곧 플롯. 오해 갈등 금지, 양쪽 시점 | 5화 / 3,500자 / 통과선 82 |
| `epic` | 장편 문예 판타지. 밀도와 여운, 상징 변주 | 4장 / 6,000자 / 통과선 85 |

**새 작가 유형 추가는 파일 하나면 된다.** `prompts/genres/<이름>.md` 를 만들고 frontmatter에
`preset / label / chapters / targetChars / passScore` 를 적으면 즉시 `--preset <이름>` 으로 잡힌다.
코드는 건드리지 않는다. (예: 무협, 미스터리, 라이트노벨, SF)

## 문서

| 문서 | 내용 |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | **프로젝트 계획서** — 목표, 범위, 단계별 로드맵, 비용, 리스크 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 조직 구조, 작동 순서도, 모듈 지도 |
| [docs/HANDOFF_SPEC.md](docs/HANDOFF_SPEC.md) | 핸드오프 규격 + 버스 프로토콜 + **JSON 메시지 예시** |
| [docs/CONTROL.md](docs/CONTROL.md) | **모델(ChatGPT)을 어떻게 통제·감시하는가** — 7겹 통제 장치 |
| [docs/PROMPTS.md](docs/PROMPTS.md) | PM / 팀장·팀원 공통 / 역할별 시스템 프롬프트 전문 |

## 설계상의 핵심 결정 3가지

1. **팀장은 모델을 쓰지 않는다.** 팀장의 일은 배분·게이트 검사·보고 3가지이고, 이건 결정론적
   코드가 더 정확하고 싸다. 창작과 판단이 필요한 팀원·PM만 모델을 호출한다. (호출 수 ≈ 40% 절감)
2. **캐논을 매 호출에 주입한다.** 장편에서 무너지는 것은 문장력이 아니라 설정 일관성이다.
   `canonSummary()` 가 세계 규칙·인물 목표·확정 사실·미회수 복선을 압축해 모든 팀원에게 넣는다.
3. **개고 루프에 정체 감지기를 단다.** 점수가 오르지 않으면 즉시 멈추고 사람을 부른다.
   "될 때까지 반복"은 자동화가 아니라 토큰 소각이다.

## 요구사항

Node.js 18.17+ (내장 `fetch` 사용). **의존성 패키지 0개.** `npm install` 불필요.
