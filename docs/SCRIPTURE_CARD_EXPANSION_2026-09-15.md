# Scripture Card Expansion v2 (2026-09-15)

51장 체계로 확장한 Scripture Card 데이터의 근거 문서다. 최초 확장에서는
`supabase/functions/_shared/scripture-cards.ts`에 카드 20장을 추가하고
`analysis-taxonomy.ts`의 카드 수 주석을 31→51로 고쳤다. 이후 실제 자연어 평가에서
카드 간 경계가 흐린 사례가 확인되어, 본문·해설·기도 방향·오용 방지 문구는 유지한 채
일부 기존 카드와 신규 카드의 매칭 태그를 보강했다(§7).

## 1. 목적과 영역별 변화

기존 31장 중 카드가 **1장뿐이던 10개 영역**에 정확히 2장씩 추가했다. 확장의 출발점은
기존 340문장 평가 코퍼스(§3)에 포함된 이 10개 영역이 카드 한 장뿐이어서 세부 상황을
나누지 못했다는 사실이다. 완료 후 51장이고, **17개 영역 모두 카드가 최소 3장**이다
(이전 확장 7개 영역은 이미 3장이었고 이번에 손대지 않았다).

| 영역 | 기존 | 신규 | 완료 후 |
|---|---:|---:|---:|
| fear_uncertainty | 1 | 2 | 3 |
| decision_guidance | 1 | 2 | 3 |
| waiting_unanswered_prayer | 1 | 2 | 3 |
| gratitude_joy | 1 | 2 | 3 |
| quiet_communion | 1 | 2 | 3 |
| repentance_guilt | 1 | 2 | 3 |
| comparison_identity | 1 | 2 | 3 |
| injustice_mistreatment | 1 | 2 | 3 |
| grief_loss | 1 | 2 | 3 |
| wisdom_discernment | 1 | 2 | 3 |

신규 카드 두 장은 같은 영역 안에서 기존 카드가 다루지 않던 **서로 다른 구체적 상황**
(예: 검사·면접 결과 대기 vs. 낯선 환경으로의 변화)을 맡는다. 최초 확장 시점에는 기존 카드
객체를 바꾸지 않았지만, 이후 실제 자연어 평가에서 기존 카드가 맡아야 할 표현을 놓치는 사례가
확인되어 일부 기존 카드의 `situationTags`와 `pastoralFunction`도 좁게 보강했다. 이 보강은
말씀 본문이나 사용자에게 보여 주는 해설을 바꾸지 않는다.

## 2. 신규 20장 표

| id | domain | referenceLabel | 대표 상황(focus) |
|---|---|---|---|
| SC-032 | fear_uncertainty | 빌립보서 4:4–7 | 검사·면접·시험 등 결과를 기다리는 불안 |
| SC-033 | fear_uncertainty | 이사야 41:8–10 | 이사·이직·새 학교 등 낯선 변화 앞의 두려움 |
| SC-034 | decision_guidance | 잠언 15:22–23 | 조언과 상의가 필요한 관계·거주 결정 |
| SC-035 | decision_guidance | 누가복음 14:28–33 | 구매·투자·새 일처럼 비용과 책임을 따질 결정 |
| SC-036 | waiting_unanswered_prayer | 시편 130:1–8 | 긴 기다림 속에서 말씀과 소망을 붙듦 |
| SC-037 | waiting_unanswered_prayer | 누가복음 18:1–8 | 포기하고 싶은 때에도 다시 아뢰는 끈기 |
| SC-038 | gratitude_joy | 누가복음 17:11–19 | 응답·회복·오래 기다린 결과에 감사 |
| SC-039 | gratitude_joy | 골로새서 3:15–17 | 평범한 일상·가족·관계 속 감사를 삶으로 표현 |
| SC-040 | quiet_communion | 마가복음 6:30–32 | 분주함을 멈추고 예수님과 잠깐 쉼 |
| SC-041 | quiet_communion | 시편 62:1–8 | 복잡한 마음을 쏟은 뒤 말없이 하나님을 바람 |
| SC-042 | repentance_guilt | 시편 51:1–12 | 숨긴 일·관계에 준 상처를 구체적으로 인정 |
| SC-043 | repentance_guilt | 누가복음 15:17–24 | 신앙과 기도에서 멀어졌다가 돌아옴 |
| SC-044 | comparison_identity | 시편 139:13–18 | 외모·가족 비교로 흔들리는 존재 가치 |
| SC-045 | comparison_identity | 고린도전서 12:14–27 | 능력·성과·공동체 역할 비교 |
| SC-046 | injustice_mistreatment | 시편 37:1–9 | 악인의 형통과 억울함 속 분노·복수 충동 |
| SC-047 | injustice_mistreatment | 이사야 1:16–17 | 사회·직장·공동체의 불의를 보고 책임 있게 행동 |
| SC-048 | grief_loss | 전도서 3:4 | 기일·계절·삶의 변화 속 애도할 시간을 허락 |
| SC-049 | grief_loss | 요한계시록 21:1–5 | 죽음과 깊은 상실 너머 새 창조의 소망 |
| SC-050 | wisdom_discernment | 잠언 18:13, 17 | 사람·주장·엇갈린 설명을 충분히 듣고 확인 |
| SC-051 | wisdom_discernment | 빌립보서 1:9–11 | 가르침과 성경 해석을 사랑·지식·열매로 분별 |

