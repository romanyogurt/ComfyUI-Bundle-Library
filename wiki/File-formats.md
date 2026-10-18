What Bundle Library writes to disk: the library folder, bundle files, `organization.json`, stored files, the export
ZIP, and what a Load Bundle node keeps in a workflow. How files of other versions are treated is in
[Compatibility and versions](Compatibility-and-versions.md); the API that reads and writes them is in
[HTTP API](HTTP-API.md).

- [The library folder](#the-library-folder)
- [Bundle file](#bundle-file)
- [Fields](#fields)
- [Names and limits](#names-and-limits)
- [organization.json](#organizationjson)
- [Stored files](#stored-files)
- [Export ZIP](#export-zip)
- [The node in a workflow](#the-node-in-a-workflow)

## The library folder

The library lives in `bundle_library/` inside ComfyUI's user directory (`ComfyUI/user/bundle_library/`, or under the
folder `--user-directory` names). It is made on first use.

```text
bundle_library/
├── bundles/<uuid>.json                    one file per bundle, those in the trash too
├── organization.json                      categories, where each bundle goes, favorites (may be absent)
├── assets/sha256/<first 2>/<sha256>.<ext> uploaded files, byte for byte
├── thumbs/<first 2>/<sha256>_<size>.webp  previews, made again when needed
└── tmp/                                   files being written; emptied on start
```

- To back up, copy `bundles/`, `assets/` and the files directly in the folder (`organization.json`). `thumbs/` and
  `tmp/` need no backup. See [Data and backups](Data-and-backups.md).
- Only one ComfyUI process should use a library folder. Another process opening the same folder could delete the
  temporary files of a write in progress.
- Every file is written in full and synced to the disk before it takes its place, so a power cut never leaves half a
  file. What a request guarantees is in [HTTP API](HTTP-API.md#writing).
- A bundle file edited by hand is picked up the next time the list is read (changes of content, permissions and
  replaced files are noticed). A file that cannot be used is skipped and reported in the list's `errors` and in
  `/health`, by its state. One file never stops the others from listing.
- A file that cannot be read because of permissions or a disk error is reported as `read_error`, not as damaged, and
  is read again on the next request. The same goes for `organization.json`.

## Bundle file

```json
{
  "format": "comfyui-bundle-library/bundle",
  "schema_version": 4,
  "id": "0b0fd10b-2e9d-43fa-898a-91f0cda76f5e",
  "revision": 1,
  "name": "Red knight",
  "tags": ["character"],
  "note": "",
  "fields": [
    {"name": "prompt", "type": "text", "value": "a knight in red armor"},
    {"name": "reference", "type": "image", "asset": {
      "sha256": "4f71…6024", "ext": "png", "width": 512, "height": 768,
      "bytes": 6272, "original_name": "knight.png"}},
    {"name": "mask", "type": "image", "asset": null},
    {"name": "steps", "type": "int", "value": 8},
    {"name": "lora", "type": "choice", "value": "armor/red.safetensors",
     "source": {"node": "LoraLoader", "input": "lora_name"}}
  ],
  "created_at": "2026-10-14T01:32:24.101Z",
  "updated_at": "2026-10-14T01:32:24.101Z",
  "deleted_at": null
}
```

| Key | Meaning |
| --- | --- |
| `format` | Always `comfyui-bundle-library/bundle` |
| `schema_version` | The lowest version that holds this bundle: 4 when it has a choice field, else 3 when a field is turned off, else 2 |
| `id` | A UUID, the same as the file name. Workflows point at bundles by this id |
| `revision` | Starts at 1 and goes up by 1 with each save, trashing and restoring |
| `name` | For display. Bundles may share a name, even in one category; the library tells them apart by the start of their id |
| `tags` | Up to 20 tags |
| `note` | Free text |
| `fields` | An ordered list. The order is the order of a node's outputs when the bundle is first chosen |
| `created_at`, `updated_at` | UTC, to the millisecond. `updated_at` changes only when the content is saved |
| `deleted_at` | `null` for a bundle in use, a UTC time for one in the trash. A bundle in the trash does not run until it is restored |

## Fields

| `type` | Holds | Output type | Rules |
| --- | --- | --- | --- |
| `text` | `value`: a string | STRING | May be empty. Spaces and line breaks are kept as they are. Up to 1 MB of UTF-8 |
| `image` | `asset`: an object, or `null` | IMAGE | `asset.sha256` must be an uploaded image |
| `video` | `asset`: an object, or `null` | VIDEO | An uploaded video. Passed on as a file, like core Load Video; decoded where it is used |
| `audio` | `asset`: an object, or `null` | AUDIO | An uploaded audio file. Decoded whole, like core Load Audio, into `{"waveform": [1, channels, samples], "sample_rate"}` (float32; a 64-bit float file stays float64) |
| `boolean` | `value`: `true` or `false` | BOOLEAN | 0 and 1 are not accepted |
| `int` | `value`: an integer | INT | Within ±9,007,199,254,740,991 (±(2^53−1), JavaScript's safe integers): a browser reads JSON numbers as doubles, so larger values would change in the editor. `true` and `false` are not accepted |
| `float` | `value`: a number | FLOAT | Finite values only |
| `choice` | `value`: a string; `source`: an object, or none | COMBO | One option of another node's dropdown, kept exactly as it is (not trimmed or normalized). May be empty. Up to 4,096 bytes of UTF-8. Schema version 4 |

- A media field's `asset` holds the file's `sha256`, an `original_name` for display, and what the server read from
  the file when the bundle was saved (what a client sends is not used):
  - all kinds: `ext`, `bytes`
  - `image`: `width`, `height` (as shown, after the EXIF orientation)
  - `video`: `width`, `height`, `fps`, `duration` (seconds), `codec`, `has_audio`, and `audio_codec` when it has sound
  - `audio`: `duration` (seconds; from the header, or counted by decoding when the header has none),
    `sample_rate`, `channels`, `codec`
- A file must be of the field's kind: an image in a `video` field is refused as `wrong_kind`.
- Field names are unique within a bundle, and case matters, since a node matches outputs by exact name. Names
  starting with `@` are reserved for future virtual fields.
- A choice's `source` names the dropdown input its options come from, as ComfyUI names them:
  `{"node": "<the node's class name>", "input": "<the input's name>"}`, each 1 to 256 characters. It may name a node
  this ComfyUI does not have; it is kept as it is. Without one (or with `null`), the value is typed freely. A request's
  other keys in `source` are left out; a file with other keys there, a `source` on another type of field, or a choice
  in a file of schema version 2 or 3 is read-only. The model files a choice names are not part of the library.
- A field can be turned off: `"enabled": false` (schema version 3). It stays in the bundle with its value or file but
  is not an output of the node. A field that is on has no `enabled` key (`true` is dropped when saved); anything but
  `true` or `false` is refused. A field that is off still needs a unique name, counts toward the field limit and is
  found by search. Duplicating, exporting and importing keep it off.

## Names and limits

| What | Rule |
| --- | --- |
| Every name (bundle, field, tag, category) | Spaces at both ends are removed and the text is normalized to NFC. Line breaks, control characters and direction controls are not allowed |
| Bundle name | Up to 120 characters. Other bundles may have the same name |
| Category name | Up to 60 characters, unique ignoring case. Favorites, Uncategorized and Needs attention are taken (they name views of the list). Up to 200 categories |
| Field name | Up to 64 characters |
| Choice | Up to 4,096 bytes of UTF-8. A source's node and input names: up to 256 characters each |
| Tags | Up to 20, of up to 40 characters each. Tags that differ only in case are one tag |
| Note | Up to 10,000 characters |
| Fields | Up to 32 per bundle (a node has 32 outputs) |
| JSON request body | Up to 4 MB |
| Image | PNG, JPEG, WebP. Up to 50 MB and 64 million pixels |
| Video | MP4, WebM (VP8, VP9 or AV1, with Opus or Vorbis), MOV. Up to 1 GB, and 7680×4320 pixels per frame |
| Audio | WAV, FLAC, MP3, OGG (Opus or Vorbis), M4A. Up to 200 MB, 10 minutes, 8 channels, 192 kHz, and 57.6 million samples over all channels (10 minutes of 48 kHz stereo). Samples of 16-, 24- or 32-bit integers or 32- or 64-bit floats |
| Thumbnail sizes | 128, 256, 512 |

## organization.json

Categories and favorites arrange the list; they are not part of a bundle. So moving or starring a bundle changes
neither its file nor its revision, and does not make the nodes that use it run again.

```json
{
  "format": "comfyui-bundle-library/organization",
  "schema_version": 1,
  "revision": 12,
  "categories": [{"id": "6f1c0e5a-…", "name": "Characters", "parent": null}],
  "placement": {"0b0fd10b-2e9d-43fa-898a-91f0cda76f5e": "6f1c0e5a-…"},
  "favorites": ["0b0fd10b-2e9d-43fa-898a-91f0cda76f5e"]
}
```

| Key | Meaning |
| --- | --- |
| `revision` | Starts at 0 and goes up by 1 with each write |
| `categories` | Each has an `id` (a UUID), a `name` and a `parent`. The list is shown sorted by name |
| `parent` | Kept for nested categories later. Version 1 takes only `null`; any other value makes the file damaged |
| `placement` | Bundle id → category id. A bundle is in one category at most; without one it is uncategorized |
| `favorites` | Starred bundle ids. A favorite shows under Favorites and in its own category |

- Without the file, nothing is arranged: every bundle is uncategorized. The file is made at the first change.
- Entries for bundles or categories that do not exist are ignored when read and cleaned up at the next write. A bundle
  exists while there is any file for its id: in use, in the trash, or one this version cannot read. So bundles in the
  trash keep their category and star.
- It follows the life of the bundles: trashing and restoring keep a bundle's category and star; deleting for good and
  emptying the trash remove them. A duplicate goes in the category of its source, without the star. Deleting a
  category makes its bundles (those in the trash too) uncategorized.
- It has the same states as a bundle file (see [Compatibility and versions](Compatibility-and-versions.md#file-states)).
  When this version cannot change it, the file is left as it is, changes of categories and favorites are refused with
  409 `organization_unwritable`, and bundles still work. A read-only file still shows its categories.

## Stored files

- Extensions and MIME types are not trusted:
  - Images are opened only with Pillow's PNG, JPEG and WebP decoders and decoded to the end.
  - Videos and audio are opened with PyAV to check the container and codecs; a video's first frame is decoded. MP4,
    MOV and M4A share one format and are told apart by brand and streams: brand `qt` is MOV, a video stream makes
    MP4, sound alone makes M4A. Cover art in MP3 or M4A does not count as video.
  - Audio is decoded whole into memory when it runs, so an upload is decoded to the end and its real samples are
    counted against the limits; the length in the header is not trusted. Sample formats that core's AUDIO conversion
    does not take (8- and 64-bit integers) are refused. When it runs, decoding stops with an error past the same
    limits.
  - A format or kind that is not accepted, and audio with channels, sample rate or sample format out of range, get
    415; a damaged file gets 400; too many pixels, too long or too many samples get 413.
- Files are kept byte for byte, named by their SHA-256. Uploading the same content again reuses the stored file and
  only sets its modification time to now (which restarts its grace time before a cleanup).
- The files of bundles in the trash are kept, so a restored bundle is complete.
- Thumbnails are made when first asked for. Images follow their EXIF orientation, and 16-bit images are scaled
  down without clipping. A video's thumbnail is the frame at 10% of its length (at most 1 second in). Audio has none.
- Files are served with HTTP range requests, so browsers can stream video and audio and seek in them. MOV is served
  as `video/mp4`: browsers refuse `video/quicktime` but play the H.264 inside.

## Export ZIP

```text
manifest.json
bundles/<uuid>.json       bundle files, as stored
assets/<sha256>.<ext>     the files the bundles use (no thumbnails)
```

```json
{"format": "comfyui-bundle-library/export", "version": 1, "exported_at": "2026-10-17T05:21:20.000Z",
 "generator": "Bundle Library 0.1.0",
 "bundles": [{"id": "…", "name": "…", "file": "bundles/….json", "sha256": "SHA-256 of that file's bytes",
              "category": "category name, or null"}],
 "assets": [{"sha256": "…", "file": "assets/….png", "kind": "image", "bytes": 1234}]}
```

- JSON entries are compressed (deflate); media files, already compressed, are stored as they are. ZIP64 is used for
  large archives.
- An import reads only the entries the manifest lists, by those names, and checks each against its SHA-256. What
  is left out of an export and how an import treats a ZIP are in [HTTP API](HTTP-API.md#export).

## The node in a workflow

A Load Bundle node (`BundleLibraryLoad`) keeps two widget values in a workflow, which ComfyUI saves by position:

| Widget | Value |
| --- | --- |
| `bundle_id` | The id of the chosen bundle |
| `slot_spec` | Which field each output carries, in output order: `{"v": 1, "slots": [{"name": "prompt", "type": "text"}, {"name": "reference", "type": "image"}]}`. `type` is a field type |

- The node declares 32 outputs, `field_01` to `field_32`; the node's page shows as many as `slot_spec` has slots,
  named and typed after the fields. The first output carries the first slot, and so on.
- The node's properties also hold `bundle_name` (shown when the bundle is missing) and `preview_collapsed`.
- In an API-format prompt, give `bundle_id` and `slot_spec` as inputs, and link the first slot as `["<node id>", 0]`,
  the second as `["<node id>", 1]`, and so on. See [Automating with the API](Automating-with-the-API.md#run-a-workflow-with-a-bundle).
