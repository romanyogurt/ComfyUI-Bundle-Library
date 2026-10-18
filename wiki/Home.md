**Bundle Library** is a node pack for [ComfyUI](https://github.com/Comfy-Org/ComfyUI). It keeps named
*bundles* in a library: each bundle holds the prompts, images, videos, audio and values that belong together, such as
a character with its reference pictures and settings. One **Load Bundle** node loads a bundle into a workflow, and its
outputs follow the bundle you choose: choose another bundle and the same workflow runs with that one's prompt,
pictures and settings, as long as it has fields of the same names and types for the outputs you linked.

These pages cover everything the pack does. To get going quickly, start with [Getting started](Getting-started.md).

## Using Bundle Library

| Page | What it covers |
| --- | --- |
| [Getting started](Getting-started.md) | Install, try the example workflow, make your first bundle |
| [Bundles and fields](Bundles-and-fields.md) | What a bundle holds: the field types, names, tags, notes, turning a field off |
| [The Load Bundle node](The-Load-Bundle-node.md) | Choosing a bundle, how outputs follow it, links, caching, what happens when a field is missing |
| [The library window](The-library-window.md) | The list, search and sorting, categories and favorites, the editor, several bundles at once, tags, the trash |
| [Import and export](Import-and-export.md) | Moving bundles between libraries as ZIP files |
| [Images, video and audio](Images-video-and-audio.md) | Formats and limits, reusing stored files, cleaning up unused ones |
| [Data and backups](Data-and-backups.md) | Where the library lives, backing it up, moving it, sharing a server |
| [FAQ and troubleshooting](FAQ-and-troubleshooting.md) | Common questions and what to do when something goes wrong |

## Reference

| Page | What it covers |
| --- | --- |
| [HTTP API](HTTP-API.md) | Every endpoint, request and answer, and the errors |
| [File formats](File-formats.md) | The library folder, bundle files, `organization.json`, the export ZIP, the node in a workflow |
| [Compatibility and versions](Compatibility-and-versions.md) | Supported ComfyUI versions, updating safely, how files of other versions are treated |
| [Automating with the API](Automating-with-the-API.md) | Making and using bundles from scripts and agents, with examples |

## Contributing

| Page | What it covers |
| --- | --- |
| [Translations](Translations.md) | Adding or updating a language |
| [Reporting problems](Reporting-problems.md) | What to include in an issue, and where to send security problems |

---

These pages describe the latest release. What was added after 0.1.0 is marked *(since 0.x)*. Past changes are in the
[changelog](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/CHANGELOG.md) and the
[releases](https://github.com/romanyogurt/ComfyUI-Bundle-Library/releases). The source of these pages is the
[`wiki/`](https://github.com/romanyogurt/ComfyUI-Bundle-Library/tree/main/wiki) folder of the repository; corrections
are welcome as pull requests there.
