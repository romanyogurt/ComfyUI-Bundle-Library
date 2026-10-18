# Changelog

Notable changes to Bundle Library. Versions follow [Semantic Versioning](https://semver.org/). The 0.0.x versions
came before the first public release; they are in this repository's history and tags.

## [Unreleased]

The first public release, to be 0.1.0. Bundle Library as the [README](README.md) and the
[wiki](https://github.com/romanyogurt/ComfyUI-Bundle-Library/wiki) describe it:

- **Load Bundle**, a node whose outputs follow the chosen bundle: one output per field, links kept across bundles
  with the same fields, and runs that stop with a clear reason when a bundle cannot fill a linked output.
- Seven field types: text, integer, float, boolean, image, video and audio; fields can be turned off.
- The library window: editing with unsaved drafts and revision checks, search, sorting, tags, categories, favorites,
  actions on many bundles at once, a trash, and cleanup of unused files.
- Files stored once by their content, and reusable from the library.
- Import and export of bundles, with their files, as ZIP files.
- English and Korean, following ComfyUI's language.
- An HTTP API, documented in the wiki, for scripts and AI agents.
- An example workflow, `z-image-turbo`, and four example bundles that an empty library offers to import.

## Development before 0.1.0

- **0.0.34**: uploaded files are synced to the disk before they take their place; every write whose folder could not
  be synced says so; a failure after a file is in place is no longer reported as a failed write.
- **0.0.33**: the `z-image-turbo` template and its example bundles; the MIT license and third-party notices.
- **0.0.32**: fixes from an independent review: cleanup trusts only references it fully understands, the page asks
  for its messages again when they did not come, a repeated import request gets its first answer, the last English-only
  server messages are translated, and Tab skips what cannot be used.
- **0.0.26 – 0.0.31**: icons in the editor and four sort orders; fields reordered by dragging; files chosen from those
  the library keeps; fields turned off (bundle format version 3, only where a field is off); recent unused files
  cleaned up on request.
- **0.0.24 – 0.0.27**: English and Korean for every screen and for the server's messages; messages by id, with one
  catalog per language.
- **0.0.21 – 0.0.23**: export to and import from ZIP files, previewed first, each import run once.
- **0.0.19 – 0.0.20**: tags across the library (rename, merge, delete) and on many bundles at once; one rule for when
  two tags are the same.
- **0.0.16 – 0.0.18**: stricter request and write rules; the window waits for each command; a run's outputs always
  match its cache key.
- **0.0.13 – 0.0.15**: tools below the list and keyboard menus; selecting many bundles and acting on them at once; the
  editor locks the rest of the window while it has unsaved changes.
- **0.0.12**: categories and favorites; Load Bundle runs again only when what its outputs carry changes.
- **0.0.1 – 0.0.11**: the first versions: bundles of text, values and images, the Load Bundle node, and the library
  window; then video and audio fields, the trash, and the rules for reading files of other versions (bundle format
  version 2).
