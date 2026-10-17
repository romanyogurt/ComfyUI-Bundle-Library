A bundle is a named set of values that belong together: a prompt, a few reference pictures, a seed, a switch. Each
value is a *field*, and each field becomes an output of the [Load Bundle node](The-Load-Bundle-node).

- [What a bundle holds](#what-a-bundle-holds)
- [Field types](#field-types)
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
| Category | One at most; see [The library window](The-library-window#categories-and-favorites). It is not part of the bundle: changing it does not change the bundle |
| Tags | Up to 20 words to find bundles by. `Portrait` and `portrait` are the same tag |
| Note | Free text, for you |
| Fields | The values, in order: up to 32 |

The limits on names and sizes are in [File formats](File-formats#names-and-limits).

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

An image, video or audio field may be empty, but a workflow that uses it then stops with a reason; see
[The Load Bundle node](The-Load-Bundle-node#when-a-bundle-cannot-fill-an-output). Files are covered in
[Images, video and audio](Images-video-and-audio).

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

In the editor of the [library window](The-library-window#the-editor):

- **+ Add field ▾** adds a field of the type you choose.
- Drag a card by the handle on the left of its header to move it, or use ▲▼. The order is the order of the node's
  outputs when a bundle is first chosen.
- The ✕ on a card removes the field (after you confirm).
- Changes stay a draft until you save (**Ctrl+S**); **Revert** drops them.

## Duplicating a bundle

**Duplicate** in the editor's header makes a new bundle in the same category:

- **Duplicate with values** copies everything: names, values, files, tags and note.
- **Duplicate structure only** copies the fields with empty values and no files: a template for a new bundle that fits
  the same workflows.

The copy is named `<name> copy` and is not starred.

## When a bundle cannot be saved as it is

Two states mark a bundle in the list and in the editor:

- **⚠ Fix before saving**: the bundle breaks a writing rule that was tightened after it was saved (a name too long, too
  many tags, …). It still works in workflows; the editor shows what to fix, and saves once it is fixed.
- **🔒 Cannot be changed by this version**: the bundle has data this version does not know, because a newer Bundle Library saved it. It still
  works in workflows, but this version does not change it. Update the node pack to edit it.

Files this version cannot read at all are listed under **Needs attention**; see
[FAQ and troubleshooting](FAQ-and-troubleshooting#something-is-listed-under-needs-attention).
