# 데이터 형식과 API

Bundle Library가 디스크에 저장하는 형식과 HTTP API를 정리한다. 구현은
`bundle_library/model.py`(검증), `store.py`(번들), `assets.py`(미디어), `routes.py`(API)에 있다.

## 저장 위치

ComfyUI 사용자 디렉토리 아래 `bundle_library/`를 쓴다. comfy-docker 구성에서는 호스트의
`user/bundle_library/`이다. 처음 API를 호출할 때 만들어진다.

```text
bundle_library/
├── bundles/<uuid>.json                        # 번들 하나에 파일 하나
├── assets/sha256/<해시 앞 2자리>/<sha256>.<ext>    # 올린 원본, 바이트 그대로
├── thumbs/<해시 앞 2자리>/<sha256>_<크기>.webp     # 다시 만들 수 있는 미리보기
├── trash/<uuid>.<UTC 시각>.json                # 지운 번들
└── tmp/                                       # 쓰는 중인 파일. 열 때 비운다
```

- 백업 대상은 `bundles/`, `assets/`, `trash/`다. `thumbs/`와 `tmp/`는 백업하지 않아도 된다.
- 이 폴더에는 ComfyUI 프로세스 하나만 쓴다. 다른 프로세스가 같은 폴더를 열면 쓰는 중인
  임시 파일을 지울 수 있다.
- 번들 파일을 손으로 고치면 다음 목록 조회 때 반영된다. 형식이 틀린 파일은 건너뛰고
  목록의 `errors`와 `/health`의 `corrupt`에 보고한다.

## 번들 파일

```json
{
  "format": "comfyui-bundle-library/bundle",
  "schema_version": 1,
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
  "updated_at": "2026-10-14T01:32:24.101Z"
}
```

| 키 | 설명 |
| --- | --- |
| `id` | UUID. 파일 이름과 같아야 한다. 워크플로는 이 값으로 번들을 가리킨다 |
| `revision` | 1부터 시작해 저장할 때마다 1씩 오른다 |
| `name` | 라이브러리 안에서 대소문자와 관계없이 고유하다 |
| `fields` | 순서가 있는 배열. 순서는 로더에서 처음 고를 때의 출력 순서다 |
| `created_at`, `updated_at` | UTC, 밀리초까지 |

## 필드

| `type` | 값 | 로더 출력 | 규칙 |
| --- | --- | --- | --- |
| `text` | `value`: 문자열 | STRING | 빈 값 허용. 공백·개행을 바꾸지 않는다. UTF-8로 1MB까지 |
| `image` | `asset`: 객체 또는 `null` | IMAGE | `asset.sha256`은 먼저 올린 이미지 파일이어야 한다 |
| `video` | `asset`: 객체 또는 `null` | VIDEO | 먼저 올린 비디오 파일. core Load Video처럼 파일을 그대로 넘기고, 쓰일 때 디코딩한다 |
| `audio` | `asset`: 객체 또는 `null` | AUDIO | 먼저 올린 오디오 파일. core Load Audio처럼 전부 디코딩해 `{"waveform": [1, 채널, 샘플], "sample_rate"}`로 내보낸다 |
| `boolean` | `value`: `true`/`false` | BOOLEAN | 0·1은 받지 않는다 |
| `int` | `value`: 정수 | INT | 64비트 범위. `true`/`false`는 받지 않는다 |
| `float` | `value`: 숫자 | FLOAT | 유한값만 |

- 파일 필드(`image`, `video`, `audio`)의 `asset`에는 `sha256`과 표시용 `original_name` 말고도
  파일 정보가 들어 있다. 저장할 때 서버가 파일에서 다시 채우고, 클라이언트가 보낸 값은 쓰지
  않는다.
  - 공통: `ext`, `bytes`
  - `image`: `width`, `height` (EXIF 방향을 적용해 보이는 크기)
  - `video`: `width`, `height`, `fps`, `duration`(초), `codec`, `has_audio`, 소리가 있으면
    `audio_codec`
  - `audio`: `duration`(초), `sample_rate`, `channels`, `codec`
- 파일의 종류는 필드 타입과 같아야 한다. 이미지 파일을 `video` 필드에 넣으면 `wrong_kind`로
  거부한다.
- 필드 이름은 번들 안에서 고유하다. 대소문자를 구분하는데, 로더가 이름을 그대로 비교하기
  때문이다. `@`로 시작하는 이름은 앞으로의 가상 필드(번들 이름 출력 등)를 위해 예약했다.

## 이름 규칙과 제한

| 항목 | 규칙 |
| --- | --- |
| 이름 공통 (번들, 필드, 태그) | 앞뒤 공백을 지우고 NFC로 정규화한다. 줄바꿈, 제어 문자, 방향 제어 문자는 쓸 수 없다 |
| 번들 이름 | 120자 |
| 필드 이름 | 64자 |
| 태그 | 20개, 각 40자. 대소문자만 다른 태그는 하나로 합친다 |
| 메모 | 10,000자 |
| 필드 수 | 32개 (로더 출력 수와 같다) |
| JSON 요청 본문 | 4MB |
| 이미지 | PNG, JPEG, WebP. 파일 50MB, 6,400만 픽셀 |
| 비디오 | MP4, WebM(VP8·VP9·AV1과 Opus·Vorbis), MOV. 파일 1GB, 프레임당 7680×4320 픽셀 |
| 오디오 | WAV, FLAC, MP3, OGG(Opus·Vorbis), M4A. 파일 200MB, 길이 10분 |
| 썸네일 크기 | 128, 256, 512 |

