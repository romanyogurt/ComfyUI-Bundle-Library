# 데이터 형식과 API

Bundle Library가 디스크에 저장하는 형식과 HTTP API를 정리한다. 구현은
`bundle_library/model.py`(검증), `schema.py`(번들 파일의 버전과 상태), `store.py`(번들),
`organization.py`(카테고리와 즐겨찾기), `assets.py`(미디어), `routes.py`(API)에 있다. 버전이 다른 파일을 어떻게 다루는지는 끝의
[호환성 정책](#호환성-정책)에 있다.

## 저장 위치

ComfyUI 사용자 디렉토리 아래 `bundle_library/`를 쓴다. comfy-docker 구성에서는 호스트의
`user/bundle_library/`이다. 처음 API를 호출할 때 만들어진다.

```text
bundle_library/
├── bundles/<uuid>.json                        # 번들 하나에 파일 하나. 휴지통의 번들도 여기 있다
├── organization.json                          # 카테고리, 번들의 배치, 즐겨찾기 (0.0.12부터, 없을 수 있다)
├── assets/sha256/<해시 앞 2자리>/<sha256>.<ext>    # 올린 원본, 바이트 그대로
├── thumbs/<해시 앞 2자리>/<sha256>_<크기>.webp     # 다시 만들 수 있는 미리보기
└── tmp/                                       # 쓰는 중인 파일. 열 때 비운다
```

- 백업 대상은 `bundles/`, `assets/`와 라이브러리 폴더 바로 아래의 파일(`organization.json`)이다. `thumbs/`와 `tmp/`는
  백업하지 않아도 된다.
- 0.0.10 이하는 지운 번들을 `trash/<uuid>.<UTC 시각>[-n].json`에 옮겼다. 지금은 시작할 때(또는 목록을
  읽을 때) 그 파일을 `deleted_at`이 있는 버전 2 번들로 `bundles/`에 옮긴다. 옮길 수 있는 것은 읽을 수
  있고 같은 UUID의 파일이 `bundles/`에 없는 것이며, 같은 UUID가 여러 번 지워졌으면 가장 늦게 지운 것만
  옮긴다. 나머지는 그대로 두고 휴지통 목록의 `errors`(`legacy_trash`)와 `/health`의 `legacy_trash`에
  보고한다. 폴더가 비면 지운다.
- 이 폴더에는 ComfyUI 프로세스 하나만 쓴다. 다른 프로세스가 같은 폴더를 열면 쓰는 중인
  임시 파일을 지울 수 있다.
- 번들 파일을 손으로 고치면 다음 목록 조회 때 반영된다(내용, 권한, 파일 교체를 알아챈다). 쓸 수 없는 파일은
  건너뛰고 목록의 `errors`와 `/health`에 상태별로 보고한다 (호환성 정책의 상태). 파일 하나가 무엇을 담든 다른
  파일의 목록을 막지 않는다. 뜻밖의 예외도 그 파일의 손상으로 보고하고 서버 로그에 남긴다.
- 권한이나 I/O 오류로 파일을 읽지 못하면 손상이 아니라 `read_error`로 보고하고(영구 삭제를 권하지 않는다),
  기억하지 않고 다음 요청 때 다시 읽는다. `organization.json`도 같다.

## 번들 파일

```json
{
  "format": "comfyui-bundle-library/bundle",
  "schema_version": 2,
  "id": "0b0fd10b-2e9d-43fa-898a-91f0cda76f5e",
  "revision": 1,
  "name": "Sample A (red)",
  "tags": ["sample"],
  "note": "",
  "fields": [
    {"name": "prompt", "type": "text", "value": "An adult woman in a red dress."},
    {"name": "ref_1", "type": "image", "asset": {
      "sha256": "4f71…6024", "ext": "png", "width": 512, "height": 768,
      "bytes": 6272, "original_name": "a_ref_1.png"}},
    {"name": "ref_2", "type": "image", "asset": null},
    {"name": "use_bgm", "type": "boolean", "value": true}
  ],
  "created_at": "2026-10-14T01:32:24.101Z",
  "updated_at": "2026-10-14T01:32:24.101Z",
  "deleted_at": null
}
```

| 키 | 설명 |
| --- | --- |
| `id` | UUID. 파일 이름과 같아야 한다. 워크플로는 이 값으로 번들을 가리킨다 |
| `revision` | 1부터 시작해 저장, 휴지통으로 지우기, 되살리기마다 1씩 오른다 |
| `name` | 표시용이다. 다른 번들과 같아도 된다(같은 카테고리 안에서도). 화면은 이름이 같은 번들을 id의 앞부분으로 구분해 보인다 |
| `fields` | 순서가 있는 배열. 순서는 로더에서 처음 고를 때의 출력 순서다 |
| `created_at`, `updated_at` | UTC, 밀리초까지. `updated_at`은 내용을 저장할 때만 바뀐다 |
| `deleted_at` | `null`이면 쓰는 번들, UTC 시각이면 휴지통에 있다. 휴지통의 번들은 되살리기 전까지 실행되지 않는다 (버전 2부터) |

## 필드

| `type` | 값 | 로더 출력 | 규칙 |
| --- | --- | --- | --- |
| `text` | `value`: 문자열 | STRING | 빈 값 허용. 공백·개행을 바꾸지 않는다. UTF-8로 1MB까지 |
| `image` | `asset`: 객체 또는 `null` | IMAGE | `asset.sha256`은 먼저 올린 이미지 파일이어야 한다 |
| `video` | `asset`: 객체 또는 `null` | VIDEO | 먼저 올린 비디오 파일. core Load Video처럼 파일을 그대로 넘기고, 쓰일 때 디코딩한다 |
| `audio` | `asset`: 객체 또는 `null` | AUDIO | 먼저 올린 오디오 파일. core Load Audio처럼 전부 디코딩해 `{"waveform": [1, 채널, 샘플], "sample_rate"}`로 내보낸다. waveform은 float32이고, 64비트 float 파일만 core처럼 float64다 |
| `boolean` | `value`: `true`/`false` | BOOLEAN | 0·1은 받지 않는다 |
| `int` | `value`: 정수 | INT | ±9,007,199,254,740,991(±(2^53−1), JavaScript의 안전 정수). 브라우저가 JSON 숫자를 double로 읽으므로 이보다 큰 값은 편집기를 거치며 바뀐다. `true`/`false`는 받지 않는다 |
| `float` | `value`: 숫자 | FLOAT | 유한값만 |

- 파일 필드(`image`, `video`, `audio`)의 `asset`에는 `sha256`과 표시용 `original_name` 말고도
  파일 정보가 들어 있다. 저장할 때 서버가 파일에서 다시 채우고, 클라이언트가 보낸 값은 쓰지
  않는다.
  - 공통: `ext`, `bytes`
  - `image`: `width`, `height` (EXIF 방향을 적용해 보이는 크기)
  - `video`: `width`, `height`, `fps`, `duration`(초), `codec`, `has_audio`, 소리가 있으면
    `audio_codec`
  - `audio`: `duration`(초), `sample_rate`, `channels`, `codec`. `duration`은 파일 헤더의 길이이고,
    헤더에 없으면 디코딩해 센 길이다
- 파일의 종류는 필드 타입과 같아야 한다. 이미지 파일을 `video` 필드에 넣으면 `wrong_kind`로
  거부한다.
- 필드 이름은 번들 안에서 고유하다. 대소문자를 구분하는데, 로더가 이름을 그대로 비교하기
  때문이다. `@`로 시작하는 이름은 앞으로의 가상 필드(번들 이름 출력 등)를 위해 예약했다.

## 이름 규칙과 제한

| 항목 | 규칙 |
| --- | --- |
| 이름 공통 (번들, 필드, 태그, 카테고리) | 앞뒤 공백을 지우고 NFC로 정규화한다. 줄바꿈, 제어 문자, 방향 제어 문자는 쓸 수 없다 |
| 번들 이름 | 120자. 다른 번들과 같아도 된다 |
| 카테고리 이름 | 60자. 대소문자와 관계없이 겹치지 않는다. Favorites, Uncategorized, Needs attention은 쓸 수 없다. 카테고리는 200개까지 |
| 필드 이름 | 64자 |
| 태그 | 20개, 각 40자. 대소문자만 다른 태그는 하나로 합친다 |
| 메모 | 10,000자 |
| 필드 수 | 32개 (로더 출력 수와 같다) |
| JSON 요청 본문 | 4MB |
| 이미지 | PNG, JPEG, WebP. 파일 50MB, 6,400만 픽셀 |
| 비디오 | MP4, WebM(VP8·VP9·AV1과 Opus·Vorbis), MOV. 파일 1GB, 프레임당 7680×4320 픽셀 |
| 오디오 | WAV, FLAC, MP3, OGG(Opus·Vorbis), M4A. 파일 200MB, 길이 10분, 채널 8개, 샘플레이트 192kHz, 샘플 5,760만 개(모든 채널 합계, 48kHz 스테레오 10분). 샘플 형식은 16·24·32비트 정수와 32·64비트 float |
| 썸네일 크기 | 128, 256, 512 |

## 정리 파일 (organization.json)

카테고리와 즐겨찾기는 번들의 내용이 아니라 목록의 정리라서 번들 파일 밖에 둔다 (0.0.12, Phase 7.6).
번들을 옮기거나 즐겨찾기해도 번들 파일, revision, 그 번들을 쓰는 노드의 캐시가 바뀌지 않는다.

```json
{
  "format": "comfyui-bundle-library/organization",
  "schema_version": 1,
  "revision": 12,
  "categories": [{"id": "6f1c0e5a-…", "name": "Characters", "parent": null}],
  "placement": {"0b0fd10b-2e9d-43fa-898a-91f0cda76f5e": "6f1c0e5a-…"},
  "favorites": ["0b0fd10b-2e9d-43fa-898a-91f0cda76f5e"]
}
```

| 키 | 설명 |
| --- | --- |
| `revision` | 0부터, 쓸 때마다 1씩 오른다 |
| `categories` | 카테고리의 `id`(UUID), `name`, `parent`. 화면은 이름순으로 보인다 |
| `parent` | 중첩을 위해 열어 둔 자리다. 버전 1은 `null`만 받고, 다른 값이면 파일을 손상으로 본다 |
| `placement` | 번들 id → 카테고리 id. 번들마다 카테고리는 하나이고, 없으면 Uncategorized다 |
| `favorites` | 즐겨찾기한 번들 id. 즐겨찾기한 번들은 Favorites와 제 카테고리에 함께 보인다 |

- 파일이 없으면 빈 정리로 본다. 옛 라이브러리는 모든 번들이 Uncategorized로 열린다. 처음 정리를
  바꿀 때 만든다.
- 카테고리 이름은 이름 공통 규칙(앞뒤 공백 제거, NFC, 줄바꿈·제어·방향 제어 문자 금지)을 따르고
  60자까지다. 대소문자와 관계없이 다른 카테고리와 겹치지 않아야 한다(409 `category_conflict`).
  계산하는 보기의 이름(Favorites, Uncategorized, Needs attention)은 쓸 수 없다. 카테고리는 200개까지다.
- 없는 번들이나 없는 카테고리를 가리키는 항목은 읽을 때 무시하고, 다음에 쓸 때 정리한다. "있는
  번들"은 `bundles/`의 모든 UUID(쓰는 것, 휴지통의 것, 읽을 수 없는 것)와 옛 `trash/`의 것이다.
  그래서 휴지통의 번들과 읽지 못하는 파일의 배치와 즐겨찾기는 남는다.
- 번들의 수명과 맞춘다.
  - 휴지통으로 지우기와 되살리기는 배치와 즐겨찾기를 그대로 둔다. 되살린 번들은 제 카테고리에
    즐겨찾기 그대로 돌아온다. 영구 삭제와 휴지통 비우기 때 지운다.
  - 복제한 번들은 원본과 같은 카테고리에 둔다. 즐겨찾기는 복사하지 않는다.
  - 카테고리를 지우면 그 번들(휴지통의 것 포함)은 Uncategorized가 된다. 번들은 바뀌지 않는다.
- 번들 파일과 정리 파일은 따로 원자적으로 쓰이므로, 만들기·복제에서 번들은 만들어졌는데 배치만
  실패할 수 있다. 그때는 201과 함께 `placement_error`(이유)를 돌려준다. 배치만 다시 하면 되고, 번들을
  다시 만들지 않으므로 중복이 생기지 않는다.
- 상태는 번들 파일과 같은 규칙을 따른다 (호환성 정책). 모르는 키가 있으면 읽기 전용, 더 새
  `schema_version`이면 새 버전, 다른 `format`이면 미지원, JSON이 아니거나 구조가 틀리면 손상이다.
  읽기 전용이면 카테고리를 보이고, 나머지는 카테고리 없이 보인다. 어느 경우든 파일을 바꾸지 않고
  정리를 바꾸는 요청을 409 `organization_unwritable`로 거부하며, 목록의 `errors`와 `/health`의
  `organization`에 보고한다. 번들 작업은 계속되고, 만들기의 배치는 `placement_error`가 된다.

## 에셋

- 확장자와 MIME 타입을 믿지 않는다.
  - 이미지는 Pillow의 PNG·JPEG·WebP 디코더로만 열어 끝까지 디코딩해 본다.
  - 비디오와 오디오는 PyAV로 열어 컨테이너와 코덱을 확인한다. 비디오는 첫 프레임을 디코딩해
    본다. MP4·MOV·M4A는 같은 형식(ISO 미디어)이라 브랜드와 스트림으로 구분한다. 브랜드가 `qt`면
    MOV, 비디오 스트림이 있으면 MP4, 소리만 있으면 M4A다. MP3·M4A의 앨범 그림은 비디오로 보지
    않는다.
  - 오디오는 실행할 때 메모리에 통째로 디코딩되므로, 올릴 때 끝까지 디코딩해 실제 샘플 수로
    길이와 샘플 제한을 판정한다. 헤더의 길이는 믿지 않는다. 8비트·64비트 정수 샘플처럼 core의
    AUDIO 변환이 받지 않는 형식은 거부한다. 실행할 때도 같은 제한을 넘으면 그 자리에서 디코딩을
    멈추고 실패한다.
  - 허용하지 않는 형식이나 종류가 다른 파일, 채널·샘플레이트·샘플 형식이 범위 밖인 오디오는
    415, 깨진 파일은 400, 픽셀 수·길이·샘플 수 초과는 413이다.
- 원본 바이트를 바꾸지 않고 SHA-256 이름으로 저장한다. 같은 내용을 다시 올리면 기존 파일을
  쓰고, 파일의 수정 시각만 지금으로 바꾼다 (아래 유예 시간).
- 지운 번들은 같은 파일에 `deleted_at`이 적혀 휴지통에 간다. 휴지통에서 되살리면 같은 id와 이름으로
  돌아오고, 영구 삭제하면 파일이 지워진다. 휴지통의 번들이 쓰는 파일은 남겨 두므로 되살린 번들은
  온전하다.
- 쓰이지 않는 파일 정리: 라이브러리의 번들도, 휴지통의 번들도 쓰지 않는 파일을 목록과 크기로
  먼저 보여 주고, 확인을 받아 썸네일과 함께 지운다.
  - 저장한 지(또는 다시 올린 지) 24시간이 안 된 파일은 남긴다. 편집기는 번들을 저장하기 전에
    파일을 올리기 때문이다.
  - 지울 때 다시 확인한다. 목록을 본 뒤 어떤 번들이 쓰기 시작한 파일은 남는다.
  - 완전히 읽을 수 없는 번들 파일(새 버전, 미지원, 읽기 전용, JSON이 아닌 손상 파일)이 하나라도
    있으면 정리하지 않는다. 그 번들이 쓰는 파일을 알 수 없기 때문이다.
  - 폴더 안의, 라이브러리가 만들지 않은 파일은 건드리지 않는다. 파일이 없는 썸네일은 지운다.
- 썸네일은 처음 요청할 때 만든다.
  - 이미지: EXIF 방향을 적용하고, 16비트 이미지는 잘리지 않게 비율을 줄인다.
  - 비디오: 길이의 10% 지점(1초를 넘지 않음)의 프레임을 쓴다.
  - 오디오: 썸네일이 없다 (404).
- 원본은 HTTP Range 요청을 받으므로 브라우저가 비디오·오디오를 스트리밍하고 원하는 위치로
  넘길 수 있다. MOV는 `video/mp4`로 보낸다. 브라우저가 `video/quicktime`은 받지 않지만 그
  안의 H.264는 재생하기 때문이다.

## HTTP API

접두어는 `/bundle-library/v1`이다. ComfyUI가 같은 경로를 `/api` 아래에도 제공하므로,
프런트엔드는 `api.fetchApi("/bundle-library/v1/...")`로 호출한다.

### 쓰기 요청의 조건

POST·PUT·DELETE는 다음을 모두 만족해야 한다. 아니면 403이다.

- `X-Bundle-Library: 1` 헤더 (`missing_header`)
- `Sec-Fetch-Site`가 있으면 `same-origin` 또는 `none` (`cross_site`)
- `Origin`이 있으면 `Host`와 같음 (`origin_mismatch`)

JSON 본문은 `Content-Type: application/json`이어야 한다 (415). 화면은 쓰기 요청에
`X-Bundle-Library-Version`(자기 스크립트의 버전)을 보낸다. 서버의 버전과 다르면 409
`version_mismatch`로 거부하고 `page_version`, `server_version`을 준다. 이 헤더가 없는 요청(스크립트
등)은 그대로 받는다.

### 요청의 모양과 쓰기의 결과

- 요청 본문은 경로마다 필수 키, 생략할 수 있는 키(`?`, 기본값이 있다), `null`을 받는 키가 정해져 있다. 필수
  키가 빠지면 400 `invalid`("Missing in the request: …")다. 빠진 키를 빈 값이나 `null`로 여기지 않는다
  (0.0.16부터). 인수는 파일을 쓰기 전에 모두 검사한다.
- 유니코드 스칼라가 아닌 문자열(외톨이 서로게이트)이나 지나치게 깊은 중첩이 든 본문은 400 `invalid_json`이다.
- 파일은 임시 파일에 쓰고 동기화한 뒤 한 번에 바꾼다. 바꾸기 전에 실패하면 아무것도 쓰지 않았고, 단건
  요청은 500 `io_error`(`"retry": true`), 일괄 작업은 그 번들의 `io_error`다. 바꾼 뒤 폴더 동기화만 실패하면
  변경은 반영된 것으로 보고하고(일괄 결과와 `DELETE /bundles/{id}`에는 `warning`), 서버 로그에 남긴다. 전원이
  나가면 그 변경이 사라질 수 있다는 뜻이다.
- 본 작업이 성공한 뒤 정리 파일(`organization.json`) 쓰기가 실패하면 본 작업은 성공이다. 만들기·복제는
  `placement_error`로 알리고, 영구 삭제·휴지통 비우기는 남은 정리 항목을 다음 쓰기 때 지운다.

### 엔드포인트

| 메서드 | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{"version", "organization", "bundles", "trash", "corrupt", "newer", "unsupported", "legacy_trash": [파일 이름], "writable"}`. `organization`은 정리 파일의 상태(`missing`, `ok`, `read_only`, `newer_version`, `unsupported`, `corrupt`) |
| GET | `/bundles` | `q`(이름·태그·카테고리 이름·필드 이름·텍스트 값 검색), `tag`, `sort`(`name`/`updated`, 이름이 같으면 id 순) | `{"bundles": [요약], "errors": [{"file", "id", "code", "error"}], "categories": [{"id", "name", "parent", "count"}], "organization": {"revision", "state"}}`. 휴지통의 번들은 빠진다. `categories`는 이름순이고 `count`는 걸러진 목록에서 센다 |
| POST | `/bundles` | `{"name", "tags"?, "note"?, "fields"?, "category"?}` | 201, 번들. `category`(id)를 주면 그 카테고리에도 둔다. 형식은 쓰기 전에 검사하고(400), 없는 카테고리 등 배치만 실패하면 `placement_error` |
| GET | `/bundles/{id}` | — | 번들. 경고가 있으면 `warnings`, 읽기 전용이면 `read_only`(이유)를 더한다. 휴지통에 있으면 404 `in_trash` |
| PUT | `/bundles/{id}` | `{"expected_revision", "name", "tags", "note", "fields"}` (모두 필수, 전체 교체) | 번들 (revision +1) |
| DELETE | `/bundles/{id}?expected_revision=N` | — | `{"deleted": id, "changed", "warning"?}`. 휴지통으로 보낸다 (`deleted_at`, revision +1). 이미 휴지통에 있으면 `changed: false`. 일괄 `trash`와 같은 코드다 |
| POST | `/bundles/{id}/duplicate` | `{"mode"?: "values" 또는 "structure", "name"?}` | 201, 새 번들. `mode`를 생략하거나 `null`이면 `values`, 이름을 생략하거나 비우면 `<이름> copy`. 원본의 카테고리에 두고, 배치만 실패하면 `placement_error` |
| POST | `/bundles/batch` | `{"ids", "action", 작업별 인수}` | 여러 번들에 한 작업 (아래 "여러 번들에 한 번에", 0.0.14부터) |
| GET | `/tags` | — | `{"tags": [{"name", "spellings", "active", "trash", "protected"}], "unreadable", "legacy"}`. 아래 "태그" (0.0.19부터) |
| POST | `/tags/rename` | `{"from", "to"}` (둘 다 필수) | `{"changed", "merged", "excluded", "unknown", "legacy", "warning"?}`. 쓰는 번들과 휴지통의 번들 모두에서 태그 이름을 바꾸고, `to`가 이미 있으면 합친다 |
| POST | `/tags/delete` | `{"tag"}` (필수) | `{"changed", "excluded", "unknown", "legacy", "warning"?}`. 쓰는 번들과 휴지통의 번들 모두에서 태그를 뗀다 |
| PUT | `/bundles/{id}/category` | `{"category": id 또는 null}` (키 필수, `null`은 카테고리 빼기) | `{"id", "category"}`. 쓰는 번들과 휴지통의 번들 모두. revision은 그대로다. 이미 그 상태면 아무것도 쓰지 않는다. 일괄 작업과 같은 코드다 |
| PUT | `/bundles/{id}/favorite` | `{"favorite": true 또는 false}` | `{"id", "favorite"}`. revision은 그대로다 |
| GET | `/categories` | — | `{"categories": [{"id", "name", "parent", "count"}], "revision", "state"}` |
| POST | `/categories` | `{"name", "parent"?}` | 201, `{"id", "name", "parent"}`. `parent`는 아직 받지 않는다(400 `nesting_not_supported`) |
| PATCH | `/categories/{id}` | `{"name"}` | `{"id", "name", "parent"}` |
| DELETE | `/categories/{id}` | — | `{"deleted": id, "uncategorized": 개수}`. 그 번들(휴지통의 것 포함)은 Uncategorized가 된다 |
| POST | `/bundles/{id}/restore` | — | 되살린 번들 (같은 id와 이름, revision +1) |
| POST | `/assets` | multipart의 `kind` 필드(`image`·`video`·`audio`, 없으면 `image`)와 그 뒤의 `file` 필드 | `{"asset": {"sha256", "ext", "mime", "bytes", 파일 정보…, "original_name"}}`. 새 파일이면 201, 이미 있으면 200. 크기 제한은 `kind`의 것을 쓴다 |
| GET | `/assets/{sha256}` | — | 원본. Range 요청을 받는다. `Cache-Control: immutable`, `X-Content-Type-Options: nosniff` |
| GET | `/assets/{sha256}/thumb?size=256` | — | WebP 썸네일 (이미지, 비디오 포스터) |
| GET | `/trash` | — | `{"trash": [요약과 "deleted_at"], "errors": [{"file", "id", "code", "error"}]}`. 요약의 `category`는 되살아날 카테고리다. 마지막에 지운 것부터. `errors`는 이 버전이 쓸 수 없는 파일과 옮기지 못한 옛 휴지통 파일이다 |
| DELETE | `/trash/{id}` | `expected_revision=N`(필수. `unreadable=1`이면 선택) | `{"deleted": id}`. 휴지통의 번들을 영구 삭제한다. 화면이 보여 준 revision과 다르면 409 `revision_conflict`로 남긴다. 이 버전이 완전히 읽지 못하는 파일은 `unreadable=1`이 있을 때만 지우고, 읽기 전용 번들은 휴지통에 있을 때만 지운다 |
| DELETE | `/trash` | `{"expected_revisions": {id: revision}}` | `{"deleted": 개수, "results": [번들별 결과]}`. 화면이 보여 준 번들 중 그 revision 그대로 휴지통에 있는 것만 영구 삭제한다. 그 뒤에 휴지통에 들어온 번들과 완전히 읽지 못하는 파일은 남긴다 |
| GET | `/cleanup` | — | `{"assets": [{"sha256", "kind", "ext", "bytes", "stored_at"}], "bytes", "recent", "grace_hours"}`. 아무 번들도, 휴지통의 번들도 쓰지 않는 파일. 오래된 것부터 |
| POST | `/cleanup` | `{"sha256": [GET이 보여 준 것]}` | `{"deleted", "bytes", "kept", "thumbnails"}`. 아직 쓰이지 않는 파일만 썸네일과 함께 지운다 |

목록의 요약은 필드마다 `preview`를 준다. 텍스트는 앞 200자, 이미지는
`{"sha256", "width", "height"}`, 비디오는 `{"sha256", "width", "height", "duration"}`, 오디오는
`{"sha256", "duration"}`이고 파일이 없으면 `null`이다. 나머지는 값이다. 요약에도 `warnings`와
`read_only`가 붙는다. 목록과 휴지통의 요약에는 `category`(id 또는 `null`)와 `favorite`가 있다.
정리 파일을 읽지 못하면 모두 `null`과 `false`다.

안전 정수 범위(±(2^53−1)) 밖의 정수는 브라우저가 JSON 숫자로 받으면 값이 바뀐다. 그래서 번들
응답의 정수 필드는 정확한 십진수 문자열 `value_text`를 함께 주고, 요약의 `preview`는 그 문자열이다.
`value_text`는 응답에만 있고 파일에는 쓰지 않는다.

### 여러 번들에 한 번에

`POST /bundles/batch`는 번들 여러 개에 같은 작업을 한다 (0.0.14).

```json
{"ids": ["0b0fd10b-…", "6f1c0e5a-…"], "action": "trash",
 "expected_revisions": {"0b0fd10b-…": 3, "6f1c0e5a-…": 1}}
```

| `action` | 인수 | 쓰는 것 |
| --- | --- | --- |
| `set_category` | `category`: 카테고리 id 또는 `null` | 정리 파일 한 번 |
| `set_favorite` | `favorite`: `true` 또는 `false` | 정리 파일 한 번 |
| `trash` | `expected_revisions`: 번들 id → 고를 때 본 revision | 번들 파일마다 |
| `add_tags` | `tags`: 붙일 태그 1~20개 | 바뀌는 번들 파일마다 (0.0.19부터) |
| `remove_tags` | `tags`: 뗄 태그 1~20개 | 바뀌는 번들 파일마다 (0.0.19부터) |

- 요청 전체를 먼저 검사하고, 문제가 있으면 아무것도 쓰지 않고 거부한다: `ids`가 비었거나 UUID가 아님,
  1000개 초과, 모르는 `action`(400 `invalid`), 인수 오류(`set_category`의 `category` 키가 없음 포함. 해제는
  `"category": null`. `add_tags`의 태그는 저장 규칙(이름 공통 규칙과 40자)을 따라야 하고, `remove_tags`의 태그는
  길이 제한 없이 문자열이면 된다), 없는 카테고리(404), 이 버전이 쓸 수 없는 정리 파일(409
  `organization_unwritable`), `trash`에 revision이 빠진 id(400).
- `add_tags`·`remove_tags`는 저장소 잠금 안에서 번들마다 그때 저장된 번들에 태그만 고쳐 쓴다(revision을 받지
  않는다). 다른 값은 저장된 그대로 남는다(아래 "태그"). 이미 그 상태면 쓰지 않는다. 태그가 20개를 넘게 되면서
  늘어나는 번들은 409 `too_many_tags`로 건너뛴다. 휴지통의 번들은 `in_trash`, 읽기 전용 번들은 `read_only`다.
- 단건 경로(`DELETE /bundles/{id}`, `PUT …/category`, `PUT …/favorite`)는 같은 코드를 번들 하나에 쓴다.
- `ids`의 중복은 하나로 친다. 결과는 처음 나온 순서다.
- 카테고리·즐겨찾기는 최신 정리 정보에 적용한다. 바뀌는 번들이 있을 때만 정리 파일을 한 번 쓰고
  `revision`을 1 올린다. 그 쓰기가 실패하면 바뀔 번들은 모두 실패(`io_error`)이고 파일은 그대로다.
  번들 파일과 revision은 바뀌지 않는다. 읽기 전용 번들도 된다(파일 밖의 정리이므로).
- `trash`는 저장소 잠금 안에서 id 순서로 한 번들씩 쓴다. 번들마다 `expected_revisions`와 지금 revision을
  견주고, 다르면 그 번들만 `revision_conflict`로 건너뛴다. 이미 휴지통에 있으면 변경 없는 성공이다. 한
  번들의 쓰기가 실패해도 앞의 성공은 그대로이고 뒤의 번들은 계속 처리한다. 여러 파일에 걸친 원자성은
  없다.

응답 (요청이 받아들여지면 늘 200):

```json
{"action": "trash", "changed": 1, "unchanged": 0, "failed": 1,
 "results": [
   {"id": "0b0fd10b-…", "ok": true, "changed": true, "revision": 4},
   {"id": "6f1c0e5a-…", "ok": false, "changed": false, "code": "revision_conflict", "message": "…"}]}
```

- `ok`와 `changed`로 바뀜, 변경 없는 성공(이미 그 상태), 실패를 구분한다. 변경이 없으면 파일, revision,
  시각을 건드리지 않는다. `revision`은 번들 파일을 쓴 경우의 새 revision이다. 바뀌었지만 폴더를 동기화하지
  못했으면 `warning`이 붙는다.
- 실패의 `code`는 단건 API와 같다(`not_found`, `revision_conflict`, `read_only`, `newer_version`,
  `unsupported`, `corrupt_bundle` 등)이고, 그 오류의 세부 정보(`current_revision` 등)도 담는다. 쓰기 실패는
  `io_error`이고 `"retry": true`가 붙어, 다시 시도하면 될 수 있음을 알린다. 이 버전이 바꿀 수 없는 파일은
  다시 시도해도 같다.
- 화면은 요청을 보내기 전에 대상 id와 revision을 정해 두고, 답이 올 때까지 창을 잠근다. 답이 없으면(통신
  오류나 "Stop waiting") 완료 여부를 알 수 없다고 보이고, 서버 작업을 취소한 것으로 보지 않는다.

### 태그

(0.0.19부터) 태그는 번들 내용에 있다. 두 태그는 `casefold()`가 같으면 같은 태그다: `Portrait`와
`portrait`, `Straße`와 `STRASSE`는 한 태그다. 한 번들 안에서 같은 태그는 하나만 남는다(저장할 때). 화면도
같은 기준을 따른다(`web/tags.js`의 `tagKey`, `tests/fixtures/tag_keys.json`이 양쪽을 같은 예로 검사한다).

태그를 바꾸는 작업(일괄 `add_tags`·`remove_tags`, `/tags/rename`, `/tags/delete`)은 번들 전체를 다시 검사하지
않고 태그만 고친다. 그래서 그 뒤 엄격해진 규칙에 맞지 않는 값(안전 범위 밖의 정수, 41자 태그, 21개 태그 등)은
저장된 그대로 남는다. 새로 붙이는 태그와 새 이름은 저장 규칙을 따르고, 찾는 태그(`from`, 뗄 태그)는 길이
제한 없이 이름을 적을 수 있다. 태그가 20개를 넘게 되는 변경은 이미 그보다 많던 번들에서도 늘리지 않는
경우(바꾸기·떼기)만 한다. 실제로 바뀐 번들만 revision을 1 올리고 `updated_at`을 바꾼다. 형식 1의 파일은
다른 쓰기처럼 형식 2로 쓴다. 노드의 캐시 키에는 태그가 들어가지 않는다.

- `GET /tags`는 이 버전이 읽을 수 있는 번들 파일(쓰는 것과 휴지통의 것)의 태그를 태그마다 하나로 센다. `name`은
  가장 많은 번들이 쓰는 표기이고 `spellings`는 쓰이는 표기 모두다. `active`·`trash`는 그 태그가 있는 번들 수,
  `protected`는 그중 이 버전이 바꿀 수 없는 번들 수다. `unreadable`은 이 버전이 읽지 못하는 번들 파일 수(어떤
  태그가 있는지 모른다), `legacy`는 옛 휴지통 폴더에 남은 파일 수(바꾸지 않는다)다.
- `POST /tags/rename`은 `from`이 있는 모든 번들에서 그 태그를 `to`로 바꾼다. 같은 번들에 `to`도 있으면 둘 중
  앞에 있던 자리에 `to` 하나만 남긴다(합치기, `merged`로 센다): `["Flowers", "old"]`에 `old → flowers`는
  `["flowers"]`다. 대소문자만 바꿀 수도 있고, 이미 정확히 그 표기인 번들은 건드리지 않는다. `from`과 `to`가
  같으면 400이다.
- `POST /tags/delete`는 그 태그가 있는 모든 번들에서 태그를 뗀다. 번들은 그대로다.
- 두 작업 모두 저장소 잠금 안에서 번들마다 따로 쓴다. 한 번들의 쓰기가 실패해도 앞의 변경은 그대로이고 뒤의
  번들은 계속 처리한다. `changed`는 바뀐 번들 수다. `excluded`는 그 태그가 있지만 남긴 번들
  `[{"id", "name", "code", "reason", "retry"?}]`(이 버전이 바꿀 수 없음, 또는 쓰기 실패 `io_error`와 `retry`),
  `unknown`은 읽지 못해 그 태그가 있는지 모르는 파일 `[{"file", "reason"}]`이다. 모르는 파일은 일치한 것으로
  세지 않는다. 폴더를 동기화하지 못한 쓰기가 있으면 `warning`이 붙는다.
- 화면에서는 태그 메뉴 아래의 "Manage tags…"가 여는 Tags 칸에서 이름 바꾸기·합치기·지우기를 한다. 무엇이
  얼마나 바뀌는지(휴지통 포함, 합쳐지는 수, 바꿀 수 없는 번들, 읽지 못하는 파일) 먼저 보이고 확인받는다. 걸려
  있던 태그 필터는 새 이름을 따른다. 다른 탭에서 바뀐 번들은, 편집기에 변경이 없으면 목록을 다시 읽을 때 새
  내용으로 바뀌고, 변경이 있으면 저장할 때 revision 충돌로 묻는다(덮어쓰면 그 초안의 태그가 돌아온다).

### 오류

오류 본문은 `{"error": {"code", "message", ...}}`이다. `message`는 화면에 그대로 보여 줄 수
있는 영어 문장이고, 파일 경로를 담지 않는다. 프로그램은 `code`로 경우를 구분한다.

| 상태 | `code` | 경우 |
| --- | --- | --- |
| 400 | `invalid` | 값이나 형식이 규칙에 맞지 않음 |
| 400 | `invalid_id` | 번들·카테고리 UUID나 에셋 SHA-256 형식이 아님 |
| 400 | `nesting_not_supported` | 카테고리 안에 카테고리를 만들려 함 |
| 400 | `invalid_json` | JSON을 읽을 수 없음 |
| 400 | `unsupported_type` | 지원하지 않는 필드 타입 |
| 400 | `unknown_asset` | 올린 적 없는 파일을 가리킴 |
| 400 | `wrong_kind` | 파일의 종류가 필드 타입과 다름 (예: `video` 필드의 이미지) |
| 400 | `corrupt_image`, `corrupt_media` | 이미지나 오디오를 끝까지, 또는 비디오의 첫 프레임을 디코딩할 수 없음 |
| 403 | `missing_header`, `cross_site`, `origin_mismatch` | 쓰기 요청의 조건 위반 |
| 404 | `not_found` | 번들, 카테고리나 파일이 없음, 오디오의 썸네일 |
| 404 | `in_trash` | 번들이 휴지통에 있음 (되살리면 쓸 수 있다) |
| 409 | `revision_conflict` | `expected_revision`이 현재와 다름. `current_revision`을 함께 준다 |
| 409 | `in_trash`, `not_in_trash` | 휴지통의 번들을 고치거나 지우거나 복제하려 함 / 쓰는 번들을 되살리거나 영구 삭제하려 함 |
| 409 | `read_only` | 이 버전이 모르는 데이터가 있어 고칠 수 없는 번들 |
| 409 | `too_many_tags` | 태그를 붙이면 번들의 태그가 20개를 넘음 (일괄 결과의 번들별 `code`, 0.0.19부터) |
| 409 | `category_conflict` | 같은 이름(대소문자 무시)의 카테고리가 있음 |
| 409 | `organization_unwritable` | 이 버전이 바꿀 수 없는 정리 파일. `state`를 함께 준다 |
| 409 | `newer_version`, `unsupported` | 더 새 버전이 저장한 파일 / 다른 형식이나 모르는 필드 타입의 파일 |
| 409 | `unreadable_file` | 완전히 읽지 못하는 파일을 `unreadable=1` 없이 영구 삭제하려 함 |
| 409 | `unreadable_bundles` | 완전히 읽지 못하는 번들 파일이 있어 쓰이지 않는 파일을 가릴 수 없음. `files`에 파일 이름을 준다 |
| 409 | `version_mismatch` | 화면과 서버의 버전이 다름 |
| 413 | `too_large`, `too_many_pixels`, `too_long`, `too_many_samples` | 본문·파일 크기, 픽셀 수, 오디오 길이, 오디오 샘플 수 초과 |
| 415 | `unsupported_media_type`, `unsupported_format` | 본문 형식이 맞지 않음, 허용하지 않는 파일 형식이거나 필드와 종류가 다른 파일 |
| 500 | `io_error` | 라이브러리 폴더를 읽거나 쓰지 못함. `"retry": true` (0.0.16부터) |
| 500 | `corrupt_bundle`, `internal` | 번들 파일을 읽을 수 없음, 그 밖의 서버 오류 (자세한 내용은 ComfyUI 로그) |

## 호환성 정책

노드가 바뀌어도 옛 라이브러리와 워크플로가 계속 동작하고, 옛 노드가 새 파일을 망가뜨리지 않게 하는
규칙이다 (Phase 7.5, 2026-10-16). 출시된 형식의 표본과 기대 동작은 `tests/fixtures/compat/`에 있고,
`tests/test_compat.py`와 `tests/browser/compat_scenarios.cjs`가 확인한다.

### 버전 표지

| 표지 | 뜻 | 올리는 때 |
| --- | --- | --- |
| 번들 파일의 `schema_version` (지금 2) | 번들 파일의 형식 | 옛 노드가 완전히 이해하지 못하는 변경: 키, 필드 타입, 에셋 종류, 파일 참조 구조를 더하거나 바꿀 때. 마이그레이션 단계를 함께 더한다 |
| 정리 파일의 `schema_version` (지금 1) | `organization.json`의 형식 | 옛 노드가 완전히 이해하지 못하는 변경: 중첩 카테고리를 열거나 키를 더할 때 |
| 워크플로 `slot_spec`의 `v` (지금 1) | 노드 출력의 기록 형식 | 출력 기록의 모양을 바꿀 때 |
| API 접두어 `/v1` | HTTP API | 화면 밖의 클라이언트가 생겨 호환되지 않게 바꿀 때 |
| 패키지 버전 (`pyproject.toml`) | 출시 | 출시할 때마다. `bundle_library/constants.py`와 `web/version.js`의 사본은 `tests/test_versions.py`가 같게 지킨다 |

### 약속

- **업그레이드**: 0.0.11부터 모든 출시는 이전 출시가 쓴 번들 파일(지원하는 `format`에
  `schema_version`이 1 이상 현재 이하)과 `slot_spec`(v1부터)을 읽고 실행한다. 다만 실행할 때의
  자원 제한(오디오 길이·샘플 수 등)은 그때 버전의 제한을 따른다.
- **읽기는 메모리에서만 변환한다**: 조회, 목록, 실행은 옛 버전을 메모리에서 현재 버전으로 올리고
  파일을 다시 쓰지 않는다. 현재 버전으로 쓰는 것은 저장, 휴지통으로 지우기, 되살리기다. 지우기와
  되살리기는 내용을 바꾸지 않으므로 아래의 작성 규칙을 다시 따지지 않는다.
- **손실 없는 거부**: 이 버전이 완전히 이해하지 못하는 파일(아래의 읽기 전용, 새 버전, 미지원, 손상)은
  바이트를 바꾸지 않는다. 사용자가 그 파일을 골라 명시적으로 영구 삭제하는 것만 허용하고, 그런 파일이
  하나라도 있으면 쓰이지 않는 파일의 정리를 거부한다.
- **다운그레이드**: 이 보호는 0.0.11부터 있다. 0.0.11부터 저장한 번들은 버전 2라서 0.0.10 이하는
  손상으로 보고 쓰지 못한다. 되돌릴 때는 올리기 전의 백업을 쓰고, 0.0.10 이하의 노드에서는 정리와
  휴지통 비우기를 하지 않는다 (그 버전은 이 보호가 없다).

### 세 가지 검사

| 검사 | 내용 | 읽을 때 | 저장할 때 |
| --- | --- | --- | --- |
| 구조 불변식 | id 형식과 파일 이름, revision, `deleted_at`, 비어 있지 않고 겹치지 않는 필드 이름, `@` 예약, 이름의 금지 문자, 필드 타입, 값의 자료형, 유한한 실수, SHA-256 형식 | 어기면 손상 | 거부 |
| 작성 규칙 | 이름·태그·메모 길이, 태그 수, 필드 수, 텍스트 크기, 정수 범위 | 경고 (나중에 좁아진 규칙일 수 있다) | 거부 |
| 실행 제한 | 오디오 디코딩 제한, 출력 32개 | — | 실행할 때 구체적인 오류 |

### 상태와 작업

| 상태 (`code`) | 뜻 | 목록·편집기 | 노드 실행 |
| --- | --- | --- | --- |
| 정상 | 지원 형식이고 모든 검사를 통과한다 | 그대로 | 쓰는 번들이면 실행 |
| 경고 | 불변식은 지키지만 작성 규칙을 넘는 값이 있다 | `warnings`. 편집기는 처음부터 표시하고 고치기 전에는 저장하지 않는다 | 쓰는 번들이면 실행 |
| 읽기 전용 | 지원 스키마인데 어디에든 모르는 키가 있다 | `read_only`. 쓰기를 모두 막는다 | 쓰는 번들이면 실행 |
| 새 버전 (`newer_version`) | 지원 형식이고 `schema_version`이 현재보다 크다 | `errors` | 오류 |
| 미지원 (`unsupported`) | 모르는 `format`, 또는 모르는 필드 타입 | `errors` | 오류 |
| 손상 (`corrupt`) | JSON이 아니거나 불변식을 어기거나 표지가 잘못됐다(`true`, `1.0`) | `errors` | 오류 |

| 작업 | 정상 | 경고 | 읽기 전용·새 버전·미지원 | 손상 |
| --- | --- | --- | --- | --- |
| 편집 저장 | 허용 | 값을 고친 뒤 허용 | 거부 | 거부 |
| 복제 | 허용 | 거부 (작성 규칙) | 거부 | 거부 |
| 휴지통으로 지우기, 되살리기 | 허용 | 허용 | 거부 | 거부 |
| 하나 영구 삭제 | 휴지통에 있고 본 revision 그대로일 때 | 같음 | 읽기 전용은 휴지통에 있을 때 `unreadable=1`로만, 새 버전·미지원은 `unreadable=1`로만 | `unreadable=1`로만 |
| 휴지통 비우기 | 화면이 보여 준 것 중 그대로인 것을 지운다 | 같음 | 건드리지 않는다 | 건드리지 않는다 |
| 쓰이지 않는 파일 정리 | 참조를 지킨다 | 같음 | 하나라도 있으면 거부 | JSON이 아니면 거부, 알려진 버전의 필드가 읽히면 참조를 지킨다 |

### 워크플로와 노드

- 노드의 입력은 끝에만 더한다. 워크플로는 위젯 값을 위치 순서로 저장한다.
- 노드의 캐시 키는 출력이 내보내는 것(슬롯의 이름과 타입, 필드의 값이나 파일 SHA-256)만으로 만든다.
  번들 이름·메모·태그·revision·카테고리·즐겨찾기만 바꾸면 Load Bundle과 그 뒤의 노드가 다시 실행되지
  않는다 (0.0.12부터). 채울 수 없는 슬롯은 그 이유로 키에 들어가, 빈 미디어 필드가 있는 번들도 캐시된다.
  그런 슬롯이 연결되지 않았으면 출력은 이유를 담은 `ExecutionBlocker`라, 캐시된 실행 뒤에 나중에 연결한 노드는
  그 이유로 멈춘다(ComfyUI는 그 실행을 성공으로 기록한다). 처음부터 연결했으면 지금처럼 Load Bundle이 실패한다
  (0.0.18부터).
- 출력 풀(32개)은 늘리기만 한다. 줄이면 옛 워크플로의 링크가 끊긴다.
- 지운 필드 타입 이름이나 키 이름을 다른 뜻으로 다시 쓰지 않는다.
- 이 버전이 읽지 못하는 `slot_spec`(더 새 버전의 출력 타입 등)을 가진 노드는 저장된 출력, 링크,
  `slot_spec`을 그대로 두고 안내를 보이며, 다른 번들을 고르지 않는다.
- 화면과 서버의 버전이 다르면(파일만 바꾸고 재시작하지 않았거나, 재시작 전부터 열어 둔 페이지)
  화면이 원인에 맞게 "restart ComfyUI" 또는 "reload the page"를 안내하고, 서버는 그 화면의 쓰기를
  거부한다.