SC-050은 잠언 18장 안에서 서로 떨어진 두 절(13절, 17절)만 읽는 multi-range 카드다.
`passage`는 `passages[0]`(13:13)과 같고, `passages`는 `[18:13-13, 18:17-17]`이며
14~16절은 끼워 넣지 않는다(`bible-reference-label.test.ts`의 "SC-050(같은 장의 쉼표 표기)…" 테스트로 고정).

SC-048은 전도서 3:4 한 절만 읽는다. 애도 사용자에게 실제로 화면에 표시되는 본문에
3절("죽일 때가 있고 치료 시킬 때가 있으며")까지 포함되지 않도록, 애도의 때를 직접
말하는 4절("울 때가 있고 웃을 때가 있으며 슬퍼할 때가 있고 춤출 때가 있으며")로 좁혔다
(검수 수정, 2026-09-15).

SC-034의 `spiritualQuestionTags`는 원래 `['지혜', '공동체', '인도']`였으나 `['지혜', '공동체']`로
좁혔다(검수 수정, 2026-09-15). 원래 값에 있던 '인도'가 SC-002(decision_guidance의 기존 카드)의
spiritualQuestionTags와 겹쳐, 상담·조언을 구한다는 단서가 전혀 없는 일반적인 결정 사연에서도
SC-034가 SC-002보다 높은 점수를 받아 밀어내는 문제가 있었다. '인도'를 뺀 뒤에는 일반 입력에서
SC-002가, SC-034 고유 상황(조언·상의가 필요한 결정)에서는 SC-034가 각각 단독 1위다(§5).

## 3. 기존 340개 단일 상황 코퍼스와의 역할 분담

`scripts/situation-scenario-corpus.ts`의 `EXPANSION_SCENARIOS`(17개 영역 × 20문장 = 340문장) 중
이번 10개 영역 200문장은 영역마다 5개 cluster(각 4문장)로 이미 나뉘어 있었다.
아래는 그 cluster를 세 카드(기존 1장 + 신규 2장) 중 어디가 맡는지 정리한 것이다.
코퍼스 문구·순위·cluster 이름 자체는 이번 작업에서 바꾸지 않았다 — 이미 있는 cluster를
카드 세 장에 배분하는 읽기 전용 매핑이다.

