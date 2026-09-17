-- 자동 Scripture Catalog validator profile 등록부 v1.
--
-- 이 migration은 검토된 profile 네 개를 append-only allowlist에 넣는 일만 한다.
-- 실행 함수, 권한, 활성 포인터, 후보, 검증 기록은 건드리지 않는다.
-- profileHash는 automatic-scripture-catalog-validator-registry.ts의 canonical JSON에서 계산한 값이며,
-- 아래 manifest가 코드의 실제 registry와 같은지는 정적 테스트와 실제 PostgreSQL 검증이 확인한다.

with profile_manifest as (
  select entry
    from jsonb_array_elements(
      $profiles$
      [
        {
          "profileHash": "svp_ca88d91ef46455ee8d1110d3fbf0d030f6d020326c01a36f2e444b0eb219b115",
          "profile": {
            "contractVersion": "scripture-catalog-validator-profile/v1",
            "profileId": "aroeda-demand-counter",
            "profileVersion": "v1",
            "validatorKind": "aggregate_counter",
            "authorizedChecks": ["demandSignal"],
            "independenceGroup": "aroeda-demand-aggregate",
            "modelId": null,
            "rubricVersion": null
          }
        },
        {
          "profileHash": "svp_82b20e37a6c92a100cfad020194544bff123acda8af9ef11d92170c4fcbc074b",
          "profile": {
            "contractVersion": "scripture-catalog-validator-profile/v1",
            "profileId": "aroeda-deterministic-checker",
            "profileVersion": "v1",
            "validatorKind": "deterministic",
            "authorizedChecks": [
              "passageExistence",
              "krvTextMatch",
              "safetyBoundary",
              "duplicateCheck",
              "corpusRegression",
              "candidateGenerationEvaluation"
            ],
            "independenceGroup": "aroeda-deterministic-suite",
            "modelId": null,
            "rubricVersion": null
          }
        },
        {
          "profileHash": "svp_57670984311b1b579170ee91095b75110f4a28343f5626a99e742fdfd925bb40",
          "profile": {
            "contractVersion": "scripture-catalog-validator-profile/v1",
            "profileId": "aroeda-theology-astra",
            "profileVersion": "v1",
            "validatorKind": "model_evaluator",
            "authorizedChecks": ["contextTheologyReview"],
            "independenceGroup": "openai-gpt-6",
            "modelId": "gpt-6-astra",
            "rubricVersion": "aroeda-theology-rubric/v1"
          }
        },
        {
          "profileHash": "svp_9bbbf31a18b25ea69204058fb671323c6019a4e9114552da6c15a08960fb96d3",
          "profile": {
            "contractVersion": "scripture-catalog-validator-profile/v1",
            "profileId": "aroeda-theology-sol",
            "profileVersion": "v1",
            "validatorKind": "model_evaluator",
            "authorizedChecks": ["contextTheologyReview"],
            "independenceGroup": "openai-gpt-5-6",
            "modelId": "gpt-5.6-sol",
            "rubricVersion": "aroeda-theology-rubric/v1"
          }
        }
      ]
      $profiles$::jsonb
    ) as manifest(entry)
)
insert into private.scripture_catalog_validator_profile (
  profile_hash,
  profile,
  validator_kind,
  authorized_checks,
  independence_group
)
select
  entry ->> 'profileHash',
  entry -> 'profile',
  entry #>> '{profile,validatorKind}',
  array(
    select check_name
      from jsonb_array_elements_text(entry #> '{profile,authorizedChecks}')
        with ordinality as checks(check_name, position)
     order by position
  ),
  entry #>> '{profile,independenceGroup}'
from profile_manifest
order by entry #>> '{profile,profileId}';
