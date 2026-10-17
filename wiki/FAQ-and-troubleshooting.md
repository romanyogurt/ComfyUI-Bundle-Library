Common questions first, then what to do when something goes wrong. If your problem is not here, see
[Reporting problems](Reporting-problems).

## Questions

### Can two bundles have the same name?

Yes. Workflows point at bundles by id, not by name. The library tells bundles of the same name apart by the start of
their id.

### How do I share bundles, or a workflow that uses them?

Export the bundles to a ZIP and import it on the other side; the bundles keep their ids, so a workflow that uses them
finds them. See [Import and export](Import-and-export#sharing-a-workflow-with-its-bundles).

### Where are my files? Can other workflows use them?

They are in the library folder on the ComfyUI server, under `assets/`, named by their content (see
[Data and backups](Data-and-backups)). Use them in a workflow through a Load Bundle node.

### Does it work with Nodes 2.0?

Yes. Load Bundle works with the classic node look and with Nodes 2.0.

### Why is the node marked BETA?

The first public releases are marked BETA while they meet many more setups. Your bundles are safe across updates:
see [Compatibility and versions](Compatibility-and-versions#promises).

### Can a script or an AI agent use the library?

Yes, through the HTTP API. See [Automating with the API](Automating-with-the-API).

## Troubleshooting

### The page shows names like `library.open` instead of text

The page could not get its messages from the server. It keeps asking: the node panels and the sidebar change as
soon as they arrive, and the library window when it next opens. If it lasts, reload the page and look at the ComfyUI
log for lines starting with `[Bundle Library]`.

### The page says ComfyUI runs another version of Bundle Library

The browser page and the server run different versions. Do what it says: **Reload the page** when the page is older
(it was opened before an update), or **restart ComfyUI** when the files were updated but ComfyUI was not restarted.
Until then, the page cannot change the library.

### A run stops at Load Bundle

The message says which output the bundle cannot fill, and why:

| The reason says it… | Do this |
| --- | --- |
| is missing from the bundle | The bundle has no field of that name. Choose a bundle that has it, add the field, or unlink the output |
| is turned off in the bundle | Turn the field on in the editor, or unlink the output |
| is *a type*, not *another type* | The field has the name but another type. Fix the field, or relink |
| has no image (video, audio) | The media field is empty. Add a file |
| has an image (video, audio) file that is missing from the library | The file was deleted, or the library was copied without `assets/`. Choose the file again, or restore it from a backup |

See [The Load Bundle node](The-Load-Bundle-node#when-a-bundle-cannot-fill-an-output). A node after Load Bundle that
stops with *Execution Blocked* and the same reason was linked to an output that cannot be filled, after a run that
did not need it.

### The node's outputs did not change after I edited the bundle

The node does not rebuild its outputs by itself. Its panel says *Bundle fields changed*: click **Update outputs**.
Linked outputs are never removed or retyped; see
[The Load Bundle node](The-Load-Bundle-node#how-the-outputs-follow-the-bundle).

### The node says *Bundle not found or in the trash*

Restore the bundle from the [trash](The-library-window#the-trash), or import it again (it keeps its id). If it was
deleted for good and you have no copy, choose another bundle.

### The workflow did not run again after I changed a bundle

Only what the node's outputs carry makes it run again: values, files, and which fields the outputs stand for. A new
name, note, tags, category or star does not. See [The Load Bundle node](The-Load-Bundle-node#when-it-runs-again).

### Something is listed under Needs attention

- **⚠ Fix before saving**: a value breaks a rule tightened after the bundle was saved. Open it and fix what the
  editor shows.
- **🔒 Cannot be changed by this version**, or a file saved by a newer version: update the node pack.
- **A damaged file**, or one of another format: fix the file if you know how, or delete it with **Delete forever** on
  its row (it is never deleted otherwise, not even by emptying the trash).
- **Could not be read**: the server could not open the file (permissions, a disk error). Fix the cause; it is read
  again on the next request.

### Cleaning up says some bundle files cannot be fully read

Cleanup waits while a bundle file might point at files it cannot see, so that it never deletes a file in use. The
message names the files; deal with them as above, then clean up again.

### An import is refused, or leaves bundles out

A file that is not an export of Bundle Library, or that a newer version made, is refused: update the node pack for the
second. Bundles left out show their reason in the preview; see [Import and export](Import-and-export#import).

### The example workflow cannot find its models

The note in the `z-image-turbo` workflow lists the three model files, where to get them, and the folders they go in.

### A message says the library folder could not be synced to the disk

The change is saved, but the server could not make sure it reached the disk, so a power cut could still undo it.
This is rare: check the disk and the folder's permissions, and the ComfyUI log for the reason.
