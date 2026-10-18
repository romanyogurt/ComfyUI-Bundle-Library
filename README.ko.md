# ComfyUI용 Bundle Library

함께 쓰는 프롬프트·그림·동영상·오디오·설정을 이름 붙은 **번들**로 보관하고, 노드 하나로 아무 번들이나
불러온다. 번들만 바꾸면 같은 워크플로가 그 번들의 프롬프트·그림·설정으로 실행된다.

[English](README.md) | 한국어

![Load Bundle에서 번들을 바꿔 실행하면 워크플로로 가는 그림과 프롬프트가 번들을 따른다](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/load-bundle.gif)

## 개요

워크플로는 같은 그래프를 다른 입력으로 자주 실행한다. 레퍼런스 그림과 프롬프트를 가진 캐릭터 하나, 제 것을 가진
다른 캐릭터, 장소, 화풍, 목소리. Bundle Library는 그런 묶음 하나하나를 ComfyUI 서버의 라이브러리에 번들로 두고,
**Load Bundle** 노드가 고른 번들을 워크플로에 넣는다. 노드의 출력은 번들을 따른다: 필드마다 출력이 하나 있고,
이름도 필드의 이름이다. 필드의 이름과 타입이 같은 번들은 같은 연결을 채우므로, 번들을 바꾸는 일은 한 번의 클릭이다.

워크플로 안에 저장한 값과 달리, 번들은 제 라이브러리에 산다. 전용 창에서 만들고 고치며, 검색·태그·카테고리로
찾고, 여러 워크플로가 함께 쓰고, ZIP 파일로 다른 컴퓨터에 옮긴다.

## 기능

- **노드 하나, 번들을 따르는 출력.** Load Bundle은 고른 번들의 필드마다 출력을 둔다. 필드가 같은 번들로 바꾸면
  연결이 그대로이고, 모르는 사이에 다시 짜이는 것은 없다.
- **텍스트, 숫자, 스위치, 그림, 동영상, 오디오.** 필드 타입 일곱 가지. 미디어는 ComfyUI의 Load Image·Load
  Video·Load Audio와 같은 방식으로 불러온다.
- **라이브러리 창.** 번들을 만들고 고치며, 검색·정렬·태그 필터·카테고리·즐겨찾기를 쓰고, 여러 번들을 한 번에
  다룬다.
- **안전한 편집.** 저장하지 않은 초안은 따로 두고, 다른 곳에서 저장한 변경을 조용히 덮어쓰지 않으며, 지운 번들은
  되살릴 수 있는 휴지통으로 가고, 파일은 통째로 쓰이거나 전혀 쓰이지 않는다.
- **파일은 한 번만 보관.** 그림·동영상·오디오 파일은 몇 번들이 쓰든 한 번만 보관하고, 라이브러리에서 다시 골라 쓸
  수 있다. 쓰이지 않는 파일은 요청할 때만 정리한다.
- **가져오기와 내보내기.** 번들을 파일과 함께 ZIP으로 다른 라이브러리에 옮긴다. 워크플로는 계속 그 번들을 찾는다.
- **영어와 한국어.** ComfyUI의 언어 설정을 따르고, 언어를 더할 수 있다.
- **HTTP API.** 스크립트와 AI 에이전트도 번들을 만들고 고치고 쓸 수 있다.

## 설치

ComfyUI 0.38.0 이상, 그 프런트엔드 1.53.10 이상이 필요하다. ComfyUI가 설치하는 것 말고는 필요한 것이 없다.

- **ComfyUI-Manager**: **Bundle Library**를 검색해 설치한다.
- **comfy-cli**: `comfy node install bundle-library`
- **직접**:

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/romanyogurt/ComfyUI-Bundle-Library
  ```

그다음 ComfyUI를 다시 시작하고 브라우저 페이지를 새로 고친다. 첫 공개 출시들이 더 많은 환경을 거치는 동안 노드에는
BETA 표시가 붙는다.

## 빠른 시작

예제 워크플로 하나와 그에 맞춘 번들 네 개가 함께 들어 있다.

1. **예제 열기.** **Workflow → Browse Templates**에서 **z-image-turbo**를 검색한다. 번들의 프롬프트로, 또는 번들의
   그림에서 시작해(이미지에서 이미지로) Z-Image Turbo로 그림을 만든다. 필요한 모델과 둘 곳은 워크플로의 메모에 있다.
2. **예제 번들 가져오기.** 사이드바의 상자 아이콘(**Open library**)으로 라이브러리를 연다. 빈 라이브러리에는
   **Import the examples**가 보인다. 누른 뒤 **Import 4 bundles**를 누른다.
3. **실행.** 워크플로의 Load Bundle 노드에서 번들을 고르고 실행한다. 다른 번들을 골라 다시 실행한다.

내 번들은 예제 하나를 고르고 **Duplicate → Duplicate with values**로 복제한 뒤, 프롬프트와 그림을 바꿔 저장하면
된다. 필드가 같으므로 같은 워크플로에 맞는다. 자세한 것은
[Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Getting-started)(영어)에 있다.

![라이브러리 창: 묶음별 예제 번들과, 다섯 필드를 가진 Example을 연 편집기](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/library-window.png)

## 문서

나머지는 모두 [위키](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki)(영어)에 있다.

- **사용**: [Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Getting-started),
  [Bundles and fields](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Bundles-and-fields),
  [The Load Bundle node](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/The-Load-Bundle-node),
  [The library window](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/The-library-window),
  [Import and export](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Import-and-export),
  [Images, video and audio](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Images-video-and-audio),
  [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Data-and-backups),
  [FAQ and troubleshooting](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/FAQ-and-troubleshooting).
- **참조**: [HTTP API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/HTTP-API),
  [File formats](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/File-formats),
  [Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Compatibility-and-versions),
  [Automating with the API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Automating-with-the-API).
- **기여**: [Translations](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Translations),
  [Reporting problems](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Reporting-problems).

AI 에이전트를 위해 [`llms.txt`](llms.txt)가 이 문서들의 텍스트판을 가리킨다.

## 업데이트

출시마다 바뀐 것은 [변경 기록](CHANGELOG.md)(영어)과
[릴리스 페이지](https://github.com/romanyogurt/ComfyUI-Bundle-Library/releases)에 있다.

안전하게 업데이트하려면 라이브러리 폴더(`ComfyUI/user/bundle_library/`)를 백업하고, 노드 팩을 업데이트하고,
ComfyUI를 다시 시작하고 페이지를 새로 고친다. 번들과 워크플로는 업데이트 뒤에도 그대로 동작한다.
[Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Compatibility-and-versions)를
보라.

## 알아 둘 것

- 라이브러리는 ComfyUI 서버에 있고, ComfyUI처럼 따로 로그인이 없다. ComfyUI를 다른 컴퓨터에서 열 수 있게
  했다면(`--listen`) 라이브러리도 그렇다. 믿을 수 있는 네트워크에 둔다.
- `--multi-user`로 실행하면 모든 사용자가 라이브러리 하나를 함께 쓴다.

더 자세한 것은 [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Data-and-backups)에 있다.

## 라이선스

Bundle Library는 [MIT 라이선스](LICENSE)다. 일부 예제 자료는 남의 것이라 제 라이선스를 따른다: ComfyUI의 예제
그림(GPL-3.0)과, 템플릿 중 Comfy-Org의 Z-Image Turbo 템플릿에서 온 부분(MIT). 다른 예제 그림은 이 팩을 위해 Z-Image
Turbo로 만들었다. [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)를 보라.