## 에셋

- 확장자와 MIME 타입을 믿지 않는다.
  - 이미지는 Pillow의 PNG·JPEG·WebP 디코더로만 열어 끝까지 디코딩해 본다.
  - 비디오와 오디오는 PyAV로 열어 컨테이너와 코덱을 확인하고 첫 프레임을 디코딩해 본다.
    MP4·MOV·M4A는 같은 형식(ISO 미디어)이라 브랜드와 스트림으로 구분한다. 브랜드가 `qt`면
    MOV, 비디오 스트림이 있으면 MP4, 소리만 있으면 M4A다. MP3·M4A의 앨범 그림은 비디오로 보지
    않는다.
  - 허용하지 않는 형식이나 종류가 다른 파일은 415, 깨진 파일은 400, 픽셀 수·길이 초과는 413이다.
- 원본 바이트를 바꾸지 않고 SHA-256 이름으로 저장한다. 같은 내용을 다시 올리면 기존 파일을
  쓴다.
- 지운 번들이 쓰던 파일도 남겨 둔다. 쓰이지 않는 파일 정리는 다음 단계의 관리 기능이다.
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

JSON 본문은 `Content-Type: application/json`이어야 한다 (415).

### 엔드포인트

| 메서드 | 경로 | 요청 | 응답 |
| --- | --- | --- | --- |
| GET | `/health` | — | `{"version", "bundles", "corrupt": [파일 이름], "writable"}` |
| GET | `/bundles` | `q`(이름·태그·필드 이름·텍스트 값 검색), `tag`, `sort`(`name`/`updated`) | `{"bundles": [요약], "errors": [{"file", "error"}]}` |
| POST | `/bundles` | `{"name", "tags", "note", "fields"}` | 201, 번들 |
| GET | `/bundles/{id}` | — | 번들 |
| PUT | `/bundles/{id}` | `{"expected_revision", "name", "tags", "note", "fields"}` | 번들 (revision +1) |
| DELETE | `/bundles/{id}?expected_revision=N` | — | `{"deleted": id}`. 파일은 `trash/`로 옮긴다 |
| POST | `/bundles/{id}/duplicate` | `{"mode": "values" 또는 "structure", "name"?}` | 201, 새 번들. 이름을 비우면 `<이름> copy`, 이미 있으면 `<이름> copy 2` … |
| POST | `/assets` | multipart의 `kind` 필드(`image`·`video`·`audio`, 없으면 `image`)와 그 뒤의 `file` 필드 | `{"asset": {"sha256", "ext", "mime", "bytes", 파일 정보…, "original_name"}}`. 새 파일이면 201, 이미 있으면 200. 크기 제한은 `kind`의 것을 쓴다 |
| GET | `/assets/{sha256}` | — | 원본. Range 요청을 받는다. `Cache-Control: immutable`, `X-Content-Type-Options: nosniff` |
| GET | `/assets/{sha256}/thumb?size=256` | — | WebP 썸네일 (이미지, 비디오 포스터) |

목록의 요약은 필드마다 `preview`를 준다. 텍스트는 앞 200자, 이미지는
`{"sha256", "width", "height"}`, 비디오는 `{"sha256", "width", "height", "duration"}`, 오디오는
`{"sha256", "duration"}`이고 파일이 없으면 `null`이다. 나머지는 값이다.

### 오류

오류 본문은 `{"error": {"code", "message", ...}}`이다. `message`는 화면에 그대로 보여 줄 수
있는 영어 문장이고, 파일 경로를 담지 않는다. 프로그램은 `code`로 경우를 구분한다.

| 상태 | `code` | 경우 |
| --- | --- | --- |
| 400 | `invalid` | 값이나 형식이 규칙에 맞지 않음 |
| 400 | `invalid_id` | 번들 UUID나 에셋 SHA-256 형식이 아님 |
| 400 | `invalid_json` | JSON을 읽을 수 없음 |
| 400 | `unsupported_type` | 지원하지 않는 필드 타입 |
| 400 | `unknown_asset` | 올린 적 없는 파일을 가리킴 |
| 400 | `wrong_kind` | 파일의 종류가 필드 타입과 다름 (예: `video` 필드의 이미지) |
| 400 | `corrupt_image`, `corrupt_media` | 이미지를 끝까지, 또는 비디오·오디오의 첫 프레임을 디코딩할 수 없음 |
| 403 | `missing_header`, `cross_site`, `origin_mismatch` | 쓰기 요청의 조건 위반 |
| 404 | `not_found` | 번들이나 파일이 없음, 오디오의 썸네일 |
| 409 | `name_conflict` | 같은 이름의 번들이 있음 |
| 409 | `revision_conflict` | `expected_revision`이 현재와 다름. `current_revision`을 함께 준다 |
| 413 | `too_large`, `too_many_pixels`, `too_long` | 본문·파일 크기, 픽셀 수, 오디오 길이 초과 |
| 415 | `unsupported_media_type`, `unsupported_format` | 본문 형식이 맞지 않음, 허용하지 않는 파일 형식이거나 필드와 종류가 다른 파일 |
| 500 | `corrupt_bundle`, `internal` | 번들 파일을 읽을 수 없음, 그 밖의 서버 오류 (자세한 내용은 ComfyUI 로그) |
