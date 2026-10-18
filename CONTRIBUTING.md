# Contributing to Bundle Library

Thank you for helping. Reports, translations and pull requests are all welcome.

- **A problem or an idea**: [Reporting problems](wiki/Reporting-problems.md) says what to include, and how to report
  a vulnerability privately.
- **A translation**: [Translations](wiki/Translations.md) explains the message catalogs and how to add a language.
- **Code**: the rest of this page.

## The code

| Folder | What is in it |
| --- | --- |
| `bundle_library/` | The server side: the store of bundles and files, the HTTP API, the Load Bundle node, import and export |
| `web/` | The page: the node's widgets, the library window, the sidebar. Plain ES modules, no build step |
| `locales/` | The messages of the page and the server |
| `web/examples/`, `workflows/` | The example bundles and the example workflow |
| `wiki/` | The source of the wiki |
| `tests/` | Unit tests, end-to-end scripts, browser scenarios and their fixtures |

To work on it, clone the repository into `ComfyUI/custom_nodes/`, as the README's installation does by hand. A change
in `web/` needs only a reload of the page; a change in the Python code needs a restart of ComfyUI.

## Rules

- **English in the code.** Every string in the code is English: text on the page, errors, log messages, the names
  the pack makes up.
- **Messages by id.** What users read comes from the message catalogs, not from strings in the code: the page uses
  `t(id, values)`, `msg(id)` and `around()` from `web/i18n.js`, the server `Text(id, ...)` from
  `bundle_library/text.py`. Add a message to `locales/en/bundle_library.json` and translate it in the other
  languages, as [Translations](wiki/Translations.md) describes, also for changing an English message. Write whole
  sentences with placeholders rather than pieces joined in code: word order differs between languages.
  `tests/js/i18n.test.mjs` finds unknown ids, unused messages, translations whose shape or placeholders differ from
  the English, and missing or outdated translations; `tests/test_text.py` checks that the server's errors are `Text`.
- **Files are replaced, not rewritten.** A library file is written to a temporary file and put in place in one step
  (`_write_file` in `bundle_library/store.py`; `replace` and `sync_folder` in `bundle_library/assets.py`), so that a
  crash or a full disk leaves the old file as it was.
- **Released files keep working.** Bundles, libraries and workflows of released versions must keep working in later
  versions. `tests/fixtures/compat/` holds files that released versions wrote, and a few made by hand;
  `tests/test_compat.py` and `tests/browser/compat_scenarios.cjs` hold the pack to them. Read
  [File formats](wiki/File-formats.md) and [Compatibility and versions](wiki/Compatibility-and-versions.md) before you
  change what is stored.
- **One version number.** `pyproject.toml` holds the version and `bundle_library/constants.py` the limits; the copies
  in `web/` must agree (`tests/test_versions.py`). Changes users notice go in `CHANGELOG.md`, under Unreleased.
- **The fold of tags.** Tags that differ only in case are one tag, by a table the page and the server share
  (`web/tags.js`, `bundle_library/casefold.py`), so that they agree whatever the Unicode of the browser or of the
  server's Python. `python -m tests.make_casefold` writes it from the Python it runs on. Run it only to move to a
  newer Unicode on purpose: that can make two tags one.

## Tests

### Unit tests

They need Python 3.10 or newer with the packages below, which ComfyUI installs too, and Node.js 22 or newer. They work
in temporary folders and never touch a library.

```bash
python -m pip install aiohttp pillow av numpy    # or run them with ComfyUI's Python
python -m unittest discover -s tests -t .
node --test "tests/js/*.test.mjs"
```

[GitHub Actions](.github/workflows/tests.yml) runs them for every push and pull request: the Python tests on Ubuntu,
Windows and macOS, on Ubuntu also with the oldest and newest Python.

### End-to-end and browser tests

These need a running ComfyUI. `tests/test-server.sh` starts a throwaway one in Docker: CPU only, with this checkout as
its only custom node and its folders inside the container (gone when it stops), on `127.0.0.1:8189`. No ComfyUI of
yours is touched. It needs Docker and bash (on Windows, in WSL), and the browser scenarios Node.js with Playwright's
headless Chromium:

```bash
npm ci --prefix tests                                                      # once
tests/node_modules/.bin/playwright-core install chromium-headless-shell   # once

tests/test-server.sh run    # start the server, run every suite, stop it
```

On first use the script builds the image `bundle-library-test-comfyui:v0.38.0` from `tests/test-server.Dockerfile`:
ComfyUI 0.38.0, the oldest this pack supports, on Python 3.13 with CPU-only PyTorch. That takes some minutes and a
few GB of disk. With `COMFYUI_VERSION` set to another tag of ComfyUI, such as `v0.41.3`, it builds and tests that
release; the script's header says how to use an image of your own.

To run one suite, keep the server up:

```bash
tests/test-server.sh start
docker exec -w /opt/ComfyUI/custom_nodes/ComfyUI-Bundle-Library bundle-library-test python tests/e2e/node_smoke.py
node tests/browser/library_scenarios.cjs
tests/test-server.sh stop
```

| Suite | What it checks |
| --- | --- |
| `tests/e2e/compare_load_image.py`, `compare_media.py` | Load Bundle decodes images, video and audio exactly as ComfyUI's Load Image, Load Video and Load Audio do |
| `tests/e2e/cache_race.py` | ComfyUI's executor and its cache, in-process: a bundle changed after the cache key was made, empty media fields, problem outputs linked later |
| `tests/e2e/api_smoke.py`, `node_smoke.py`, `media_smoke.py` | The API, and Load Bundle run through prompts: outputs, the cache, errors, video and audio |
| `tests/e2e/security_smoke.py` | The write protection and the limits; it sends only requests that must be refused |
| `tests/browser/*_scenarios.cjs` | Headless Chromium on ComfyUI's page: the node, the library window and editor, several bundles at once, tags, categories, the trash, import and export, slow or lost answers, old workflows and files, the page in Korean |
| `tests/e2e/bench_store.py` | How fast the store is with many bundles (not part of `run`) |

- They use the test server unless told otherwise: `--base` for the Python scripts, `COMFY_URL` for the browser
  scenarios. Keep them to a test server: they create, change and delete bundles and queue runs. They remove only
  what they made, by id, and check that everything else is as it was; `run` also checks that a bundle it made
  before them is still there.
- The browser scenarios keep the page from writing settings or workflows to the server, and fail on any console
  error they do not expect. Their screenshots and results go to `bundle-library-<scenario>/` in the system's
  temporary folder (`BL_TEST_OUT` to change it).
- A few scenarios place, read or back-date library files through the test server's container (`BL_TEST_CONTAINER`
  and `BL_TEST_LIBRARY`, which `run` sets); without them they skip those steps.

## Pull requests

- Keep a pull request to one change, with tests for it. Run the unit tests and the suites that cover what you
  changed, and say in the pull request what you ran.
- Write as the code around it is written: its names, its comments (they say why), English.
- By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