| 영역 | 기존 카드가 맡는 cluster | 신규 카드 A가 맡는 cluster | 신규 카드 B가 맡는 cluster |
|---|---|---|---|
| fear_uncertainty | SC-001: `unknown`, `risk`(막연한 두려움·위험) | SC-032: `diagnosis`, `evaluation`(결과 대기) | SC-033: `transition`(변화와 낯선 환경) |
| decision_guidance | SC-002: `calling`(소명) | SC-034: `relationship_choice`, `move`(관계·거주 결정) | SC-035: `purchase`, `career`(비용·책임 결정) |
| waiting_unanswered_prayer | SC-003: `general_silence`(어느 때까지 탄식) | SC-036: `health_healing`, `marriage_conception`(생명·가정을 향한 기다림) | SC-037: `career_breakthrough`, `reconciliation_wait`(지쳐도 다시 구함) |
| gratitude_joy | SC-004: `good_news`(기쁜 소식) | SC-038: `answered_prayer`, `recovery`(응답·회복) | SC-039: `ordinary_grace`, `relationship_joy`(일상·관계 감사) |
| quiet_communion | SC-005: `ordinary_day`(특별한 문제 없음) | SC-040: `rest_with_god`, `gratitude_pause`(분주함을 멈춤) | SC-041: `presence_desire`, `morning_evening`(말없이 바람) |
| repentance_guilt | SC-006: `repeated_sin`, `habit_guilt`(반복되는 죄) | SC-042: `hidden_sin`, `relational_wrong`(숨긴 일·관계의 상처) | SC-043: `return_to_faith`(신앙에서 멀어졌다 돌아옴) |
| comparison_identity | SC-007: `calling_identity`(소명과 비교) | SC-044: `appearance`, `family_comparison`(외모·가족 비교) | SC-045: `social_media`, `career_comparison`(능력·성과 비교) |
| injustice_mistreatment | SC-008: `bullying`(괴롭힘) | SC-046: `unfair_blame`, `betrayal`(억울함·배신 속 분노) | SC-047: `workplace`, `social_injustice`(불의를 보고 행동) |
| grief_loss | SC-009: `bereavement`(사별) | SC-048: `anniversary_grief`, `life_transition_loss`(기일·삶의 변화) | SC-049: `pregnancy_loss`, `pet_loss`(깊은 상실과 소망) |
| wisdom_discernment | SC-010: `discernment_general`, `timing`, 일부 `life_direction`(일반 지혜·방향) | SC-050: `people_reading`, `competing_advice`(사람·주장을 듣고 확인) | SC-051: 별도 도달성 사례(가르침·성경 해석의 신뢰성) |

이 매핑은 편집상의 배정이다. Gate·Matcher는 코퍼스 문장이나 cluster 이름을 직접 참조하지 않고
카드의 `situationTags` 등 표준 태그로만 채점하며, 카드 데이터의 실제 분리 여부는 §5의
situationTags 분리 무결성 테스트로 확인했다(코퍼스 배정과 Gate 채점은 서로 다른 검증이다).

## 4. 카드별 misuse guard의 이유

각 카드 misuseGuards는 그 본문이 실제로 오용되기 쉬운 두세 지점을 막는다. 공통 축은 세 가지다.

1. **본문의 원래 문맥을 넘어 일반화하지 않는다** — 예: SC-033(이사야 41장)은 이스라엘에게 준 언약적
   약속이지 "내 계획은 항상 성공한다"는 보증이 아니다. SC-035(누가복음 14장)는 제자도의 대가이지
   일반 재정 조언이 아니다. SC-042(시편 51편)는 다윗 개인의 회개이지 피해자에 대한 책임을 면제하지 않는다.
2. **기도가 현실의 도움(의료·법률·안전 조치)을 대신한다고 말하지 않는다** — SC-032(검사·면접 결과),
   SC-035(전문 판단이 필요한 결정), SC-047(법률·노동·안전 지원체계), SC-050(증거·전문가 확인)이 모두
   이 축을 공유한다.
3. **결과·회복·인정을 보장하는 말을 하지 않는다** — SC-032·SC-036·SC-037·SC-038·SC-049가 모두
   "기도하면 반드시 원하는 결과가 온다"는 표현을 명시적으로 막는다. 아뢰다의 제품 원칙(하나님이
   숨은 뜻을 단정하지 않는다, 본문을 명언처럼 쓰지 않는다)과 직접 연결된다.

그 밖에 개별 카드에 필요한 추가 축:

- SC-034: 조언자의 다수결이 곧 하나님의 뜻이라거나, 안전하지 않은 사람에게 반드시 상담하라고
  요구하지 않는다 — "여러 조언을 들으라"는 본문이 위험한 상담 강요로 오용될 수 있어서다.
- SC-037: 불의한 재판관 비유를 하나님의 성품과 동일시하지 않는다 — 비유의 대비 구조(불의한
  재판관 ≠ 하나님)를 놓치면 하나님을 마지못해 들어주는 존재로 오해하게 된다.
- SC-039: 감사를 요구해 현재의 슬픔·부당함을 덮거나 죄책감으로 몰아가지 않는다 — 평범한 일상에
  대한 감사가 "왜 너는 감사하지 않느냐"는 압박으로 변질되기 쉬워서다.
- SC-040: 짧은 쉼의 장면을 무기한 책임 회피의 명령으로 확대하지 않는다 — 본문 바로 뒤에 쉼이
  방해받는 흐름이 이어지므로 "완벽한 고요가 보장된다"고 말하지 않는다.
- SC-041 · SC-047: 침묵이나 하나님께 맡김을 학대·위협 상황에서 "참고 견디라"는 뜻으로 쓰지 않는다
  — 이 앱의 핵심 원칙(피해·학대·자해·폭력 상황에서는 현실적 안전을 우선한다)과 직접 충돌하는
  오용이기 때문에 가장 무겁게 다뤘다.
