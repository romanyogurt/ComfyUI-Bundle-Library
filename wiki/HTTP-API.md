Bundle Library keeps its data on the ComfyUI server and serves it over a small HTTP API. The node's own pages
use it, and so can scripts and agents. For worked examples, see [Automating with the API](Automating-with-the-API).
The files behind it are described in [File formats](File-formats).

- [Basics](#basics)
- [Writing](#writing)
- [Endpoints](#endpoints)
- [Bundle summaries](#bundle-summaries)
- [Several bundles at once](#several-bundles-at-once)
- [Export](#export)
- [Import](#import)
- [Tags](#tags)
- [Translated messages](#translated-messages)
- [Errors](#errors)

## Basics

- The API is served under `/api/bundle-library/v1` on the ComfyUI server, for example
  `http://127.0.0.1:8188/api/bundle-library/v1/health`. ComfyUI serves the same routes without `/api` too; the
  node's pages call them through `api.fetchApi("/bundle-library/v1/...")`.
- Requests and answers are JSON (UTF-8), except file uploads (multipart) and downloads.
- There is no login. Like ComfyUI itself, anyone who can reach the server can read the library. If you start
  ComfyUI with `--listen`, put it behind a VPN or a proxy that asks for a login. Writes have the extra checks
  below, which stop other web sites from changing the library through your browser; they are not a login.
- With `--multi-user`, all ComfyUI users share one library.

## Writing

`POST`, `PUT`, `PATCH` and `DELETE` requests must meet all of these, or they are refused with 403:

| Check | Refused as |
| --- | --- |
| The header `X-Bundle-Library: 1` | `missing_header` |
| `Sec-Fetch-Site`, when sent, is `same-origin` or `none` | `cross_site` |
| `Origin`, when sent, matches `Host` | `origin_mismatch` |

A command-line client such as curl sends neither `Sec-Fetch-Site` nor `Origin`, so the header is all it needs.

- A JSON body needs `Content-Type: application/json` (otherwise 415) and may be up to 4 MB.
- Each route has required keys, optional keys (shown with `?`, which have defaults) and keys that take `null`. A
  missing required key is refused with 400 `invalid` ("Missing in the request: …"); it is never read as empty.
  Everything is checked before anything is written.
- Text that is not valid Unicode (lone surrogates) or JSON nested too deeply is refused with 400 `invalid_json`.
- The node's pages also send `X-Bundle-Library-Version`. When it differs from the server's version, the write is
  refused with 409 `version_mismatch`, with `page_version` and `server_version`. A request without this header
  (a script) is not checked.
- Every file is written to a temporary file, synced, then put in place in one step. If that fails, nothing was
  written: a single request answers 500 `io_error` with `"retry": true`. If only the sync of the folder fails
  afterwards, the change is made and reported with a `warning` (a power cut could still lose it).
- Categories and favorites live in `organization.json`, apart from the bundles. When a bundle is made or
  duplicated but its category cannot be written, the request still succeeds and says why in `placement_error`.
  Set the category again; the bundle is not made twice.

## Endpoints

Paths are relative to `/api/bundle-library/v1`. `{id}` is a bundle id (a UUID) unless the row says otherwise.

### The library

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| GET | `/health` | — | `{"version", "organization", "bundles", "trash", "corrupt", "newer", "unsupported", "legacy_trash", "writable"}`. `bundles` and `trash` are counts. `corrupt`, `newer` and `unsupported` list the bundle files in that state (see [Compatibility and versions](Compatibility-and-versions#file-states)). `organization` is the state of `organization.json`: `missing`, `ok`, `read_only`, `newer_version`, `unsupported` or `corrupt` |
| GET | `/messages?lang=` | — | The message catalogs for a language: see [Translated messages](#translated-messages) |

### Bundles

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| GET | `/bundles` | Query: `q` (searches names, tags, category names, field names and text values), `tag`, `sort` (`name`, the default, or `updated`) | `{"bundles": [summary], "errors": [{"file", "id", "code", "error"}], "categories": [{"id", "name", "parent", "count"}], "organization": {"revision", "state"}}`. Bundles in the trash are left out. `errors` lists the files this version cannot use. `categories` are sorted by name, and `count` counts the filtered list |
| POST | `/bundles` | `{"name", "tags"?, "note"?, "fields"?, "category"?}` | 201 and the bundle. `category` is a category id |
| GET | `/bundles/{id}` | — | The bundle, with `warnings` and `read_only` when they apply (see [Bundle summaries](#bundle-summaries)). 404 `in_trash` when it is in the trash |
| PUT | `/bundles/{id}` | `{"expected_revision", "name", "tags", "note", "fields"}`, all required: the whole bundle is replaced | The bundle, its `revision` one higher. 409 `revision_conflict` (with `current_revision`) when the bundle changed since you read it |
| DELETE | `/bundles/{id}?expected_revision=N` | — | `{"deleted": id, "changed", "warning"?}`. Moves the bundle to the trash (revision +1). `changed` is false when it was there already |
| POST | `/bundles/{id}/duplicate` | `{"mode"?, "name"?}`. `mode` is `values` (the default: a full copy) or `structure` (the same fields with empty values and no files) | 201 and the new bundle, with the same tags and note, in the same category. The name defaults to `<name> copy` |
| POST | `/bundles/{id}/restore` | — | The bundle back from the trash, with the same id and name (revision +1), in its old category |
| PUT | `/bundles/{id}/category` | `{"category": id or null}` (the key is required; `null` takes it out of its category) | `{"id", "category"}`. Works for bundles in the trash too. The revision does not change |
| PUT | `/bundles/{id}/favorite` | `{"favorite": true or false}` | `{"id", "favorite"}`. The revision does not change |
| POST | `/bundles/batch` | `{"ids", "action", …}` | One action on many bundles: see [Several bundles at once](#several-bundles-at-once) |

### Categories

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| GET | `/categories` | — | `{"categories": [{"id", "name", "parent", "count"}], "revision", "state"}` |
| POST | `/categories` | `{"name", "parent"?}` | 201 and `{"id", "name", "parent"}`. Categories cannot be nested yet: a `parent` is refused with 400 `nesting_not_supported` |
| PATCH | `/categories/{id}` | `{"name"}` | `{"id", "name", "parent"}` |
| DELETE | `/categories/{id}` | — | `{"deleted": id, "uncategorized": count}`. Its bundles (those in the trash too) become uncategorized; the bundles themselves do not change |

### Tags

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| GET | `/tags` | — | `{"tags": [{"name", "spellings", "active", "trash", "protected"}], "unreadable", "legacy"}`: see [Tags](#tags) |
| POST | `/tags/rename` | `{"from", "to"}` | `{"changed", "merged", "excluded", "unknown", "legacy", "warning"?}`. Renames the tag in every bundle, those in the trash too. When `to` exists already, the two are merged |
| POST | `/tags/delete` | `{"tag"}` | `{"changed", "excluded", "unknown", "legacy", "warning"?}`. Takes the tag off every bundle, those in the trash too |

### Stored files

Images, videos and audio are stored once, named by the SHA-256 of their bytes, and bundles point at them. Upload
a file first, then put its `sha256` in a field.

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| POST | `/assets` | Multipart: a `kind` field (`image`, `video` or `audio`; `image` if absent), then the `file` field. `kind` must come first: it picks the size limit | `{"asset": {"sha256", "ext", "mime", "bytes", …, "original_name"}}`: 201 for a new file, 200 when the same file was stored before. The other keys describe the file (see [File formats](File-formats#fields)) |
| GET | `/assets?kind=` | `kind` is required | `{"assets": [{"sha256", "ext", "mime", "bytes", …, "stored_at", "names", "used_by": [{"id", "name", "field", "deleted"}]}]}`: every stored file of that kind, the most recently stored first. `names` are the names bundles gave the file, the most used first; `used_by` are the bundles that use it (those in use first, then those in the trash) |
| POST | `/assets/{sha256}/use` | — | `{"asset": {…}}`. Tells the server that a draft now uses this stored file: its grace time before a cleanup starts again, as if it were uploaded again. 404 `not_found` when there is no such file |
| GET | `/assets/{sha256}` | — | The file as stored. Range requests work, so browsers can stream and seek. Sent with `Cache-Control: immutable` |
| GET | `/assets/{sha256}/thumb?size=` | `size` is 128, 256 or 512 | A WebP thumbnail of an image, or a frame of a video. Audio has none (404) |

### Trash and cleanup

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| GET | `/trash` | — | `{"trash": [summary with "deleted_at"], "errors": [{"file", "id", "code", "error"}]}`, the last deleted first. A summary's `category` is where the bundle goes back to |
| DELETE | `/trash/{id}?expected_revision=N` | `expected_revision` is required, except with `unreadable=1`, which deletes a file this version cannot fully read | `{"deleted": id}`. Deletes a bundle in the trash for good, if it is still at the revision you saw (else 409 `revision_conflict`) |
| DELETE | `/trash` | `{"expected_revisions": {id: revision}}` | `{"deleted": count, "results": [...]}`. Empties the trash of the bundles you saw, at those revisions. Bundles trashed since, and files this version cannot fully read, stay |
| GET | `/cleanup` | — | `{"assets": [{"sha256", "kind", "ext", "bytes", "stored_at"}], "bytes", "recent", "recent_assets": [...], "grace_hours"}`: the stored files that no bundle uses, not even one in the trash, the oldest first. Files stored within the grace time (24 hours) are listed apart in `recent_assets` (`recent` is their count) |
| POST | `/cleanup` | `{"sha256": [...], "recent"?: true}` | `{"deleted", "bytes", "kept", "thumbnails"}`. Deletes those files (and their thumbnails) if they are still unused. Files within the grace time go only with `"recent": true` |

The grace time exists because the library window uploads a file before its bundle is saved: a file of a draft not
saved yet looks unused. Cleanup refuses to run (409 `unreadable_bundles`, with the file names in `files`) while
any bundle file cannot be fully understood, since the files it uses could look unused. See
[Compatibility and versions](Compatibility-and-versions#what-each-state-allows).

### Export and import

| Method | Path | Request | Answer |
| --- | --- | --- | --- |
| POST | `/export` | `{"ids"}`, 1 to 1000 bundle ids | 201 and `{"token", "file_name", "bytes", "bundles", "assets", "skipped", "missing"}`: the ZIP is made: see [Export](#export) |
| GET | `/export/{token}?name=` | `name` is the file name to download as (use the `file_name` above) | The ZIP, as an attachment. Without `name` it is called `bundle-library-<date>-<time>.zip`. A token lasts one hour |
| POST | `/import` | Multipart: the `file` field, a ZIP of up to 4 GiB | 201 and a preview `{"token", "file_name", "exported_at", "generator", "bundles", "assets"}`. Nothing in the library changes yet: see [Import](#import) |
| POST | `/import/{token}` | `{"conflict", "category"}`, both required | `{"results", "categories_created", "placement_error"?, "warning"?, "files", "imported", "skipped", "failed"}`. Imports the uploaded ZIP, then deletes it |
| DELETE | `/import/{token}` | — | `{"discarded": true}`. Deletes an upload you will not import (or the answer kept for an import that ran). 409 `import_running` while it runs |

## Bundle summaries

`GET /bundles` and `GET /trash` give a summary of each bundle: the bundle's keys, and for each field a `preview`
instead of its value:

| Field type | `preview` |
| --- | --- |
| `text` | The first 200 characters |
| `image` | `{"sha256", "width", "height"}`, or `null` without a file |
| `video` | `{"sha256", "width", "height", "duration"}`, or `null` |
| `audio` | `{"sha256", "duration"}`, or `null` |
| `boolean`, `int`, `float` | The value |

- A summary also has `category` (an id or `null`) and `favorite`. When `organization.json` cannot be read, they are
  `null` and `false`.
- A field that is turned off has `"enabled": false`.
- `warnings` lists the writing rules a bundle breaks (a rule tightened after it was saved); it can still be used,
  but must be fixed before it is saved again. `read_only` says why this version cannot change a bundle (it has data
  this version does not know). Both appear on a full bundle too.
- Browsers read JSON numbers as doubles, so an integer beyond ±(2^53−1) would change on its way. Answers carry such
  values exactly as decimal text in `value_text` (and as the `preview`). `value_text` is never written to files.

## Several bundles at once

`POST /bundles/batch` applies one action to several bundles:

```json
{"ids": ["0b0fd10b-…", "6f1c0e5a-…"], "action": "trash",
 "expected_revisions": {"0b0fd10b-…": 3, "6f1c0e5a-…": 1}}
```

| `action` | Its argument | What it writes |
| --- | --- | --- |
| `set_category` | `category`: a category id, or `null` to take the bundles out of theirs | `organization.json`, once |
| `set_favorite` | `favorite`: `true` or `false` | `organization.json`, once |
| `trash` | `expected_revisions`: bundle id → the revision you saw | Each bundle file |
| `add_tags` | `tags`: 1 to 20 tags to add | Each bundle file that changes |
| `remove_tags` | `tags`: 1 to 20 tags to take off | Each bundle file that changes |

- The whole request is checked first; if anything is wrong, nothing is written. Refused are: empty `ids`, an id that
  is not a UUID, more than 1000 ids, an unknown `action` (400 `invalid`), a wrong or missing argument, a category
  that does not exist (404), an `organization.json` this version cannot change (409 `organization_unwritable`), and
  a `trash` without a revision for every id (400).
- Repeated ids count once. Results come in the order of first appearance.
- Categories and favorites are applied to the latest `organization.json`, written once if anything changes. Bundle
  files and revisions stay as they are; read-only bundles can be moved too.
- `trash` checks each bundle's revision and skips one that changed (`revision_conflict`). Tags are changed on the
  bundle as it is stored at that moment (no revision is needed). A bundle that would get more than 20 tags is
  skipped with `too_many_tags`.
- Each bundle is written on its own: a failure leaves the bundles before it changed and goes on with the rest.

The answer is always 200 once the request is accepted:

```json
{"action": "trash", "changed": 1, "unchanged": 0, "failed": 1,
 "results": [
   {"id": "0b0fd10b-…", "ok": true, "changed": true, "revision": 4},
   {"id": "6f1c0e5a-…", "ok": false, "changed": false, "code": "revision_conflict", "message": "…"}]}
```

- `ok` and `changed` tell a change, a success with nothing to change (already so), and a failure apart. Nothing is
  touched when nothing changes. `revision` is the bundle's new revision when its file was written.
- A failure's `code` is the same as for a single request (`not_found`, `revision_conflict`, `read_only`,
  `newer_version`, `unsupported`, `corrupt_bundle`, …), with that error's details. A failed write is `io_error`
  with `"retry": true`.
- `DELETE /bundles/{id}`, `PUT /bundles/{id}/category` and `PUT /bundles/{id}/favorite` run the same code for one
  bundle.

## Export

`POST /export` writes the chosen bundles and the files they use into one ZIP (its layout is in
[File formats](File-formats#export-zip)).

- Bundle files go in as stored, byte for byte, so values and keys this version does not know travel too. Read-only
  bundles are included.
- Bundles in the trash, files this version cannot read, and ids that do not exist are left out and listed in
  `skipped` as `{"id", "code", "reason"}`. When nothing can be exported, the answer is 409 `nothing_to_export`.
- Each file the bundles use goes in once. A file missing from the library is listed in `missing` as
  `{"sha256", "bundles"}` (the names of the bundles that use it); the bundles go in without it.
- Categories go by name (ids differ between libraries). Favorites are not exported.
- `file_name` is `<bundle name>.zip` for one bundle, else `bundle-library-<date>-<time>.zip`.

## Import

An import is two steps: upload the ZIP for a preview, then apply it (or discard it).

1. `POST /import` takes the ZIP, checks it, and says what importing it would do. The library does not change.

   ```json
   {"token": "…", "file_name": "export.zip", "exported_at": "…", "generator": "Bundle Library 0.1.0",
    "bundles": [{"id", "name", "category", "importable", "reason", "conflict", "missing_files", "tags", "fields"}],
    "assets": {"new", "present", "missing", "bytes"}}
   ```

   `conflict` says whether that id is here already: `none`, `active` (in use), `trash`, or `unreadable` (a file
   this version cannot read). When `importable` is false, `reason` says why. `assets` counts the files the
   bundles use: coming from the ZIP (`new`, `bytes` in all), already here, and missing from both.
2. `POST /import/{token}` imports it; `DELETE /import/{token}` throws it away. An upload neither imported nor
   discarded is deleted after an hour.

The choices:

- `conflict`, for ids that are here already: `skip` keeps the bundle here; `overwrite` writes the file's content
  over it (its revision goes one past the one here, it keeps its `created_at`, and a bundle in the trash comes back,
  reported as `restored`); `copy` makes a new bundle with a new id. A bundle this version cannot change is never
  overwritten; that bundle fails instead.
- `category`: `{"mode": "zip"}` follows the category names in the ZIP, using a category of the same name (ignoring
  case) or making one. `{"mode": "one", "id": …}` puts every bundle in that category. `{"mode": "none"}` leaves them
  uncategorized. Overwritten bundles follow this choice too; skipped ones stay where they are. Favorites do not
  change.

What happens:

- The ZIP is checked again and the library's state at that moment is followed. The files that the bundles to be
  written use, and that are not here yet, come in first; they pass the same checks as an upload, and their bytes must
  match their SHA-256. Then the bundles are written, then their categories, in one change of `organization.json`.
- `results` has one entry per bundle, in ZIP order: `{"id" (its id here), "source" (its id in the ZIP), "ok",
  "as": "new" | "overwritten" | "copied" | "skipped", "revision"?, "restored"?}`. A failure has `"ok": false`, a
  `code` and a `message`: `not_importable` (this version cannot import it: the preview's `reason`),
  `file_failed` (a file it uses could not come in), or the error of the write (`wrong_kind`, `file_missing`,
  `read_only`, …).
- `files` is `{"stored", "present", "failed": [{"sha256", "reason"}]}`; `categories_created` is
  `[{"id", "name"}]`; `placement_error` says why categories could not be written, if so.
- A bundle whose file is missing from both the ZIP and the library comes in without it (the preview counts these).
- An import runs once. While it runs, the same token gets 409 `import_running`. Once it is done, sending the same
  token again does not run it again: it returns the same answer with `"replayed": true`, for an hour, whatever the
  choices are by then. If the server stopped in the middle, the token gets 409 `import_interrupted`: read the list
  to see what came in, and upload the file again for the rest.

The checks (400 `invalid_export` when the ZIP or its manifest is wrong, 400 `newer_export` for a newer format):

- The upload is limited to 4 GiB (413 `too_large`), the unpacked total to 8 GiB, the entries to 10,000, one bundle
  file to 40 MB and `manifest.json` to 16 MB. Sizes are counted as the bytes really unpack, not as the ZIP claims.
  Encrypted entries are refused.
- The manifest lists at most 1,000 bundles, each a UUID at `bundles/<id>.json`, never twice. Files are
  `assets/<sha256>.<ext>`, with an extension that matches their `kind`. Entries are read only by the names the
  manifest gives, so paths inside the ZIP (such as `../`) never reach the disk.
- A bundle file must match its SHA-256 in the manifest, be readable and writable by this version, and hold the id
  its file name gives. Its media fields must point at files of their own kind. Otherwise only that bundle is
  `not_importable`.

## Tags

A tag is part of a bundle. Two tags are the same when Python's `casefold()` makes them equal: `Portrait` and
`portrait`, `Straße` and `STRASSE`. A bundle keeps one of each when saved. The pages compare tags the same way.

The tag actions (batch `add_tags` and `remove_tags`, `/tags/rename`, `/tags/delete`) change only the tags of a
bundle and leave its other values as stored, even values that a newer rule would refuse. New tags follow the
writing rules; the tag you look for (`from`, a tag to take off) can be any text. Only bundles that really change
get a new revision. Tags do not take part in the node's cache key.

- `GET /tags` counts each tag once over the bundle files this version can read (in use and in the trash). `name`
  is the spelling most bundles use, `spellings` lists every spelling, `active` and `trash` count the bundles with the
  tag, and `protected` counts those this version cannot change. `unreadable` counts the bundle files this version
  cannot read (their tags are unknown); `legacy` counts files left in the old trash folder.
- `POST /tags/rename` renames `from` to `to` in every bundle. A bundle that has both keeps one `to`, where the
  first of the two was (`merged` counts these): `["Flowers", "old"]` with `old → flowers` becomes `["flowers"]`. You
  can change only the case. `from` equal to `to` is refused (400).
- `POST /tags/delete` takes the tag off every bundle that has it.
- `changed` counts the bundles changed. `excluded` lists the bundles that have the tag but were left
  (`[{"id", "name", "code", "reason", "retry"?}]`: this version cannot change them, or the write failed);
  `unknown` lists files that could not be read (`[{"file", "reason"}]`).

## Translated messages

Every message in an answer (an error's `message`, the per-bundle `message` and `reason` of batch, export and
import results, `warning`, `placement_error`, a bundle's `read_only` and `warnings`, the `error` of `errors`) is an
English sentence. Next to it, `<key>_i18n` gives the message's id and values, so a page can say it in its own
language. A list of messages (`warnings`) gets a list in the same order (`null` where a message has no id).

```json
{"error": {"code": "wrong_kind", "message": "Field 'ref': the file is an audio, not an image.",
           "message_i18n": {"id": "store.wrong_kind",
                            "values": {"name": "ref", "kind": {"id": "kind.an_audio", "values": {}},
                                       "type": {"id": "kind.an_image", "values": {}}}}}}
```

- A value is a name or a number (shown as it is), or another message `{"id", "values"}` (a word to translate,
  such as "an image"). Names of bundles, fields, categories, tags and files are never translated. A message whose
  form depends on a number picks it with the value `count`.
- Text from the system (the reason of a disk error) stays a value, in English.
- Errors of the node while a workflow runs are shown by ComfyUI as they are, in English.

`GET /messages?lang=<code>` gives the catalogs a page needs (no write header is needed):

```json
{"languages": ["en", "ko"],
 "messages": {"en": {"trash.empty_confirm": "Empty the trash?",
                     "count.bundles": {"one": "{count} bundle", "other": "{count} bundles"}},
              "ko": {"trash.empty_confirm": "휴지통을 비울까요?", "count.bundles": "번들 {count}개"}}}
```

- `languages` are the languages with a catalog. `messages` holds English and the language for `lang`: the same
  code ignoring case, else its base language (`ko-KR` gives `ko`). Without a match, only English.
- The catalogs are read from disk on each request, so a server updated but not restarted already sends the new ones.
- How to add a language is in [Translations](Translations).

## Errors

An error answer is `{"error": {"code", "message", …}}`. `message` is an English sentence that can be shown as it
is (with `message_i18n` beside it), and never holds a file path. Programs should use `code`.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid` | A value or the shape of the request breaks a rule |
| 400 | `invalid_id` | Not a UUID (bundle, category) or not a SHA-256 (file) |
| 400 | `invalid_json` | The body cannot be read as JSON |
| 400 | `nesting_not_supported` | A category inside a category |
| 400 | `unsupported_type` | A field type this version does not know |
| 400 | `unknown_asset` | A field points at a file that was never uploaded |
| 400 | `wrong_kind` | The file's kind differs from the field's type (an image in a `video` field) |
| 400 | `corrupt_image`, `corrupt_media` | An image or audio file does not decode to the end, or a video's first frame does not |
| 400 | `invalid_export`, `newer_export` | Not an export this version can read; an export of a newer format |
| 403 | `missing_header`, `cross_site`, `origin_mismatch` | A write without the conditions in [Writing](#writing) |
| 404 | `not_found` | No such bundle, category, file or import; also the thumbnail of an audio file |
| 404 | `in_trash` | The bundle is in the trash (restore it to use it) |
| 409 | `revision_conflict` | `expected_revision` is not the current one; `current_revision` comes with it |
| 409 | `in_trash`, `not_in_trash` | Changing or duplicating a bundle in the trash; restoring, or deleting for good, a bundle in use |
| 409 | `read_only` | The bundle has data this version does not know, so it cannot change it |
| 409 | `newer_version`, `unsupported` | A file saved by a newer version; a file of another format or with an unknown field type |
| 409 | `unreadable_file` | Deleting for good a file this version cannot fully read, without `unreadable=1` |
| 409 | `unreadable_bundles` | Cleanup cannot tell which files are unused while some bundle file cannot be fully read; `files` names them |
| 409 | `category_conflict` | A category with that name exists (ignoring case) |
| 409 | `organization_unwritable` | `organization.json` cannot be changed by this version; `state` comes with it |
| 409 | `too_many_tags` | The bundle would have more than 20 tags (in batch results) |
| 409 | `nothing_to_export` | None of the bundles can be exported; `skipped` comes with it |
| 409 | `import_running`, `import_interrupted` | The import is running; the server stopped while it ran |
| 409 | `version_mismatch` | The page and the server run different versions |
| 413 | `too_large`, `too_many_pixels`, `too_long`, `too_many_samples` | Over a limit: body or file size, pixels, audio length, audio samples |
| 415 | `unsupported_media_type`, `unsupported_format` | The body's content type; a file format that is not accepted, or a file of another kind than the field |
| 500 | `io_error` | The library folder could not be read or written; `"retry": true` |
| 500 | `corrupt_bundle`, `internal` | A bundle file cannot be read; another server error (the ComfyUI log has the details) |
