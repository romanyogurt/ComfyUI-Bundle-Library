# 호환성 표본

출시된 노드가 쓴 파일과, 형식의 경계를 시험하는 손으로 만든 파일이다. 새 버전은 이 파일들을
계약대로 읽어야 한다 (`docs/data-format.md`의 호환성 정책).

- **표본은 고치거나 지우지 않는다.** 형식이 바뀌면 새 표본을 더한다. 코드를 표본에 맞추고, 표본을
  코드에 맞추지 않는다.
- 아래의 생성 기록은 다시 만들기 위한 것이 아니라 출처를 밝히기 위한 것이다. 다시 만들면 UUID와
  시각이 달라진다.

## 출시된 코드로 만든 라이브러리

2026년 10월 16일, 각 커밋의 git worktree를 ComfyUI 이미지(`comfyui-local:py313-torch2.12.1-cu130-nodes-v3`)
컨테이너에 읽기 전용으로 붙이고 `generate.py`로 만들었다. 미디어는 이 저장소의 `tests/helpers.py`로
만든 합성 파일이다. `tmp/`와 `thumbs/`는 뺐다.

```bash
docker run --rm --entrypoint python -e CUDA_VISIBLE_DEVICES= \
    -v <worktree>:/src:ro -v <this repo>/tests:/cur:ro -v <out>:/out <image> \
    /cur/fixtures/compat/generate.py --recipe <recipe> --out /out/<folder>
```

| 폴더 | 노드 | 커밋 | 레시피 | 담긴 것 |
| --- | --- | --- | --- | --- |
| `0.0.2-phase1/` | 0.0.2 | `6b2e1d7` | `phase1` | 텍스트(여러 줄, 앞뒤 공백), 이미지, 빈 이미지 필드, 불리언, 정수, 실수 |
| `0.0.8-phase6/` | 0.0.8 | `48607bd` | `phase6` | 소리가 있는 MP4, WAV, 빈 비디오·오디오 필드, 이미지, 가장 큰 안전 정수 |
| `0.0.10/` | 0.0.10 | `2801529` | `0.0.10` | 활성 번들 하나와, 옛 `trash/` 폴더의 지운 번들 하나 |

기대 동작: 셋 모두 v1 파일이며 상태는 정상이다. 다시 쓰지 않고 읽히고, 노드로 실행된다.
`0.0.10/trash/`의 파일은 시작할 때 `deleted_at`이 있는 v2 번들로 `bundles/`에 옮겨진다.

## 0.0.10의 백업과 워크플로

- `backup-0.0.10.zip`: comfy-docker의 `scripts/backup-bundle-library.py`(0.0.10 때의 것, comfy-docker
  `85be29c`)로 `0.0.10/` 라이브러리를 백업한 zip이다. 옛 `trash/`가 들어 있다. 기대 동작: 확인을
  통과하고, 복원한 뒤 시작할 때 휴지통 파일이 v2로 옮겨진다.
- `0.0.10-workflow/`: 노드 0.0.10과 프런트엔드 1.53.10을 쓰는 테스트 서버에서 `make_workflow.cjs`로
  저장한 워크플로다.
  - `workflow.json`: Load Bundle 노드 하나(출력 prompt·ref·seed·flag, 앞의 셋이 프리뷰 노드에
    연결됨). `workflow-bundle.json`과 `workflow-ref.png`는 그때 쓴 번들과 이미지다. 기대 동작: 같은
    필드의 번들로 `bundle_id`를 바꿔 불러오면 출력의 이름·타입·순서, 링크, 미리보기가 돌아온다.
  - `workflow-unknown-slot-type.json`: 위 워크플로의 `slot_spec`에서 flag의 타입만 `mesh`로 바꿨다.
    기대 동작: 불러와 저장해도 `slot_spec` 원문, 출력, 링크가 그대로이고 노드가 안내를 보인다.

## 손으로 만든 번들 파일 (`handmade/`)

2026년 10월 16일에 만들었다. 기대하는 상태와 목록의 오류 코드는 `handmade/expected.json`에 있다.

- 경고(읽히지만 작성 규칙을 넘음): 정수 2^53+1, 2^60, 2^63−1, 121자 이름
- 손상: 표지 `true`·`1.0`, 중복 필드 이름, v2의 없거나 잘못된 `deleted_at`, JSON이 아닌 파일
- 새 버전: 파일을 `resources`로 가리키는 `schema_version: 3` (`v3-other-references`, 정리가 그 파일을 놓치면
  안 된다). 0.0.30에서 버전 3이 생겨, 이 표본은 버전 3에 모르는 키 `resources`가 있는 읽기 전용 파일이 됐다(정리는
  여전히 멈춘다). 새 버전의 경우는 `newer-other-references`(`schema_version: 99`, 0.0.30에 더함)가 맡는다
- 미지원: 모르는 `format`, 모르는 필드 타입 `mesh`
- 읽기 전용: 최상위, 필드, 에셋 정보 안의 모르는 키
- 정상: v2의 활성·휴지통 번들, 이름이 같은 두 번들

## 옛 휴지통 이관 (`legacy-trash/`)

0.0.10 모양의 `bundles/`와 `trash/`. 기대 동작은 `legacy-trash/expected.json`에 있다.

- 옮겨진다: 같은 UUID가 없는 읽을 수 있는 파일. 같은 UUID의 두 사본 가운데 가장 늦게 지운 것
- 그대로 남는다: `bundles/`에 같은 UUID가 있는 파일, 같은 UUID의 두 번째 사본, 읽을 수 없는 파일
