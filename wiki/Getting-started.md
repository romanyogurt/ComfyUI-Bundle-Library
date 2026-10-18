From installing Bundle Library to running the example workflow and making a bundle of your own.

- [Install](#install)
- [Find your way around](#find-your-way-around)
- [Try the example](#try-the-example)
- [Make your own bundle](#make-your-own-bundle)
- [Where next](#where-next)

## Install

You need ComfyUI 0.38.0 or later (see [Compatibility and versions](Compatibility-and-versions.md#supported-versions)).
Bundle Library needs nothing beyond what ComfyUI installs. Use any one of these:

- **ComfyUI-Manager**: search for **Bundle Library**, install it, and restart ComfyUI.
- **comfy-cli**: `comfy node install bundle-library`, then restart ComfyUI.
- **By hand**: clone the repository into ComfyUI's `custom_nodes` folder and restart ComfyUI.

  ```bash
  cd ComfyUI/custom_nodes
  git clone https://github.com/romanyogurt/ComfyUI-Bundle-Library
  ```

After the restart, reload the browser page.

## Find your way around

- **The Load Bundle node** (in the node library under *Bundle Library*) loads one bundle into a workflow. Its outputs
  follow the bundle you choose. See [The Load Bundle node](The-Load-Bundle-node.md).
- **The library window** is where bundles are made and kept. Open it from the box icon in the sidebar
  (**Open library**), from **Extensions → Open Bundle Library**, or with the 📚 button of a Load Bundle node. See
  [The library window](The-library-window.md).
- The library lives on the ComfyUI server, in its user folder. See [Data and backups](Data-and-backups.md).

## Try the example

The pack comes with a workflow template, four bundles made for it, and three more that show other kinds of fields.
The workflow makes a picture with Z-Image Turbo from a bundle's prompt, and can start from the bundle's picture instead
(image to image).

1. **Get the models.** Open ComfyUI's template browser (**Workflow → Browse Templates**) and search for
   **z-image-turbo**. The note in the workflow lists the three model files and where they go; ComfyUI may also offer
   to download missing models when the workflow opens.
2. **Get the example bundles.** Open the library window. While the library is empty, it offers
   **Import the examples**: click it, look at the preview, and click **Import 7 bundles**. (A library that has
   bundles already can import `web/examples/example-bundles.zip` from the pack's folder with the import button below
   the list. See [Import and export](Import-and-export.md).)
3. **Run it.** On the workflow's Load Bundle node, choose a bundle in the list (or with 📚), and run the workflow.
   Choose another bundle and run again: the same workflow now makes that bundle's picture.

The four bundles made for it have the same five fields (`image`, `text`, `steps`, `denoise`, `i2i`), so the node's
links stay as they are whichever of them you choose. Black Rose, Hamster and Santorini make a picture from their
prompt; their picture shows a result. Example starts from ComfyUI's example picture.

The three bundles in **Field types** have other fields: **Sunset loop** a video, an audio file and a text, **Sampler
settings** numbers, two choices (a sampler and a scheduler), a text and a switch, and **Two references** two pictures
and a text. Choose them on a Load Bundle
node to see its outputs follow the bundle. On the example workflow, the outputs a bundle lacks are marked, and a run
stops with the reason (see [The Load Bundle node](The-Load-Bundle-node.md#when-a-bundle-cannot-fill-an-output)).

## Make your own bundle

The quickest way to a bundle that fits the example workflow is to copy one:

1. In the library window, select an example bundle, then **Duplicate → Duplicate with values** (in the editor's
   header).
2. Change its name, its `text` (the prompt), and its picture (drop a file on the image card, paste one, or click
   **Choose an image…**). Set `i2i` on to start from your picture, and `denoise` to how much to change it.
3. Save (**Ctrl+S**). On the Load Bundle node, choose your bundle and run.

To start from nothing, click **+ New bundle**, give it a name, and add fields with **+ Add field ▾**. A field's name
becomes the name of the node's output, so fields named alike in different bundles fill the same links. See
[Bundles and fields](Bundles-and-fields.md).

## Where next

- [Bundles and fields](Bundles-and-fields.md): every field type, choices for other nodes' dropdowns, and turning a
  field off.
- [The Load Bundle node](The-Load-Bundle-node.md): how outputs follow a bundle, and what happens when a field is missing.
- [The library window](The-library-window.md): categories, favorites, tags, several bundles at once, and the trash.
- [FAQ and troubleshooting](FAQ-and-troubleshooting.md), when something does not work as expected.
