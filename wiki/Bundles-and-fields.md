A bundle is a named set of values that belong together: a prompt, a few reference pictures, a seed, a switch, the
LoRA to use. Each value is a *field*, and each field becomes an output of the [Load Bundle node](The-Load-Bundle-node.md).

- [What a bundle holds](#what-a-bundle-holds)
- [Field types](#field-types)
- [Choices](#choices)
- [Field names](#field-names)
- [Turning a field off](#turning-a-field-off)
- [Editing fields](#editing-fields)
- [Duplicating a bundle](#duplicating-a-bundle)
- [When a bundle cannot be saved as it is](#when-a-bundle-cannot-be-saved-as-it-is)

## What a bundle holds

| Part | What it is |
| --- | --- |
| Name | For you to read. Bundles may share a name; the library tells them apart by the start of their id |
| Id | Given when the bundle is made, and never changed. Workflows point at bundles by id, so renaming a bundle or moving it to another category keeps every workflow working |
| Category | One at most; see [The library window](The-library-window.md#categories-and-favorites). It is not part of the bundle: changing it does not change the bundle |
| Tags | Up to 20 words to find bundles by. `Portrait` and `portrait` are the same tag |
| Note | Free text, for you |
| Fields | The values, in order: up to 32 |

The limits on names and sizes are in [File formats](File-formats.md#names-and-limits).

## Field types

| Type | Holds | Output | Notes |
| --- | --- | --- | --- |
| Text | Any text | STRING | Spaces and line breaks are kept as they are. Up to 1 MB |
| Integer | A whole number | INT | Within ±9,007,199,254,740,991, the range a browser keeps exactly |
| Float | A number | FLOAT | |
| Boolean | True or false | BOOLEAN | |
| Image | A PNG, JPEG or WebP file | IMAGE | Loaded as core *Load Image* does |
| Video | An MP4, WebM or MOV file | VIDEO | Passed on as core *Load Video* does; decoded where it is used |
| Audio | A WAV, FLAC, MP3, OGG or M4A file | AUDIO | Decoded as core *Load Audio* does |
| Choice | One option of another node's dropdown, such as a LoRA, a model file or a sampler | COMBO | Up to 4,096 bytes of text. See [Choices](#choices) |

An image, video or audio field may be empty, but a workflow that uses it then stops with a reason; see
[The Load Bundle node](The-Load-Bundle-node.md#when-a-bundle-cannot-fill-an-output). Files are covered in
[Images, video and audio](Images-video-and-audio.md).

## Choices

A choice holds what you would pick in another node's dropdown: a LoRA in *Load LoRA*, a model in *Load Diffusion
Model*, a sampler or scheduler in *KSampler*. Its output links to such dropdown inputs, which a text output cannot.

- **Its value** is text, kept exactly as you type it. You can type it freely, or pick it from a list once the field
  knows where its options come from.
- **Options from…** sets that: find a node, then choose one of its dropdown inputs. The value stays as it is; the
  card then offers that dropdown's options as this ComfyUI has them now (type to narrow them, ↓↑ and Enter to pick),
  and says whether the value is one of them. **↻** reads them again, after you add a model file for example.
- **Change…** picks another source, and the **×** on the source forgets it; the value stays in both cases. Choosing,
  changing or forgetting a source is a change you save like any other.
- A dropdown that takes several options at once, has options that are not text (numbers), gets its options from
  elsewhere, or changes the node's other inputs cannot be a source: the list shows it struck through, with the
  reason.

What the card says of the value:

| It says | Meaning |
| --- | --- |
| One of the options | The value is in the source's list on this ComfyUI |
| ⚠ Not among the options | It is not. The value is kept, but a run with this output linked stops with the reason (see [The Load Bundle node](The-Load-Bundle-node.md#when-a-bundle-cannot-fill-an-output)) |
| Can't check | This ComfyUI does not have the source's node (a node pack not installed here, say), or cannot read it. The value runs as it is |
| Typed freely | No source: nothing to check it against. The value runs as it is |

Saving is never held back: a bundle may be made for another computer, with other models.

Model files in subfolders are listed with `\` on Windows and `/` elsewhere. When the source's list holds the files of
one of ComfyUI's model folders, a value written with the other slash still counts as one of the options, and goes
out spelled as the list has it on this computer. The same text is taken first; when two files match either way,
neither is taken. The value itself is not rewritten.

A choice holds the name only, not the model file: a bundle exported to another computer needs its models there too.

## Field names

A field's name is the name of the node's output that carries it, and it is how a workflow finds the field again when
you choose another bundle. So:

- Give the same name and type to the fields that play the same part in different bundles (`prompt`, `reference`,
  `steps`, …). Choosing another such bundle then keeps every link.
- Names are unique within a bundle, and case matters (`Prompt` is not `prompt`).
- Renaming a field that a workflow uses breaks that link: the node shows the output as missing until you link it
  again or rename the field back.
- Names starting with `@` are reserved.

## Turning a field off

The eye button on a field's card turns the field off. It stays in the bundle with its value or file, but no node
outputs it; its card is dimmed and marked off. Use it to try another set of outputs without deleting anything.

- A workflow linked to a field that is off keeps the output, shown as *turned off in this bundle*, and its runs fail
  with that reason until you turn the field on again or unlink the output.
- Unlinked outputs of turned-off fields go away when you update the node's outputs, and come back at the end when the
  field is on again.
- A field that is off still needs a unique name, counts toward the 32 fields, and is found by search.

## Editing fields

In the editor of the [library window](The-library-window.md#the-editor):

- **+ Add field ▾** adds a field of the type you choose.
- Drag a card by the handle on the left of its header to move it, or use ▲▼. The order is the order of the node's
  outputs when a bundle is first chosen.
- The ✕ on a card removes the field (after you confirm).
- Changes stay a draft until you save (**Ctrl+S**); **Revert** drops them.

## Duplicating a bundle

**Duplicate** in the editor's header makes a new bundle in the same category:

- **Duplicate with values** copies everything: names, values, files, tags and note.
- **Duplicate structure only** copies the fields with empty values and no files: a template for a new bundle that fits
  the same workflows. A choice keeps where its options come from.

The copy is named `<name> copy` and is not starred.

## When a bundle cannot be saved as it is

Two states mark a bundle in the list and in the editor:

- **⚠ Fix before saving**: the bundle breaks a writing rule that was tightened after it was saved (a name too long, too
  many tags, …). It still works in workflows; the editor shows what to fix, and saves once it is fixed.
- **🔒 Cannot be changed by this version**: the bundle has data this version does not know, because a newer Bundle Library saved it. It still
  works in workflows, but this version does not change it. Update the node pack to edit it.

Files this version cannot read at all are listed under **Needs attention**; see
[FAQ and troubleshooting](FAQ-and-troubleshooting.md#something-is-listed-under-needs-attention).
