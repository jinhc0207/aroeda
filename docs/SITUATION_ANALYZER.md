# Situation Analyzer

사용자가 입력하는 정보는 오직 '지금 나의 상황' 하나다.

Situation Analyzer의 역할은
성경본문을 추천하거나 기도문을 작성하는 것이 아니다.

역할은 사용자의 문장을
아뢰다의 표준 태그 구조로 변환하는 것이다.

## 절대 하지 않을 것

- 심리진단
- 사용자가 말하지 않은 사건 생성
- 사용자가 말하지 않은 감정 단정
- 하나님의 뜻 추측
- 성경본문 선택
- 기도문 작성
- 새로운 임의 태그 생성

## 분석 원칙

사용자가 직접 말한 사실과
합리적으로 읽을 수 있는 감정·신앙적 질문을 구분한다.

확신할 수 없는 태그는 억지로 넣지 않는다.

긍정적인 이야기에서 숨겨진 문제를 만들어내지 않는다.

예:
"오늘 아들이 합격해서 너무 감사해요."

→ 감사, 기쁨으로 분석

금지:
"기쁨을 잃을까 봐 불안함"

## 출력

반드시 정의된 표준 태그만 사용한다.

분석 결과는 사용자에게 직접 표시하지 않는다.

결과는 Scripture Matching Engine으로 전달한다.

## confidence의 의미

Situation Analysis의 `confidence`는

"사용자의 문장을 현재 표준 태그로 분석한 것에 대한 확신"

이다.

다음 의미가 아니다.

"선택된 Scripture Card가 사용자에게 적합할 확률"

따라서 recommendation confidence(추천이 적합한지에 대한 확신)는 앞으로 별도로 판단해야 한다.

향후 함께 볼 수 있는 신호:

- Situation Analysis confidence
- Matcher 최고 점수
- 1위와 2위의 점수 차이
- safety level / category
- Scripture Card coverage (지금 카드로 다룰 수 있는 상황인지)

아직 공식 계산식이나 cutoff는 정하지 않는다.
`scripts/test-openai-stress.ts`로 실제 점수 분포를 먼저 모은다.

## 낮은 확신

현재 Scripture Card는 10개뿐이다.
따라서 모든 사용자 상황에 맞는 카드가 있다고 가정하면 안 된다.

앞으로 두 값을 함께 본다.

1. Situation Analyzer의 confidence
2. Scripture Matching Engine의 최고 점수

구체적인 컷오프 점수는 아직 정하지 않는다.
카드 수가 충분히 늘어난 뒤에 정한다.

원칙만 먼저 정한다.

- 최고 점수가 낮거나 confidence가 낮으면 임의의 성경본문을 강하게 추천하지 않는다.
- 확신이 없을 때 사용자에게 추가 질문을 던지지 않는다. 입력은 '지금 나의 상황' 하나라는 제품 원칙을 지킨다.
- 관련 규칙은 docs/SCRIPTURE_MATCHING.md의 '낮은 확신' 항목과 함께 관리한다.

---

## 출력 규격

```ts
{
  situationTags: string[],
  emotionTags: string[],
  spiritualQuestionTags: string[],
  prayerModes: string[],
  pastoralFunctions: string[],
  safety: {
    level: 'normal' | 'caution' | 'urgent',
    categories: string[]
  },
  confidence: number // 0 ~ 1
}
```

태그는 표준 태그 사전(`src/data/analysis-taxonomy.ts`)에 있는 값만 쓸 수 있다.
이 사전은 사람이 따로 적어 두는 목록이 아니라 현재 Scripture Card에 들어 있는 값에서 자동으로 만들어진다.
카드가 늘어나면 사전도 함께 늘어난다.

### 안전 분류

`safety.categories`에 쓸 수 있는 값은 다음뿐이다.

- `self_harm`
- `suicide`
- `violence_to_others`
- `abuse`
- `immediate_danger`
- `urgent_medical`

safety 분류는 의학적·법률적 진단이 아니다.
아뢰다 내부에서 일반 기도 흐름과 안전 우선 흐름을 구분하기 위한 routing signal이다.

#### level

`normal`
별도의 현실 안전 개입이 필요하다고 볼 신호가 없음. 이때 categories는 비어 있어야 한다.

`caution`
중요한 안전 위험 신호가 있지만, 현재 즉각적인 실행이나 생명·신체 위험이 명확하지 않음.
categories가 최소 하나 있어야 한다.

