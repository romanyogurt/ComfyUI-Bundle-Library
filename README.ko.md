# ComfyUI용 Bundle Library

함께 쓰는 프롬프트, 그림, 동영상, 오디오, 설정값을 이름 붙인 **번들**로 묶어 두고, 노드 하나로 원하는 번들을
불러와 보세요. 번들만 바꾸면 같은 워크플로가 그 번들의 프롬프트와 그림, 설정으로 실행됩니다.

[English](README.md) | 한국어

![Load Bundle 노드 하나가 예제 번들을 바꿀 때마다 출력이 그 번들의 필드에 맞춰 바뀝니다: 그림과 설정, 동영상과 오디오, 숫자와 스위치, 그림 두 장](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/outputs-follow-the-bundle.gif)

## 소개

같은 워크플로를 입력만 바꿔 가며 돌리는 일이 많습니다. 레퍼런스 그림과 프롬프트를 갖춘 캐릭터, 또 다른 캐릭터,
장소, 화풍, 목소리처럼요. Bundle Library는 이런 묶음을 ComfyUI 서버의 라이브러리에 번들로 보관하고, **Load
Bundle** 노드가 고른 번들을 워크플로에 넣어 줍니다. 노드의 출력은 번들의 필드를 그대로 따라서, 필드마다 같은
이름의 출력이 생깁니다. 필드 이름과 타입이 같은 번들끼리는 연결을 그대로 쓰기 때문에, 번들을 바꾸는 데는 클릭 한
번이면 충분합니다.

워크플로 안에 값을 넣어 두는 방식과 달리, 번들은 따로 마련된 라이브러리에 보관됩니다. 전용 창에서 만들고 고치며,
검색과 태그, 카테고리로 찾을 수 있고, 여러 워크플로에서 함께 쓰거나 ZIP 파일로 다른 컴퓨터에 옮길 수도 있습니다.

## 주요 기능

- **번들을 따라가는 출력**: Load Bundle은 고른 번들의 필드마다 출력을 만듭니다. 필드 구성이 같은 번들로 바꾸면
  연결이 그대로 유지되고, 사용자도 모르는 사이에 출력이 다시 짜이는 일은 없습니다.
- **텍스트, 숫자, 스위치, 그림, 동영상, 오디오**: 일곱 가지 필드 타입을 지원합니다. 그림과 동영상, 오디오는
  ComfyUI의 Load Image, Load Video, Load Audio와 같은 방식으로 불러옵니다.
- **라이브러리 창**: 번들을 만들고 고치는 것은 물론, 검색과 정렬, 태그 필터, 카테고리, 즐겨찾기를 쓸 수 있고 여러
  번들을 한꺼번에 다룰 수도 있습니다.
- **안전한 편집**: 저장하지 않은 변경은 따로 보관되고, 다른 곳에서 저장한 내용을 모르고 덮어쓰는 일이 없습니다.
  지운 번들은 휴지통으로 가서 언제든 되살릴 수 있고, 파일은 온전히 저장되거나 아예 저장되지 않거나 둘 중 하나입니다.
- **파일은 한 번만 보관**: 여러 번들이 같은 그림이나 동영상, 오디오를 써도 파일은 한 번만 저장되며, 라이브러리에
  있는 파일을 골라 다시 쓸 수 있습니다. 쓰지 않는 파일은 원할 때만 정리합니다.
- **가져오기와 내보내기**: 번들을 파일과 함께 ZIP으로 묶어 다른 라이브러리로 옮길 수 있고, 워크플로는 옮긴 번들을
  그대로 찾습니다.
- **영어와 한국어**: ComfyUI의 언어 설정을 따르며, 다른 언어를 더할 수도 있습니다.
- **HTTP API**: 스크립트나 AI 에이전트도 번들을 만들고, 고치고, 쓸 수 있습니다.

## 설치

ComfyUI 0.38.0 이상과 프런트엔드 1.53.10 이상이 필요합니다. ComfyUI가 설치하는 것 말고는 따로 필요한 패키지가
없습니다.

