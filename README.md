# Bundle Library for ComfyUI

Keep the prompts, pictures, videos, audio and settings that belong together as named **bundles**, and load any of
them with one node. Choose another bundle, and the same workflow runs with that bundle's prompt, pictures and
settings.

English | [한국어](README.ko.md)

![One Load Bundle node, switching between example bundles: its outputs follow each bundle's fields, from a picture and settings to a video and audio, numbers and a switch, or two pictures](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/outputs-follow-the-bundle.gif)

## Overview

A workflow often runs the same graph with different inputs: one character with its reference pictures and prompt,
another with its own; a location, a style, a voice. Bundle Library keeps each such set as a bundle in a library on
the ComfyUI server, and the **Load Bundle** node puts the bundle you choose into the workflow. Its outputs follow the
bundle: one output for each field, named after it. Bundles whose fields share names and types fill the same links, so
switching between them is one click.

Unlike values saved inside a workflow, bundles live in their own library: they are made and edited in a window of
their own, found by search, tags and categories, shared between workflows, and moved between machines as ZIP files.

## Features

- **One node, outputs that follow the bundle.** Load Bundle has an output for each field of the chosen bundle. Links
  stay when you switch to a bundle with the same fields; nothing is rebuilt behind your back.
- **Text, numbers, switches, images, video and audio.** Seven field types, loaded as ComfyUI's own Load Image, Load
  Video and Load Audio load them.
- **A library window.** Make and edit bundles; search, sort, filter by tag, group in categories, star favorites, and
  act on many bundles at once.
- **Safe editing.** Unsaved drafts are kept apart, a change saved elsewhere is never overwritten silently, deleted
  bundles go to a trash you can restore from, and files are written in full or not at all.
- **Files stored once.** Each picture, video or audio file is kept once, whatever number of bundles use it, and can
  be reused from the library. Unused files are cleaned up only when you ask.
- **Import and export.** Move bundles, with their files, between libraries as ZIP files; workflows keep finding them.
- **English and Korean.** The pack follows ComfyUI's language setting, and more languages can be added.
- **An HTTP API.** Scripts and AI agents can make, change and use bundles too.

## Installation

Bundle Library needs ComfyUI 0.38.0 or later, with its frontend 1.53.10 or later. It needs nothing beyond what
ComfyUI installs.

- **ComfyUI-Manager**: search for **Bundle Library** and install it.
- **comfy-cli**: `comfy node install bundle-library`
- **By hand**:

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/romanyogurt/ComfyUI-Bundle-Library
  ```

Then restart ComfyUI and reload the browser page. The node is marked BETA while the first public releases meet more
setups.

## Quick start

The pack comes with an example workflow, four bundles made for it, and three more that show other kinds of
fields.

1. **Open the example.** In **Workflow → Browse Templates**, search for **z-image-turbo**. It makes a picture with
   Z-Image Turbo from a bundle's prompt, or from the bundle's picture (image to image). Its note lists the models it
   needs and where they go.
2. **Import the example bundles.** Open the library from the box icon in the sidebar (**Open library**). An empty
   library offers **Import the examples**: click it, then **Import 7 bundles**.
3. **Run it.** Choose a bundle on the workflow's Load Bundle node and run. Choose another one and run again.

![The same workflow run with each example bundle: the picture and the prompt that reach it follow the bundle](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/one-workflow-many-bundles.gif)

The three bundles in **Field types** have other fields (a video and audio, numbers and a switch, two pictures).
Choose one on a Load Bundle node to see its outputs follow it.

To make your own, select an example, **Duplicate → Duplicate with values**, change its prompt and picture, and save.
Your bundle fits the same workflow, since it has the same fields. See
[Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Getting-started) for more.

![The library window: the seven example bundles in their groups, and Sunset loop open in the editor with its video, audio and text](https://raw.githubusercontent.com/romanyogurt/ComfyUI-Bundle-Library/main/media/library-window.png)

## Documentation

Everything else is in the [wiki](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki):

- **Using it**: [Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Getting-started),
  [Bundles and fields](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Bundles-and-fields),
  [The Load Bundle node](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/The-Load-Bundle-node),
  [The library window](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/The-library-window),
  [Import and export](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Import-and-export),
  [Images, video and audio](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Images-video-and-audio),
  [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Data-and-backups),
  [FAQ and troubleshooting](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/FAQ-and-troubleshooting).
- **Reference**: [HTTP API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/HTTP-API),
  [File formats](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/File-formats),
  [Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Compatibility-and-versions),
  [Automating with the API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Automating-with-the-API).
- **Contributing**: [Translations](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Translations),
  [Reporting problems](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Reporting-problems).

For AI agents, [`llms.txt`](llms.txt) points to the plain-text versions of these pages.

## Updates

What changed in each release is in the [changelog](CHANGELOG.md) and on the
[releases page](https://github.com/romanyogurt/ComfyUI-Bundle-Library/releases).

To update safely, back up the library folder (`ComfyUI/user/bundle_library/`), update the node pack, restart ComfyUI
and reload the page. Your bundles and workflows keep working across updates; see
[Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Compatibility-and-versions).

## Good to know

- The library lives on the ComfyUI server and has no login of its own, like ComfyUI. If ComfyUI is reachable from
  other computers (`--listen`), so is the library: keep it on a trusted network.
- With `--multi-user`, all users share one library.

More in [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki/Data-and-backups).

## License

Bundle Library is under the [MIT License](LICENSE). Some example material comes from others and keeps its own
license: ComfyUI's example picture (GPL-3.0) and the parts of the template that come from Comfy-Org's Z-Image Turbo
template (MIT). The other example pictures were made with Z-Image Turbo for this pack. See
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
