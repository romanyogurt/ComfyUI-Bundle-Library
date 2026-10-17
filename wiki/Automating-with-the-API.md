Everything the library window does goes through the [HTTP API](HTTP-API), so a script or an agent can build and
use bundles too. This page walks through the common tasks with `curl` and Python. The answers shown are real ones,
shortened.

- [Before you start](#before-you-start)
- [Check the server](#check-the-server)
- [Upload a file](#upload-a-file)
- [Create a bundle](#create-a-bundle)
- [Find bundles](#find-bundles)
- [Change a bundle](#change-a-bundle)
- [Run a workflow with a bundle](#run-a-workflow-with-a-bundle)
- [Export and import](#export-and-import)
- [Tips](#tips)

## Before you start

The examples use ComfyUI's default address. Change `BASE` to yours.

```bash
BASE=http://127.0.0.1:8188/api/bundle-library/v1
```

- Reading needs nothing else. Every write (`POST`, `PUT`, `PATCH`, `DELETE`) needs the header
  `X-Bundle-Library: 1`, and JSON bodies need `Content-Type: application/json`.
- There is no login: anyone who can reach ComfyUI can use the API. Keep ComfyUI on a trusted network.

## Check the server

```bash
curl -s $BASE/health
```

```json
{"version": "0.1.0", "organization": "ok", "bundles": 12, "trash": 1, "corrupt": [], "newer": [],
 "unsupported": [], "legacy_trash": [], "writable": true}
```

## Upload a file

Images, videos and audio are uploaded first; a bundle then points at the file by its SHA-256. Send the `kind` field
before the `file` field (`curl -F` keeps their order).

```bash
curl -s -H "X-Bundle-Library: 1" -F kind=image -F file=@knight.png $BASE/assets
```

```json
{"asset": {"sha256": "37d14be30217437d3ea174955e8dc0768483d52575a8c7f4c15ea8ab4ca58698", "ext": "png",
           "mime": "image/png", "width": 64, "height": 64, "bytes": 177, "original_name": "knight.png"}}
```

Uploading the same file again answers 200 with the same `sha256` (a new file answers 201). Use `kind=video` or
`kind=audio` for the other kinds; the limits are in [File formats](File-formats#names-and-limits).

## Create a bundle

```bash
curl -s -H "X-Bundle-Library: 1" -H "Content-Type: application/json" $BASE/bundles -d '{
  "name": "Red knight", "tags": ["character"], "note": "Made from the API.",
  "fields": [
    {"name": "prompt", "type": "text", "value": "a knight in red armor"},
    {"name": "reference", "type": "image", "asset": {"sha256": "37d14be3…8698", "original_name": "knight.png"}},
    {"name": "steps", "type": "int", "value": 8}
  ]}'
```

The answer (201) is the bundle as stored, with its `id` and `revision` 1. Use the full 64-character `sha256`; it is
shortened here. Add `"category": "<category id>"` to put it in a category (`GET $BASE/categories` lists them). The
field types are `text`, `image`, `video`, `audio`, `boolean`, `int` and `float`
(see [File formats](File-formats#fields)).

## Find bundles

```bash
curl -s "$BASE/bundles?q=knight"            # name, tags, category names, field names, text
curl -s "$BASE/bundles?tag=character&sort=updated"
curl -s $BASE/bundles/<id>                  # one bundle, in full
```

The list gives summaries: each field has a `preview` instead of its value (the first 200 characters of a text, the
size of an image):

```json
{"bundles": [{"id": "ec09bb07-…", "name": "Red knight", "revision": 1, "tags": ["character"],
              "category": null, "favorite": false,
              "fields": [{"name": "prompt", "type": "text", "preview": "a knight in red armor"},
                         {"name": "reference", "type": "image",
                          "preview": {"sha256": "37d14be3…", "width": 64, "height": 64}},
                         {"name": "steps", "type": "int", "preview": 8}]}],
 "errors": [], "categories": [], "organization": {"revision": 0, "state": "ok"}}
```

## Change a bundle

`PUT` replaces the whole bundle. Read it, change what you need, and send it back with the revision you read. With
[jq](https://jqlang.org):

```bash
curl -s $BASE/bundles/<id> \
  | jq '.fields[0].value = "a knight in red armor, castle at dusk"
        | {expected_revision: .revision, name, tags, note, fields}' \
  | curl -s -X PUT -H "X-Bundle-Library: 1" -H "Content-Type: application/json" -d @- $BASE/bundles/<id>
```

The answer is the bundle with `revision` 2. Sending the fields as you read them keeps what you did not mean to
change: a field sent without something loses it (an `asset` without its `original_name` loses the file's name, and a
field without `"enabled": false` is turned on).

If someone saved the bundle in between, you get 409 instead. Read it again, apply your change to what you read,
and send it again:

```json
{"error": {"code": "revision_conflict", "current_revision": 2,
           "message": "The bundle has changed since it was loaded (now revision 2)."}}
```

To change many bundles at once (move them, star them, add or remove tags, trash them), use
[`POST /bundles/batch`](HTTP-API#several-bundles-at-once).

## Run a workflow with a bundle

In an API-format prompt, a Load Bundle node takes the bundle's id and a `slot_spec` that says which field each
output carries. Make `slot_spec` from the bundle's fields that are on, in their order (this is what the node's page
does when you first choose a bundle); the first slot is output 0.

This example queues Load Bundle with a Preview Any node showing the `prompt` field, then reads the result:

```python
import json, time, urllib.request

COMFY = "http://127.0.0.1:8188"
BASE = COMFY + "/api/bundle-library/v1"

def call(method, url, body=None, write=False):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if write:
        headers["X-Bundle-Library"] = "1"
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(url, data, headers, method=method)) as answer:
        return json.load(answer)

bundle = call("GET", f"{BASE}/bundles/<id>")
slots = [{"name": f["name"], "type": f["type"]} for f in bundle["fields"] if f.get("enabled", True)]
spec = json.dumps({"v": 1, "slots": slots})
prompt_output = next(i for i, s in enumerate(slots) if s["name"] == "prompt")

prompt = {
    "1": {"class_type": "BundleLibraryLoad", "inputs": {"bundle_id": bundle["id"], "slot_spec": spec}},
    "2": {"class_type": "PreviewAny", "inputs": {"source": ["1", prompt_output]}},
}
prompt_id = call("POST", f"{COMFY}/api/prompt", {"prompt": prompt})["prompt_id"]
while not (entry := call("GET", f"{COMFY}/api/history/{prompt_id}").get(prompt_id)):
    time.sleep(0.5)
print(entry["status"]["status_str"], entry["outputs"])
# success {'2': {'text': ['a knight in red armor, castle at dusk']}}
```

- `/api/prompt` is ComfyUI's own API and needs no extra header.
- To use a bundle in a workflow you made in the editor, export it with **Workflow → Export (API)** and change the
  Load Bundle node's `bundle_id`. Keep its `slot_spec` when the other bundle has the same fields; the links in the
  workflow follow the slot order.
- If a linked field is missing or empty (a media field without a file), the run fails with the reason.

## Export and import

Export one or more bundles, with the files they use, to a ZIP:

```bash
curl -s -H "X-Bundle-Library: 1" -H "Content-Type: application/json" $BASE/export -d '{"ids": ["<id>"]}'
# {"token": "Lw5bajS0JZNo7gcvk5EGuw", "file_name": "Red knight.zip", "bytes": 1459, "bundles": 1, "assets": 1,
#  "skipped": [], "missing": []}
curl -s -o "Red knight.zip" "$BASE/export/Lw5bajS0JZNo7gcvk5EGuw"
```

The token works for an hour. Import a ZIP in two steps: upload it for a preview, then apply it.

```bash
curl -s -H "X-Bundle-Library: 1" -F file=@"Red knight.zip" $BASE/import
# {"token": "SfRr_6DaKoTHdx9iDOiPOw", "bundles": [{"id": "ec09bb07-…", "name": "Red knight",
#   "importable": true, "conflict": "active", …}], "assets": {"new": 0, "present": 1, "missing": 0, "bytes": 0}, …}
curl -s -H "X-Bundle-Library: 1" -H "Content-Type: application/json" $BASE/import/SfRr_6DaKoTHdx9iDOiPOw \
     -d '{"conflict": "copy", "category": {"mode": "zip"}}'
# {"imported": 1, "skipped": 0, "failed": 0, "results": [{"id": "ff129b58-…", "source": "ec09bb07-…",
#   "ok": true, "changed": true, "as": "copied"}], …}
```

`conflict` decides what happens to bundles that are here already (`skip`, `overwrite` or `copy`), and `category`
where the bundles go (`{"mode": "zip"}`, `{"mode": "one", "id": …}` or `{"mode": "none"}`). Details are in
[HTTP API](HTTP-API#import).

## Tips

- Check `code` in an error, not the message: messages may be reworded.
- Ids are UUIDs and never change. Names can repeat, so look bundles up by name only when you know it is unique.
- `PUT`, trashing and deleting for good take the revision you read and refuse a stale one (409
  `revision_conflict`), so two writers do not overwrite each other silently there. Other writes act on the bundle as
  it is: moving it to a category, starring it, tag actions, and an import that overwrites it.
- Prefer the API to editing the library's files: it checks every change, keeps revisions, and writes each file
  safely. The files themselves are described in [File formats](File-formats).
- Deleting a bundle moves it to the trash (`DELETE /bundles/<id>?expected_revision=N`); `POST /bundles/<id>/restore`
  brings it back.
