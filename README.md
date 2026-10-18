# Bundle Library for ComfyUI

Keep inputs that belong together (prompts, images, video, audio and settings) as named **bundles**, and load any
of them with one node.

English | [한국어](README.ko.md)

![One Load Bundle node, switching between example bundles: its output slots change with each bundle, from an image and settings to a video and audio, numbers and a switch, or two images](media/outputs-follow-the-bundle.gif)

## Overview

You often run the same workflow with different sets of inputs. Bundle Library keeps each set as a bundle, and the
**Load Bundle** node brings the chosen bundle into the workflow. Bundles with the same inputs but different values
can be swapped without rewiring.

Bundles live in their own library where your ComfyUI is running, so every workflow can use them.

## Features

- **One node, any inputs.** The output slots of the Load Bundle node follow the chosen bundle, one for each of its
  inputs.
- **Mixed input types.** A bundle can hold text, numbers, switches, images, video and audio together.
- **A library window.** Create, edit, search and organize bundles.
- **Files stored once.** A file used by several bundles is stored once, and stored files can be reused in new
  bundles.
- **Import and export.** Bundles can be exported with their files as a ZIP file, and imported later into this
  library or another.
- **An HTTP API.** Scripts and AI agents can make, change and use bundles too.

## Installation

Requires ComfyUI 0.38.0 or later.

- **ComfyUI-Manager**: search for **Bundle Library** and install it.
- **comfy-cli**: `comfy node install bundle-library`
- **Manual installation**:

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/romanyogurt/ComfyUI-Bundle-Library
  ```

Restart ComfyUI after installing.

## Example workflow

The pack comes with an example workflow, four bundles made for it, and three more with other kinds of inputs.

1. **Open the example.** In **Workflow → Browse Templates**, search for **z-image-turbo**. It makes an image with
   Z-Image Turbo from a bundle's prompt, or from the bundle's image (image to image). Its note lists the models it
   needs and where they go.
2. **Import the example bundles.** Open the library from the box icon in the sidebar (**Open library**). An empty
   library offers **Import the examples**: click it, then **Import 7 bundles**.
3. **Run it.** Choose a bundle on the workflow's Load Bundle node and run. Choose another one and run again.

![The same workflow run with each example bundle: the image and the prompt that reach it change with the bundle](media/one-workflow-many-bundles.gif)

The three bundles in **Field types** hold other kinds of inputs (a video and audio, numbers and a switch, two
images). Choose one on a Load Bundle node to see its output slots change.

To make your own, select an example, **Duplicate → Duplicate with values**, change its prompt and image, and save.
It works in the same workflow. See
[Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Getting-started.md) for more.

![The library window: the seven example bundles in their groups, and Sunset loop open in the editor with its video, audio and text](media/library-window.png)

## Documentation

Everything else is in the [wiki](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Home.md):

- **Using it**: [Getting started](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Getting-started.md),
  [Bundles and fields](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Bundles-and-fields.md),
  [The Load Bundle node](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/The-Load-Bundle-node.md),
  [The library window](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/The-library-window.md),
  [Import and export](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Import-and-export.md),
  [Images, video and audio](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Images-video-and-audio.md),
  [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Data-and-backups.md),
  [FAQ and troubleshooting](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/FAQ-and-troubleshooting.md).
- **Reference**: [HTTP API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/HTTP-API.md),
  [File formats](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/File-formats.md),
  [Compatibility and versions](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Compatibility-and-versions.md),
  [Automating with the API](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Automating-with-the-API.md).
- **Contributing**: [Translations](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Translations.md),
  [Reporting problems](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Reporting-problems.md),
  [Working on the code](CONTRIBUTING.md).

For AI agents, [`llms.txt`](llms.txt) points to the plain-text versions of these pages.

## Updates

See the [changelog](CHANGELOG.md) and the
[releases page](https://github.com/romanyogurt/ComfyUI-Bundle-Library/releases). Your bundles are in
`ComfyUI/user/bundle_library/`; back up this folder before updating.

## Good to know

- Anyone who can connect to your ComfyUI can also use the library.
- With `--multi-user`, all users share one library.

More in [Data and backups](https://github.com/romanyogurt/ComfyUI-Bundle-Library/blob/main/wiki/Data-and-backups.md).

## License

Bundle Library is under the [MIT License](LICENSE). Some example files come from other projects and keep their own
licenses; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
