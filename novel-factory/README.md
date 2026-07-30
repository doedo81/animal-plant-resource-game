# 소설 공장 (Novel Factory)

한 줄 아이디어를 넣으면 **장르 스튜디오 팀장**이 산하 조직을 릴레이로 굴려 작품을 완성하고, 사용자에게는 **결과만 보고**하는 다중 에이전트 시스템.

```
사용자 (아이디어 발주 → 결과 수신)
│
├── 웹소설 팀장 (STUDIO_WEBNOVEL) ─┐
├── 연애소설 팀장 (STUDIO_ROMANCE) ─┤   각 팀장 산하에 동일한 기능 조직:
├── 장편소설 팀장 (STUDIO_EPIC) ────┤   리서치팀 · 스토리팀 · 집필팀 · 품질팀
├── 과학공상 팀장 (STUDIO_SF) ──────┤   (팀원 15종이 실무 수행)
└── 영지경영 팀장 (STUDIO_ESTATE) ──┘
```

여러 작품을 한꺼번에 발주하려면 발주서 파일 하나로 끝난다:

```bash
node src/cli.js batch templates/jobs.example.json
# → 각 스튜디오 팀장이 자기 장르를 제작, 마지막에 종합 보고서(BATCH_REPORT.md) 한 장만 받는다
```

```
아이디어 한 줄  →  리서치 → 트렌드 분석 → 세계관 → 인물 → 시놉시스
                 → 문체 설계 → 회차구성
                 → [작가1 초고 → 검토 → 비평 → 작가2 개고] × 회차 반복
                 → 연속성 점검 → 회차 윤문
                 → 전면 퇴고 (전체 통독 → 회차별 재손질)
                 → PM 승인 → 원고 납품
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
node src/cli.js run --idea "..." [--preset webnovel|romance|estate|epic] [--chapters n]
                    [--chars n] [--pass n] [--provider openai|anthropic|mock]
                    [--model id] [--notes "수위/톤/금기"] [--no-research]
                    [--style "문체 지시"] [--trend <파일|auto>]
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
| `estate` | 영지 경영물. 문제→진단→정책→수치 4단, 정책마다 비용·부작용 | 6화 / 3,500자 / 통과선 81 |
| `sf` | SF. 노붐 하나 원칙, 규칙 위반은 캐논 위반으로 취급 | 5화 / 4,000자 / 통과선 83 |
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
| [docs/DISCORD_PLAN.md](docs/DISCORD_PLAN.md) | **헤르메스 발주서** — 디스코드를 조종석으로 만드는 연동 계획 (ChatGPT에게 주는 문서) |

## 문체 · 트렌드 · 퇴고

| 기능 | 하는 일 |
|---|---|
| **문체 설계** (`STYLE_ARCHITECT`) | AI 티가 나는 이유는 회차마다 문체가 흔들려서다. 문장 평균 길이·은유 밀도·대사 비율·금지어·인물별 말투를 **수치와 규칙으로** 확정해 모든 집필 역할에 주입한다. 한국어 생성 텍스트의 흔한 흔적(3요소 나열, 균질한 문단, 정리 문장으로 닫기, 감정 직접 진술)을 금지 목록으로 명시한다. |
| **트렌드 분석** (`TREND_ANALYST`) | 본문을 긁지 않는다. 사용자가 직접 모은 공개 메타데이터(`--trend <파일>`, [템플릿](templates/trend-input.md))를 분석해 흥행 코드를 **작가 실행 문장**으로 번역한다. 트렌드 복제는 게이트에서 반려된다 — `differentiation`(비틀 지점)이 없으면 통과하지 못한다. 자료 없이 `--trend auto` 로 돌리면 추정임이 결과와 실행 요약에 명시된다. |
| **전면 퇴고** (`POLISHER`) | 회차별 검토는 회차 안만 본다. 전 회차를 통독해야 보이는 것 — 미회수 복선, 회차를 건너뛴 비유 반복, 인물 말투의 표류, 감정선 낙차 — 을 잡아 회차별 퇴고 지시를 내리고, 지시가 있는 회차만 다시 다듬는다. |

## 설계상의 핵심 결정 3가지

1. **팀장은 모델을 쓰지 않는다.** 팀장의 일은 배분·게이트 검사·보고 3가지이고, 이건 결정론적
   코드가 더 정확하고 싸다. 창작과 판단이 필요한 팀원·PM만 모델을 호출한다. (호출 수 ≈ 40% 절감)
2. **캐논을 매 호출에 주입한다.** 장편에서 무너지는 것은 문장력이 아니라 설정 일관성이다.
   `canonSummary()` 가 세계 규칙·인물 목표·확정 사실·미회수 복선을 압축해 모든 팀원에게 넣는다.
3. **개고 루프에 정체 감지기를 단다.** 점수가 오르지 않으면 즉시 멈추고 사람을 부른다.
   "될 때까지 반복"은 자동화가 아니라 토큰 소각이다.

## 요구사항

Node.js 18.17+ (내장 `fetch` 사용). **의존성 패키지 0개.** `npm install` 불필요.