- SC-042 · SC-046: 실제 피해자에게 준 해나 분노를 "죄"로 규정해 억누르게 하지 않는다 — 회개·탄식
  본문이 가해자 책임 면제나 피해자 감정 억압의 도구가 되지 않도록 막는다.
- SC-043: 하나님 아버지의 환대를 안전하지 않은 실제 가정으로 돌아가라는 명령과 동일시하지 않는다
  — 탕자 비유가 실제 학대 관계로의 복귀를 정당화하는 데 쓰이면 안 되기 때문이다.
- SC-044: 외모·장애·질병의 실제 고통을 긍정 문구로 덮거나, 현재 몸 상태를 하나님의 특별한 의도로
  추측하지 않는다.
- SC-045: 본문을 교회 직분·역할을 강제로 고정하는 근거나 해로운 공동체에 머물라는 근거로 쓰지 않는다.
- SC-048 · SC-049: 애도에 정해진 기간을 강요하지 않고, 죽음의 이유를 하나님이 정하셨다고 단정하지
  않으며, 특정 고인의 구원 상태를 앱이 판정하지 않는다 — 상실을 다루는 카드가 가장 쉽게 넘는
  경계라서 셋 다 명시했다.
- SC-050: 상대의 숨은 의도를 읽을 수 있다고 말하거나, 모든 증언을 동일하게 의심하거나 피해자의
  말을 자동으로 불신하게 만들지 않는다 — "다 들어보라"는 본문이 피해자 불신으로 오용되는 것을
  가장 경계했다.
- SC-051: 기도 중 든 느낌을 직접 계시로 단정하거나, 특정 교사·교회·해석이 옳다고 앱이 판정하거나,
  분별을 끝없는 의심·결정 회피의 핑계로 쓰지 않는다.

## 5. 검증

- 개역한글 본문 위치는 로컬 `src/data/bible/krv1961.json`으로 검증했다. 20개 카드의 `passage`/`passages`
  전부가 실제 책·장·절 범위 안에 있는지 스크립트로 확인했고, `src/lib/bible-reference.test.ts`의
  "카드 51개의 모든 본문 위치가 실제 성경에 있다" 테스트로 고정했다.
- 각 신규 카드 자신의 `situationTags`를 그대로 Gate 입력으로 되먹여, 같은 영역의 다른 두 카드와
  분리되어 Primary-First Gate에서 단독 1위 `recommend`가 되는지 20건 모두 확인했다(`emotionTags` 등
  다른 사전을 추가하지 않고도 전부 통과했다). 이것은 카드 데이터의 situationTags 분리 무결성을
  보는 것이지, 자연어 입력이나 Situation Analyzer의 추출 정확도를 검증하는 것은 아니다
  — `src/lib/scripture-expansion-simulation.test.ts`의
  "Scripture Card Expansion v2 · 신규 카드 20장 situationTags 분리 무결성" 블록.
- 최초 20장 확장 검수에서는 SC-001~SC-031 객체가 바뀌지 않았음을 SHA-256으로 확인했다.
  이후 실제 자연어 평가에서 일부 기존 카드의 매칭 태그를 보강했으므로, 이 지문은 현재 상태의
  불변 조건으로 사용하지 않는다. 현재 검증은 카드 51장의 본문 위치, 영역, 매칭 결과와 회귀
  사례를 직접 테스트한다.

## 6. 참고 자료

아래 자료는 각 본문의 학술적 문맥(누구에게, 어떤 상황에서 주어진 말씀인지)을 확인하는 데만
사용했다. 본문이나 해설을 그대로 복사하지 않았다 — 카드의 `contextSummary`·`theologicalInsight`·
`userExplanation`·`prayerDirection`은 모두 새로 쓴 한국어 설명이다.