- **ComfyUI-Manager**: **Bundle Library**를 검색해 설치합니다.
- **comfy-cli**: `comfy node install bundle-library`
- **직접 설치**:

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/romanyogurt/ComfyUI-Bundle-Library
  ```

설치한 뒤에는 ComfyUI를 다시 시작하고 브라우저 페이지를 새로 고쳐 주세요. 첫 공개 버전들이 여러 환경에서
검증되는 동안에는 노드에 BETA 표시가 붙습니다.

## 빠른 시작

예제 워크플로 하나와, 그 워크플로에 맞춘 번들 네 개, 다른 종류의 필드를 보여 주는 번들 세 개가 함께 들어 있습니다.

1. **예제 열기**: **Workflow → Browse Templates**에서 **z-image-turbo**를 검색하세요. 번들의 프롬프트로 그림을
   만들거나, 번들의 그림에서 출발해(이미지에서 이미지로) Z-Image Turbo로 새 그림을 만드는 워크플로입니다. 필요한
   모델과 넣을 폴더는 워크플로 안의 메모에 적혀 있습니다.
2. **예제 번들 가져오기**: 사이드바의 상자 아이콘에서 **Open library**를 눌러 라이브러리를 엽니다. 라이브러리가
   비어 있으면 **Import the examples** 버튼이 보이니, 누른 다음 **Import 7 bundles**를 누르세요.
3. **실행하기**: 워크플로의 Load Bundle 노드에서 번들을 골라 실행합니다. 다른 번들로 바꿔 다시 실행해 보세요.

![같은 워크플로를 예제 번들마다 실행하면, 워크플로로 들어가는 그림과 프롬프트가 번들에 따라 바뀝니다](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/one-workflow-many-bundles.gif)

**Field types** 카테고리의 번들 세 개는 필드 구성이 서로 다릅니다(동영상과 오디오, 숫자와 스위치, 그림 두 장).
Load Bundle 노드에서 골라 보면 출력이 번들에 맞춰 바뀌는 모습을 볼 수 있습니다.

나만의 번들을 만들려면, 예제 하나를 고른 뒤 **Duplicate → Duplicate with values**로 복제하고 프롬프트와 그림을
바꿔 저장하세요. 필드가 같으니 같은 워크플로에서 바로 쓸 수 있습니다. 더 자세한 내용은
[Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Getting-started.md)(영어)를
참고하세요.

![라이브러리 창: 묶음별로 정리된 예제 번들 일곱 개와, 동영상·오디오·텍스트를 담은 Sunset loop를 연 편집기](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/library-window.png)

## 문서

자세한 설명은 모두 [문서](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Home.md)(영어)에
있습니다.

- **사용법**: [Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Getting-started.md),
  [Bundles and fields](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Bundles-and-fields.md),
  [The Load Bundle node](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/The-Load-Bundle-node.md),
  [The library window](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/The-library-window.md),
  [Import and export](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Import-and-export.md),
  [Images, video and audio](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Images-video-and-audio.md),
  [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Data-and-backups.md),
  [FAQ and troubleshooting](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/FAQ-and-troubleshooting.md)
- **참조**: [HTTP API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/HTTP-API.md),
  [File formats](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/File-formats.md),
  [Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Compatibility-and-versions.md),
  [Automating with the API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Automating-with-the-API.md)
- **기여**: [Translations](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Translations.md),
  [Reporting problems](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Reporting-problems.md)

AI 에이전트를 위해서는 [`llms.txt`](llms.txt)가 이 문서들의 텍스트 버전을 안내합니다.

## 업데이트

버전마다 바뀐 내용은 [변경 기록](CHANGELOG.md)(영어)과
[릴리스 페이지](https://github.com/romanyogurt/ComfyUI-Bundle-Library/releases)에서 확인하실 수 있습니다.

업데이트할 때는 먼저 라이브러리 폴더(`ComfyUI/user/bundle_library/`)를 백업해 두세요. 그런 다음 노드 팩을
업데이트하고, ComfyUI를 다시 시작한 뒤 페이지를 새로 고치면 됩니다. 업데이트한 뒤에도 번들과 워크플로는 그대로
동작합니다. 자세한 내용은
[Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Compatibility-and-versions.md)를
참고하세요.

## 알아 두실 점

- 라이브러리는 ComfyUI 서버에 있으며, ComfyUI와 마찬가지로 따로 로그인 절차가 없습니다. 다른 컴퓨터에서도
  ComfyUI에 접속할 수 있게 설정했다면(`--listen`) 라이브러리도 함께 열리므로, 믿을 수 있는 네트워크에서만 사용해
  주세요.
- `--multi-user`로 실행하면 모든 사용자가 라이브러리 하나를 함께 씁니다.

더 자세한 내용은 [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Data-and-backups.md)를
참고하세요.

## 라이선스

Bundle Library는 [MIT 라이선스](LICENSE)로 배포됩니다. 다만 일부 예제 자료는 원래의 라이선스를 따릅니다. ComfyUI의
예제 그림(GPL-3.0)과, Comfy-Org의 Z-Image Turbo 템플릿에서 가져온 부분(MIT)이 그렇습니다. 그 밖의 예제 그림은 이
팩을 위해 Z-Image Turbo로 만들었고, 예제 동영상은 그중 한 장으로, 예제 소리는 합성해서 만들었습니다. 자세한 내용은
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 확인해 주세요.
