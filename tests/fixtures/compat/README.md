# Compatibility fixtures

Files that released versions of the node wrote, and files made by hand to try the edges of the formats. Every new
version must read them as the compatibility contract says ([Compatibility and versions](../../../wiki/Compatibility-and-versions.md)).

- **Fixtures are never changed or removed.** When a format changes, new fixtures are added. The code is made to fit
  the fixtures, never the fixtures to fit the code.
- The records below say where each fixture came from; they are not recipes to make it again. Made again, it would
  have other UUIDs and times.

## Libraries made by released code

Made on 2026-10-16 with `generate.py`: the git worktree of each release was mounted read-only into a container of a
ComfyUI image (Python 3.13 with ComfyUI's requirements). The media are synthetic files made with this repository's
`tests/helpers.py`. `tmp/` and `thumbs/` were left out.

```bash
docker run --rm --entrypoint python -e CUDA_VISIBLE_DEVICES= \
    -v <worktree>:/src:ro -v <this repo>/tests:/cur:ro -v <out>:/out <image> \
    /cur/fixtures/compat/generate.py --recipe <recipe> --out /out/<folder>
```

| Folder | Release | Recipe | What it holds |
| --- | --- | --- | --- |
| `0.0.2-phase1/` | `v0.0.2` | `phase1` | Text (several lines, spaces at both ends), an image, an empty image field, a boolean, an integer, a float |
| `0.0.8-phase6/` | `v0.0.8` | `phase6` | An MP4 with sound, a WAV, empty video and audio fields, an image, the largest safe integer |
| `0.0.10/` | `v0.0.10` | `0.0.10` | One active bundle, and one deleted bundle in the old `trash/` folder |

Expected: all three are version 1 files in a good state. They are read without being written again, and they run in
the node. The file in `0.0.10/trash/` is moved on start into `bundles/`, as a version 2 bundle with `deleted_at`.

## A backup and a workflow of 0.0.10

- `backup-0.0.10.zip`: a backup of the `0.0.10/` library, made by the backup script of the setup the pack was
  developed in, as it was at 0.0.10. It holds the old `trash/`. Expected: it passes the check, and once restored,
  the file in the trash is moved to version 2 on start.
- `0.0.10-workflow/`: a workflow saved with `make_workflow.cjs` on a test server running node 0.0.10 and frontend
  1.53.10.
  - `workflow.json`: one Load Bundle node (outputs prompt, ref, seed and flag; the first three linked to preview
    nodes). `workflow-bundle.json` and `workflow-ref.png` are the bundle and image it used. Expected: loaded with its
    `bundle_id` changed to a bundle with the same fields, the outputs' names, types and order come back, and so do
    the links and the previews.
  - `workflow-unknown-slot-type.json`: the workflow above, with only the type of flag in its `slot_spec` changed to
    `mesh`. Expected: loaded and saved, the `slot_spec` text, the outputs and the links stay as they were, and the
    node shows a notice.

## Bundle files made by hand (`handmade/`)

Made on 2026-10-16. The expected state of each, and its error code in the list, are in `handmade/expected.json`.

- Warning (read, but past the rules for writing): the integers 2^53+1, 2^60 and 2^63−1, a name of 121 characters
- Damaged: the marker `true` or `1.0`, two fields of one name, a missing or wrong `deleted_at` in version 2, a file
  that is not JSON
- Newer version: `schema_version: 3` pointing at files with `resources` (`v3-other-references`: a cleanup must not
  miss those files). Version 3 came with 0.0.30, so this fixture became a read-only file of version 3 with an
  unknown key `resources` (the cleanup still stops). The newer-version case is now `newer-other-references`
  (`schema_version: 99`, added in 0.0.30)
- Unsupported: an unknown `format`, an unknown field type `mesh`
- Read-only: unknown keys at the top, in a field and in a file's details
- Good: an active and a deleted bundle of version 2, two bundles of one name

Added on 2026-10-19, with version 4 (choice fields, 0.2.0):

- Good: `v4-choice`, choices with and without a source, one whose source this ComfyUI does not have (a node pack's
  name with spaces and parentheses), one turned off, and a value with spaces at both ends (kept as it is)
- Read-only: a choice field in a version 3 file (`v3-choice`), a source with a key version 4 does not define
  (`v4-unknown-source-key`), a source on a text field (`v4-source-on-text`)
- Damaged: a source that is a string, not an object (`v4-bad-source`)

## The old trash, moved (`legacy-trash/`)

`bundles/` and `trash/` shaped as in 0.0.10. The expected result is in `legacy-trash/expected.json`.

- Moved: a readable file whose UUID is in no other file; of two copies of one UUID, the one deleted last
- Left where it is: a file whose UUID is in `bundles/` too, the second copy of one UUID, a file that cannot be read
