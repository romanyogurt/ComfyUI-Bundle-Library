Bundle Library speaks the language ComfyUI is set to (**Settings → Comfy → Locale**). It comes in English and
Korean; adding a language is adding one folder of text files. Translations are welcome as pull requests.

- [What is translated](#what-is-translated)
- [The files of a language](#the-files-of-a-language)
- [The message catalog](#the-message-catalog)
- [Adding or updating a language](#adding-or-updating-a-language)

## What is translated

- Everything the node pack draws: the Load Bundle node's panel, the sidebar tab, the library window and its
  questions, and the messages the server sends (errors and reasons). A language without a catalog shows English.
- The node's name, description and input tooltips, and the command's name. ComfyUI translates these itself from the
  pack's `nodeDefs.json` and `commands.json`.
- Not translated: what users write (names of bundles, fields, tags, categories and files), text that comes from the
  system (such as the reason of a disk error), and the errors of a workflow run, which ComfyUI shows as they are.

When the setting changes, what is drawn next is in the new language; a window that is open changes when it opens
again.

## The files of a language

A language is a folder in `locales/`, named with ComfyUI's code for it (`ko`, `ja`, `zh-TW`, …):

| File | Holds | Read |
| --- | --- | --- |
| `locales/<code>/bundle_library.json` | Every message of the pack | By the server on each request: reload the page to see a change |
| `locales/<code>/nodeDefs.json` | The node's name, description and input tooltips | By ComfyUI when it starts |
| `locales/<code>/commands.json` | The name of the "Open Bundle Library" command | By ComfyUI when it starts |

`locales/ko/` is a complete example. `locales/en/bundle_library.json` is the English catalog that every
translation follows; English needs no `nodeDefs.json` or `commands.json`, since it is in the code.

## The message catalog

Every message has an id that never changes, such as `trash.empty_confirm`. The English catalog maps ids to text, or
to forms for a count:

```json
{
  "trash.empty_confirm": "Empty the trash?",
  "count.bundles": {"one": "{count} bundle", "other": "{count} bundles"}
}
```

A translation maps the same ids to the English it was made from and the translation:

```json
{
  "trash.empty_confirm": {"en": "Empty the trash?", "text": "휴지통을 비울까요?"},
  "count.bundles": {"en": {"one": "{count} bundle", "other": "{count} bundles"}, "text": "번들 {count}개"}
}
```

- `en` tells when a translation is outdated: when the English changes, the two no longer match. An outdated
  translation still shows while its places match the English. After updating the text, copy the new English into
  `en`.
- Places such as `{count}` and `{name}` must be the same as in the English. A message whose places differ shows in
  English, as does a message the translation lacks.
- Forms for a count follow the plural categories of that language (as `Intl.PluralRules` gives them: `one`, `few`,
  `many`, `other`, …). A language with only `other`, such as Korean, Japanese or Chinese, uses a single text.
- Write each message as a whole sentence. Messages are never pieced together from parts, so each language can order
  its words its own way.

## Adding or updating a language

1. Copy `locales/ko/` to `locales/<code>/`.
2. Translate the `text` of each entry in `bundle_library.json` (keep `en` as it is, or set it to the current
   English when you update one), and the values in `nodeDefs.json` and `commands.json`.
3. Check the catalogs with a recent Node.js (tested with 24), from the pack's folder:

   ```bash
   node --test tests/js/*.test.mjs
   ```

   It fails on broken entries (an id English does not have, wrong forms, places that differ) and lists, for each
   language, the messages that are missing or outdated.
4. Restart ComfyUI (for the node and command names), reload the page, and set **Comfy → Locale** to your language.
5. Send a pull request with the folder.
