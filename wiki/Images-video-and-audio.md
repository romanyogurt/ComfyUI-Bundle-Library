Image, video and audio fields hold a file. Files are uploaded to the ComfyUI server once and kept in the library;
bundles point at them.

- [Formats and limits](#formats-and-limits)
- [Adding a file](#adding-a-file)
- [What a workflow gets](#what-a-workflow-gets)
- [Files are stored once](#files-are-stored-once)
- [Cleaning up unused files](#cleaning-up-unused-files)

## Formats and limits

| Kind | Formats | Limits |
| --- | --- | --- |
| Image | PNG, JPEG, WebP | 50 MB, 64 million pixels |
| Video | MP4, WebM (VP8, VP9 or AV1, with Opus or Vorbis), MOV | 1 GB, 7680×4320 pixels per frame |
| Audio | WAV, FLAC, MP3, OGG (Opus or Vorbis), M4A | 200 MB, 10 minutes, 8 channels, 192 kHz |

A file is checked when it is uploaded, by its content rather than its name: an image is decoded to the end, a video's
first frame is decoded, and an audio file is decoded whole (it is loaded whole when it runs). A file that is damaged,
of another format, of the wrong kind for the field (a video in an audio field), or over a limit is refused with the
reason. More details are in [File formats](File-formats.md#stored-files).

## Adding a file

On a media field's card in the [editor](The-library-window.md#the-editor):

- **Choose an image…** (or a video, or an audio file) picks a file from your computer.
- Drop a file on the card, or paste an image into it.
- **Choose from the library…** shows the files of that kind the library keeps already, the most recently stored first,
  with the names bundles gave them and how many bundles use them. Hovering shows which bundles; the box at the top
  filters by file or bundle name. **Current** marks the field's own file. A file chosen here is not uploaded again.

The card shows an upload's progress; **Cancel upload** stops it. The field holds the new file as an unsaved change
until you save the bundle.

## What a workflow gets

| Field | Output | Like core node |
| --- | --- | --- |
| Image | IMAGE: the picture as it is shown (after its EXIF orientation); an animated file gives its first frame | Load Image |
| Video | VIDEO, a reference to the file, decoded by the node that uses it | Load Video |
| Audio | AUDIO, decoded whole: `{"waveform", "sample_rate"}` | Load Audio |

In the editor, a picture enlarges on a click, and videos and audio play with their own controls. In the
[Load Bundle node](The-Load-Bundle-node.md#the-preview)'s preview, pictures enlarge and videos play on a click, and audio
plays with **Play**.

## Files are stored once

A file is kept under the SHA-256 of its bytes, unchanged. Uploading the same file again, or using it in another
bundle, stores nothing new. Deleting a bundle (even for good) leaves its files; they go only when you clean up.

## Cleaning up unused files

**Clean up unused files…** in the [trash](The-library-window.md#the-trash) lists the files that no bundle uses, not even
a bundle in the trash, with their sizes, and deletes them once you confirm. Deleted files cannot be brought back, so
back up first if you may want them ([Data and backups](Data-and-backups.md)).

- Files stored in the last 24 hours are kept: the editor uploads a file before its bundle is saved, so a file of a
  draft not saved yet looks unused. Choosing a stored file for a field starts its 24 hours again.
- To delete those recent files too, tick **Delete the N recent files too**. If a draft in another tab or browser used
  one, that draft cannot be saved until its file is chosen again.
- Cleanup does not run while a bundle file might point at files this version cannot see: a file saved by a newer
  version, or one with data or field types this version does not know. Those files are listed under
  **Needs attention**. A damaged file whose references are all understood does not stop cleanup; its files are kept.