예:
- 죽고 싶다는 생각
- 자해 생각
- 반복적인 괴롭힘
- 지속적인 정서적 학대
- 위협이나 강압적 통제

`urgent`
현재 또는 임박한 생명·신체 위험, 실행 중인 폭력, 명확한 자살·자해 실행 위험,
긴급 의료상태 등 즉각적인 현실 안전 조치가 필요한 경우. categories가 최소 하나 있어야 한다.

중요:
`caution`은 '위험하지 않음'을 뜻하지 않는다.
일반적인 말씀 추천만으로 처리해서는 안 되는 안전 신호일 수 있다.

`urgent`인 경우 일반적인 말씀 추천과 기도문 제공보다 현실적인 안전 안내가 먼저다.

#### 자살 / 자해

생각이나 소망만 표현된 경우는 `caution`이 될 수 있다.

- "죽고 싶다는 생각이 계속 들어요." → caution 가능 / `suicide`

실행 의도, 계획, 진행 중인 행동이 표현된 경우는 `urgent`다.

- "오늘 죽으려고 합니다." / "지금 자해하려고 칼을 들고 있어요." / "오늘 실행할 계획이 있습니다."
  → urgent / `suicide` 또는 `self_harm` / 필요하면 `immediate_danger`

단순히 자살·자해라는 주제가 감지되었다는 이유만으로 모든 사례를 자동 `urgent`로 만들지 않는다.
다만 `suicide` 또는 `self_harm`이 있으면 `normal`로 분류하지 않는다.

#### violence_to_others

사용자가 다른 사람을 해치려는 의도·계획·행동을 표현한 경우에만 쓴다.
사용자가 폭력의 피해자인 경우에는 쓰지 않는다.

- "남편이 지금 저를 때리고 있어요." → urgent / `abuse` + `immediate_danger` (violence_to_others 아님)
- "지금 그 사람을 죽이고 싶고 찾아가려고 합니다." → urgent / `violence_to_others`

#### urgent_medical

`urgent_medical` 자체가 즉각적인 의료 평가가 필요한 위험 category다.
따라서 `immediate_danger`를 반드시 함께 붙이도록 강제하지 않는다.

- "숨을 쉬기가 너무 어렵고 가슴 통증이 심해요."
  → urgent / `urgent_medical`, 또는 `urgent_medical` + `immediate_danger` — 둘 다 유효하다.

#### 지속적 괴롭힘 / 학대 가능성

사용자가 다음과 같은 지속적 또는 반복적 피해를 명시하는 경우,
즉각적인 신체 위험이 명확하지 않더라도 `caution`으로 분류할 수 있다.

- 반복적인 모욕이나 괴롭힘
- 위협
- 강압적 통제
- 가정폭력
- 지속적인 정서적 또는 신체적 학대

이때 `abuse` category는 법률적 또는 임상적 진단을 의미하지 않는다.
아뢰다 내부에서 일반적인 말씀 추천만으로 처리해서는 안 되는 안전 신호를 표시하기 위한 분류다.

현재 폭행 중이거나, 즉각적인 신체 위험이 명확하거나, 긴급한 현실 조치가 필요한 경우에는 `urgent`를 쓴다.

#### Minimum Sufficient Tagging

매칭에 필요한 만큼만 태그를 선택한다.
사용자가 직접 표현하지 않았거나 강하게 함의되지 않은 감정·욕구·신앙적 질문을
태그 수를 늘리기 위해 추가하지 않는다.
비슷한 의미의 태그를 가능한 많이 고르는 것이 목표가 아니다.

## 구현 메모 (2026-08-27 기준)

### 지금 구현된 것

- `src/data/analysis-taxonomy.ts`: Scripture Card에서 자동으로 만든 표준 태그 사전
- `src/lib/situation-analysis.ts`: 출력 규격 타입과 검증 함수
- `src/lib/situation-analysis.mock.ts`: 테스트용 mock 분석 결과 8개와 안전 mock 3개
- `src/lib/situation-analysis.test.ts`: 규격 검증과 mock → 매칭 엔진 테스트

### 아직 구현하지 않은 것

- 실제 자유문장 분석 (OpenAI 연결)
- 실제 위험 판단
- 안전 안내 화면
- 낮은 확신 처리
- 앱 화면 연결 (두 번째 화면은 여전히 SC-001로 고정되어 있다)
