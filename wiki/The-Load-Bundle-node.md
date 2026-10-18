**Load Bundle** puts one bundle into a workflow. It has an output for each field of the bundle, named after the field,
and its outputs follow the bundle you choose. Add it from the node library, under *Bundle Library*.

- [Choosing a bundle](#choosing-a-bundle)
- [How the outputs follow the bundle](#how-the-outputs-follow-the-bundle)
- [The preview](#the-preview)
- [When a bundle cannot fill an output](#when-a-bundle-cannot-fill-an-output)
- [When it runs again](#when-it-runs-again)
- [Saving and sharing workflows](#saving-and-sharing-workflows)

## Choosing a bundle

- **The list on the node.** Bundles are grouped as in the library: ★ Favorites, then the categories, then
  Uncategorized. A bundle without a field that one of the node's linked outputs needs is marked
  `⚠ no 'name'`.
- **📚** opens the [library window](The-library-window.md) to pick from: select a bundle and click
  **Use this bundle**, or double-click it. The same ⚠ mark shows there. The node gets the bundle as it is saved: a
  change you have not saved yet is not handed over.

## How the outputs follow the bundle

When you choose a bundle, the node shows an output for each of its fields that is on, in the bundle's order, named
and typed after the field. A [choice](Bundles-and-fields.md#choices) is a COMBO output: it links to the dropdown inputs
of other nodes, such as a LoRA name or a sampler. When you choose another bundle:

- An output whose field is in the new bundle, with the same name and type, keeps its links.
- Fields that are new get outputs at the end.
- Outputs that are not linked and whose field is gone are removed.
- An output that is linked but whose field is missing, or of another type, stays where it is, marked, so its links
  are not lost. Choose a bundle that has the field, rename the field, or unlink the output.

The node does not rebuild its outputs by itself when a bundle is edited in the library. When the bundle's fields
changed, its panel says *Bundle fields changed* and offers **Update outputs**: it adds the new fields, removes
unlinked outputs whose field left, and retypes unlinked outputs whose type changed. Linked outputs are never removed
or retyped.

## The preview

The node's panel shows what the bundle holds: its pictures (click one to enlarge it), its videos (click to play),
its audio (**Play**), the start of each text, each choice with where its options come from, and the other values. The
▾ button hides or shows the preview; the node remembers it.

Under a choice, the panel says what does not fit:

- **Not among the options of** its source, on this ComfyUI: linked, the run will stop (see below).
- **Can't check**, and why: its source's node is not here, or cannot be read. It runs as it is.
- **⚠ Not among the options of** a node it is linked to: the input the output reaches does not list the value (a LoRA
  name linked to a checkpoint input, a model this computer does not have). The links are followed into subgraphs and
  through Reroute nodes. This is a warning only: Load Bundle does not stop for it, but that node may.

The panel looks again when the node's links change, and shortly after you click or press a key, so links changed
inside a subgraph are seen too. When ComfyUI reads its node definitions again (**Refresh Node Definitions**, or R,
after you add or remove a model), the panel reads the choices' sources again as well, and its warnings follow the
new lists.

## When a bundle cannot fill an output

An output cannot be filled when its field is missing from the bundle, is of another type, is turned off, is a
media field without a file (or whose file is missing from the library), or is a choice that is not among its source's
options on this ComfyUI. The panel says which, and:

- **A linked output** is marked `⚠ …; running will fail`. Running the workflow stops at Load Bundle with that reason,
  instead of passing on something wrong.
- **An unlinked output** is marked `(not connected)` and does not stop the run. If you link it later, the node after it
  stops with the same reason.

If the chosen bundle is gone or in the trash, the panel says *Bundle not found or in the trash*, with its name.
Restore it from the trash, or import it again: an import keeps its id, so the node finds it again.

## When it runs again

Load Bundle, and the nodes after it, run again only when what its outputs carry changes: a field's value or file, or
the fields the outputs stand for. Renaming a bundle, or changing its note, tags, category or star, does not make
them run again. For a choice, what counts is the value as its source's list spells it on this computer, and whether
it is among the options: a model added to the folder that is not the one chosen changes nothing.

If a bundle, or the options a choice is checked against, changes while a run is starting, Load Bundle fails rather
than give the old content under the new key; the next run uses the new content.

## Saving and sharing workflows

The node saves the id of its bundle and the list of its outputs (`bundle_id` and `slot_spec`, see
[File formats](File-formats.md#the-node-in-a-workflow)), not the bundle's content. To share a workflow, share its bundles
too: [export them](Import-and-export.md) to a ZIP. Importing keeps their ids, so the workflow finds them in the other
library.

A node saved by a newer Bundle Library may record its outputs in a way this version cannot read. It then keeps its
outputs and links as they are and asks you to update the node pack, rather than changing them.
