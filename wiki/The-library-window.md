The library window is where bundles are made, edited and kept in order. The list is on the left, with a toolbar
below it; the editor, or a pane for the task at hand, is on the right. A status line at the bottom says what
happened.

- [Opening it](#opening-it)
- [The list](#the-list)
- [Categories and favorites](#categories-and-favorites)
- [The editor](#the-editor)
- [Several bundles at once](#several-bundles-at-once)
- [Tags](#tags)
- [The trash](#the-trash)
- [Keyboard](#keyboard)

## Opening it

- The box icon in ComfyUI's sidebar shows the bundles, grouped as in the window. Click a name to open the window at
  that bundle, or **Open library**.
- **Extensions → Open Bundle Library** in the menu, or the command `BundleLibrary.Open` (it has no shortcut; you
  can give it one in ComfyUI's keybinding settings).
- The 📚 button of a Load Bundle node opens the window to pick a bundle for that node: **Use this bundle** (or a
  double-click) hands it over. See [The Load Bundle node](The-Load-Bundle-node.md#choosing-a-bundle).

## The list

- Bundles are shown in groups you can fold: ⚠ **Needs attention** (when something does), ★ **Favorites**, the
  categories by name, and **Uncategorized** (when it has bundles). The window remembers what you folded.
- **Search** finds bundles by name, tag, category name, field name and text. While you search or filter by a tag,
  only the groups with matches show, unfolded.
- Below the list, the toolbar has:

  | Button | What it does |
  | --- | --- |
  | Folder with + | Makes a new category |
  | Sort | Name A→Z or Z→A, newest or oldest first; the browser remembers it. Bundles are sorted within each group |
  | Filter | Filters by a tag. Each tag shows how many bundles have it; type to find one. A filter shows as a `Tag: …` chip above the list; × clears it. **Manage tags…** is at the bottom |
  | Upload | Imports bundles from a ZIP; see [Import and export](Import-and-export.md) |
  | Trash | Opens the trash; the number is how many bundles are in it |

- **+ New bundle** starts a new bundle in the editor.
- Bundles with the same name are told apart by the start of their id.
- An empty library offers **Import the examples**, the bundles of the pack's example workflow
  (see [Getting started](Getting-started.md#try-the-example)).

## Categories and favorites

- A bundle is in one category at most. Make a category with the toolbar button; rename or delete it from the ⋯ menu
  on its heading. Deleting a category leaves its bundles uncategorized.
- To move a bundle, choose its category in the editor (**New category…** at the end makes one on the spot), or drag
  it onto another group: onto Uncategorized to take it out of its category, onto ★ Favorites to star it. While you
  drag a bundle that is in a category, the toolbar becomes a place to drop it out of its category.
- ☆/★ (on a row, or in the editor's header) stars a bundle. A starred bundle shows under Favorites and in its own
  category.
- Categories and stars are saved at once and do not change the bundle itself, so they also work while the editor
  has unsaved changes, and **Revert** does not undo them. A new bundle goes into the category you chose when it is
  first saved.

## The editor

Selecting a bundle opens it in the editor: its name, category, ☆/★, tags, note and fields. The header's icons
(their names show on hover) are **Save** (Ctrl+S), **Revert**, **Duplicate**, **Export** (a ZIP of this bundle) and
**Delete** (to the trash).

- Fields are cards: see [Bundles and fields](Bundles-and-fields.md#editing-fields) for adding, moving, turning off and
  removing them, and [Images, video and audio](Images-video-and-audio.md#adding-a-file) for files.
- The header shows the state only when there is something to say: *● Unsaved changes*, *● New, not saved yet*,
  *Saving…*.
- While the editor has unsaved changes, everything but editing waits: choosing another bundle, search, sort, the tag
  filter, new bundles and categories, the trash, and the stars, drags and menus of the list. The status line says
  *Save or discard your changes first.* A number typed wrong and a file still uploading count as changes. The
  editor's own ☆/★ and category stay free, since they are not part of the bundle.
- Closing the window with unsaved changes (Esc, ✕, or a click outside) asks: **Save**, **Discard** or
  **Keep editing**.
- If the bundle was saved elsewhere since you opened it (another tab, a script), saving asks whether to
  **Overwrite** it with yours, **Reload** the saved version, or cancel.
- While a save, duplicate or delete is under way, the window waits for the answer and the list to catch up.

## Several bundles at once

- Ctrl+click (⌘+click on macOS) adds a bundle to the selection or takes it out; Shift+click selects a range; Ctrl+A
  in the list selects every bundle shown. A bundle shown twice (Favorites and its category) counts once.
- With two or more selected, the right side lists them with actions: **Move** to a category, **★ Add to favorites**,
  **☆ Remove from favorites**, tags (each tag of the selection shows how many of them have it; × takes it off all of
  them, **+ tag for all** adds one to all), **Export ZIP**, and **Move to trash…**. Dragging the selected rows moves
  them all.
- An action applies to the bundles as they were when you clicked. The result lists what changed, what was already so,
  and what could not be done, with the reason. It stays until you click **Done** or select another bundle.
- If the server takes more than 30 seconds, **Stop waiting** lets you go on; the window then says it cannot tell how
  far the server got, and offers to reload the list or try again.
- Bundles hidden by a search or filter leave the selection; the status line says how many.

## Tags

- Tags ignore case: `Portrait` and `portrait` are one tag.
- **Manage tags…** (in the filter menu) lists every tag of the library with the number of bundles that use it, in the
  trash too, and those this version cannot change.
- **Rename…** renames a tag in every bundle that has it, those in the trash too. Renaming it to a tag that exists
  merges the two. **Delete…** takes the tag off every bundle; the bundles stay. Both show what will change, and ask
  first. A tag filter follows the new name.

## The trash

Deleting a bundle moves it to the trash. While it is there, workflows that use it stop with a reason.

- **Restore** brings a bundle back with its id, name, category and star: the workflows that use it work again.
- **Delete forever** deletes one bundle; **Empty trash** deletes those you see. The files they used stay until you
  clean up.
- **Clean up unused files…** lists the stored files that no bundle uses, not even one in the trash, and deletes them
  once you confirm. See [Images, video and audio](Images-video-and-audio.md#cleaning-up-unused-files).
- A bundle saved by a newer version shows 🔒 and cannot be restored by this one. **Delete forever** says what you
  would lose and asks first; **Empty trash** leaves it.

## Keyboard

| Key | What it does |
| --- | --- |
| Ctrl+S | Save |
| Esc | Close the window. With a menu, question or selection open, it closes or clears that first |
| Ctrl/⌘+click, Shift+click, Ctrl+A | Select several bundles |
| ↓ on a toolbar button | Opens its menu; ↑/↓, Home and End move in it, Enter chooses |
| ▲▼ on a field card | Move the field |
| Tab | Moves within an open question, and returns where you were when it closes |
