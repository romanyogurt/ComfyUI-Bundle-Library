Which versions of ComfyUI Bundle Library runs on, and how it treats files and workflows from other versions of
itself: from the first public release (0.1.0) on, libraries and workflows keep working after an update, and an older
version never damages what a newer one wrote.

- [Supported versions](#supported-versions)
- [Updating safely](#updating-safely)
- [Version markers](#version-markers)
- [Promises](#promises)
- [File states](#file-states)
- [What each state allows](#what-each-state-allows)
- [Three kinds of checks](#three-kinds-of-checks)
- [Workflows and the node](#workflows-and-the-node)

## Supported versions

| | Minimum | Tested with |
| --- | --- | --- |
| ComfyUI | 0.38.0 | 0.38.0 |
| ComfyUI frontend | 1.53.10 | 1.53.10 |
| Python | 3.10 | 3.13 |

- Older versions may work, but are not tested. The node is marked BETA in ComfyUI.
- Bundle Library uses ComfyUI's node API (`comfy_api.latest`) and parts of the frontend (DOM widgets, rebuilding a
  node's outputs, Nodes 2.0). A ComfyUI or frontend update can break it; if it does, please
  [report it](Reporting-problems.md).
- It needs nothing beyond what ComfyUI installs (Pillow, PyAV, NumPy, aiohttp).

## Updating safely

1. Back up the library folder (see [Data and backups](Data-and-backups.md)).
2. Update the node (ComfyUI-Manager, `comfy node update`, or `git pull` in its folder) and restart ComfyUI.
3. Reload the browser page. A page opened before the restart runs the old scripts: it says so and tells you to
   reload, and the server refuses its changes until you do. Likewise, files updated without a restart make the page
   tell you to restart ComfyUI.
4. If something looks wrong, open the library window: files this version cannot use are listed under
   **Needs attention**, with the reason.

## Version markers

| Marker | What it versions | Raised when |
| --- | --- | --- |
| A bundle file's `schema_version` (now 3) | The bundle file format | A change an older version could not fully understand: new keys, field types, file kinds, or a new way of pointing at files. Each bundle is written in the lowest version that holds it: 3 only when a field is turned off |
| `organization.json`'s `schema_version` (now 1) | The categories and favorites file | Nested categories, or new keys |
| `slot_spec`'s `v` (now 1) | What a node records about its outputs | A new shape of that record |
| The API prefix `/v1` | The [HTTP API](HTTP-API.md) | An incompatible change of the API |
| The export manifest's `version` (now 1) | The [export ZIP](File-formats.md#export-zip) | A new shape of the ZIP |
| The package version | Releases | Every release |

## Promises

These hold for the public releases, from 0.1.0 on. Development versions before it are not covered.

- **Upgrades read the past.** Every release reads and runs the bundle files and workflows of the releases before it:
  every `schema_version` of the bundle format (1 to the current one) and `slot_spec` v1. Limits that apply when a
  workflow runs (audio length, samples) are those of the running version.
- **Reading converts in memory only.** Listing, opening and running a bundle of an older version upgrade it in
  memory; the file is not rewritten. A file is written only when you save, trash or restore that bundle, and then in
  the lowest version that holds it. Trashing and restoring do not change the content, so they do not apply the
  writing rules again.
- **What is not understood is not touched.** A file this version cannot fully understand (read-only, newer,
  unsupported or damaged, below) keeps its bytes; you can only delete it for good, by choosing it. Cleaning up unused
  files is refused while such a file could point at one: always for a read-only, newer or unsupported file, and for a
  damaged file unless the rest of it is understood (its files are then kept).
- **Going back.** An older release reports a bundle of a newer schema as newer and leaves it alone, and does not
  clean up unused files while it is there. To go back completely, restore the backup you made before the update.

## File states

| State (`code`) | Meaning | In the library | When a workflow runs |
| --- | --- | --- | --- |
| OK | A supported format that passes every check | As usual | Runs if in use |
| Warning | Keeps the rules of the format, but breaks a writing rule (likely one tightened after it was saved) | `warnings`. The editor shows them at once and does not save until they are fixed | Runs if in use |
| Read-only (`read_only`) | A supported schema, but with keys this version does not know | `read_only`. Every change is refused | Runs if in use |
| Newer (`newer_version`) | A supported format whose `schema_version` is above this version's | Needs attention (`errors`) | Error |
| Unsupported (`unsupported`) | An unknown `format`, or an unknown field type | Needs attention | Error |
| Damaged (`corrupt`) | Not JSON, breaks the rules of the format, or has a malformed marker (`true`, `1.0`) | Needs attention | Error |

A file that cannot be read at all (permissions, disk errors) is `read_error`: it is not called damaged, and it is
read again on the next request.

## What each state allows

| Action | OK | Warning | Read-only, newer, unsupported | Damaged |
| --- | --- | --- | --- | --- |
| Save an edit | Yes | Once the values are fixed | No | No |
| Duplicate | Yes | When the copy meets the writing rules. A copy with values keeps the values that break them; a copy of the structure empties the values but keeps the field names, tags and note | No | No |
| Move to the trash, restore | Yes | Yes | No | No |
| Delete one for good | When it is in the trash, at the revision you saw | The same | With `unreadable=1` only (read-only: also only from the trash) | With `unreadable=1` only |
| Empty the trash | The bundles you saw, if unchanged | The same | Left alone | Left alone |
| Clean up unused files | Its files are kept | The same | Refused while one exists | Refused unless the rest of the file is understood: then its files are kept |

Moving a bundle to another category and starring it work in every readable state: they do not change the bundle
file.

## Three kinds of checks

| Kind | What | When reading | When saving |
| --- | --- | --- | --- |
| Rules of the format | Id format and file name, revision, `deleted_at`, field names present and unique, the `@` prefix, characters not allowed in names, field types, value types, finite numbers, SHA-256 format | Damaged if broken | Refused |
| Writing rules | Lengths of names, tags and notes, number of tags, number of fields, text size, integer range | A warning (the rule may be newer than the file) | Refused |
| Limits when running | Audio decoding limits, 32 outputs | — | A precise error when the workflow runs |

## Workflows and the node

- New inputs of the node are only ever added at the end: ComfyUI saves widget values by position.
- A node's cache key holds only what its outputs carry: each slot's name and type, and the field's value or file
  SHA-256. Changing a bundle's name, note, tags, category or star (or its revision alone) does not make Load Bundle
  and the nodes after it run again.
- A slot the bundle cannot fill (an empty media field, a missing or turned-off field) enters the key with its
  reason, so such a bundle is cached like any other. If that output is linked, Load Bundle fails with the reason. If
  it is not linked, its output carries the reason, and a node linked to it later stops with that reason.
- The output pool (32) only grows: shrinking it would cut links in older workflows.
- A turned-off field is, for the node, a field the bundle does not have. A linked output stays in place, shown as
  turned off, and the run fails with the reason until you turn the field on again or unlink it. Unlinked outputs of
  turned-off fields go away when the outputs are updated, and come back at the end when the field is turned on.
- Names of removed field types or keys are never reused with another meaning.
- A node whose `slot_spec` this version cannot read (from a newer version) keeps its outputs, links and
  `slot_spec` as they are, says so, and does not choose another bundle.