- Psalm 130 waiting: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/fifth-sunday-in-lent/commentary-on-psalm-130-11>
- Philippians 4 anxiety and prayer: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/third-sunday-of-advent-3/commentary-on-philippians-44-7-2>
- Luke 18 persistent prayer and justice: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-29-3/commentary-on-luke-181-8-4>
- Mark 6 rest: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-16-2/commentary-on-mark-630-34-53-56>
- Psalm 51 repentance and concrete wrongdoing: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ash-wednesday/commentary-on-psalm-511-17-18>
- Luke 15 welcome and repentance: <https://www.workingpreacher.org/commentaries/narrative-lectionary/lost-sheep-coin-son/commentary-on-luke-151-32-2>
- Psalm 139 creation and being known: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/second-sunday-after-epiphany-2/commentary-on-psalm-1391-6-13-18-2>
- 1 Corinthians 12 body and diverse gifts: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/third-sunday-after-epiphany-3/commentary-on-1-corinthians-1212-31a-5>
- Psalm 37 anger and injustice: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-27-3/commentary-on-psalm-371-9-2>
- Isaiah 1 worship and justice: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-19-3/commentary-on-isaiah-11-10-20>
- Revelation 21 new creation and grief: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/fifth-sunday-of-easter-3/commentary-on-revelation-211-6-4>
- Luke 14 cost of discipleship: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-23-3/commentary-on-luke-1425-33>
- Luke 17 gratitude: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/ordinary-28-3/commentary-on-luke-1711-19-3>
- Colossians 3 gratitude in community: <https://www.thegospelcoalition.org/commentary/colossians/>
- Philippians 1 discerning love: <https://depree.org/life-for-leaders/abounding-in-love-and-knowledge/>
- Proverbs 15 counsel: <https://biblehub.com/commentaries/proverbs/15-22.htm>
- Ecclesiastes(전도서) 개관: <https://bibleproject.com/guides/book-of-ecclesiastes/>
- Proverbs(잠언) 개관: <https://bibleproject.com/guides/book-of-proverbs/>
- Psalm 62 trust and refuge: <https://www.workingpreacher.org/commentaries/revised-common-lectionary/third-sunday-after-epiphany-2/commentary-on-psalm-625-12-2>

(이사야 41장은 위 목록에 없어 별도 외부 자료 없이 본문과 `krv1961.json` 대조만으로 확인했다.)

## 7. 실제 자연어 평가 뒤 경계 보강

153개 자연어 평가와 신규 카드 도달성 검사를 실행한 뒤, Analyzer가 실제로 내놓는 태그와 카드
경계가 어긋나는 사례만 좁게 보강했다. 구절 범위, `contextSummary`, `theologicalInsight`,
`userExplanation`, `prayerDirection`, `misuseGuards`는 이 단계에서 바꾸지 않았다.

- 결정·분별: SC-002에 선택을 못 정하거나 새 직장 선택을 돌아보는 표현을, SC-034에 결혼·재혼
  결정을, SC-035에 창업과 안정적인 길 사이의 고민을 추가했다. SC-050에는 여러 사람의 조언을
  구하는 표현을 추가했고, SC-051에서는 지나치게 넓던 `무엇이 더 나은지 분별함`을 제거했다.
- 기다림·상실: SC-036에 오래 기도했지만 상황이 그대로인 표현을 추가했다. SC-049에는 아이를
  잃은 슬픔과 상실을 서둘러 정리하기 어려운 표현을 추가하고, 기도 방식 `간구`와 목회 기능
  `애도`를 보강했다.
- 소진·메마름·고립: SC-013에 포기하고 싶을 만큼 지치거나 아침부터 버거운 표현을 추가했다.
  SC-014에는 버림받은 느낌과 목회 기능 `교제`를, SC-018에는 연락할 사람이 없어 혼자 견디는
  복합 표현을 추가했다. 이때 SC-011이 맡던 일반적인 “내 이야기를 할 사람이 없음” 경계는
  유지해 기존 단일 태그 추천이 흐려지지 않게 했다.
- 가족·경제·질병·회개: SC-012·020에는 서로 화내는 부모·자녀 대화와 배우자 간 양육 방식
  차이를, SC-015·026·027에는 불면을 동반한 돈 걱정·월세 뒤 식비 부족·수입 감소로 인한
  교육비 부담을, SC-016에는 호전 뒤 재악화를, SC-042에는 숨긴 일 때문에 하나님 앞에
  나가기 힘든 표현을 추가했다.
- 고요한 교제: SC-041의 목회 기능에 `쉼`을 추가해, 말없이 하나님을 바라보는 관계적 쉼이
  다른 쉼 카드와 불필요한 동점을 만들지 않도록 했다.

이 변경은 한 번의 모델 출력에 맞춘 전면 재조정이 아니다. 반복해서 같은 경계가 어긋난 사례와
기존 카드의 명백한 표현 공백만 반영했으며, 최종 판단 근거는 평가 계획 문서의 반복 안정성
기록과 로컬 회귀 테스트에 남겼다.
