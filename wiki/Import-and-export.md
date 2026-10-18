Bundles move between libraries as ZIP files: export some or all of them, with the files they use, and import the ZIP
in another library (or the same one). Imported bundles keep their ids, so workflows that use them keep working.

- [Export](#export)
- [Import](#import)
- [The examples](#the-examples)
- [Sharing a workflow with its bundles](#sharing-a-workflow-with-its-bundles)

## Export

- **One bundle**: the export button in the editor's header.
- **Several**: select them in the list ([several bundles at once](The-library-window.md#several-bundles-at-once)) and
  click **Export ZIP**.
- **A tag, or everything**: filter by the tag (or not), press Ctrl+A in the list, and click **Export ZIP**.

The download starts on its own; the result lets you download it again for an hour. Save or revert the editor's
changes first.

What the ZIP holds:

- each bundle as it is stored, byte for byte;
- the images, videos and audio files the bundles use (not their thumbnails);
- the name of each bundle's category; favorites are not exported.

Bundles in the trash and files this version cannot read are left out; the result says which, and why. A file missing
from the library is left out too, and the result names the bundles that use it.

The format of the ZIP is in [File formats](File-formats.md#export-zip).

## Import

1. Click the upload button below the list (left of the trash) and choose an export ZIP. While it uploads, the window
   waits; **Cancel upload** stops it.
2. The window shows what importing it would do, before anything changes: for each bundle whether it is new here,
   here already (or in the trash here), or cannot be imported, with the reason; and how many files would come in, and
   their size.
3. Choose what happens to bundles that are here already:
   - **Leave them as they are** (the default);
   - **Replace them with the file's version** (one in the trash comes back);
   - **Import them as new bundles beside them**.

   And where the bundles go:
   - **As in the file**: into the category of the same name, made if it is not here;
   - **All into one category** (when the library has categories);
   - **Uncategorized**.
4. Click **Import N bundles**. The result lists what came in new, what was replaced, what came in beside, what was
   left as it was, and what could not be imported, with the reason.

- Clicking **Cancel**, or opening another bundle, throws the uploaded file away on the server.
- An import runs once. If the answer did not arrive (a network error, or **Stop waiting**), **Check again** gets the
  answer the server kept, for an hour.
- A bundle is left out if this version cannot read or write it, if it is not what the ZIP's manifest says, or if one
  of its fields points at a file of another kind. A ZIP that is not an export, or that a newer Bundle Library made,
  is refused.
- Favorites are not imported. A bundle that this version cannot change is never replaced.
- An upload can be up to 4 GiB. The other limits are in [HTTP API](HTTP-API.md#import).

## The examples

The pack's folder holds `web/examples/example-bundles.zip`: seven bundles, four for the example workflow
`z-image-turbo` and three in **Field types** that show other kinds of fields.
An empty library offers them with **Import the examples**, which opens the same preview as any other ZIP. A library
with bundles already can import that file with the upload button. See [Getting started](Getting-started.md#try-the-example).

## Sharing a workflow with its bundles

A workflow names its bundles by id. To share one, export the bundles it uses and send the ZIP with the workflow.
Importing them keeps their ids, so the workflow finds them; choose **Leave them as they are** if the other library
may have them already.
