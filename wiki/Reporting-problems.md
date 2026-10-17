Found a bug, or something that could work better? Open an issue at
[github.com/romanyogurt/ComfyUI-Bundle-Library/issues](https://github.com/romanyogurt/ComfyUI-Bundle-Library/issues).

## Before you report

- Update to the latest release, restart ComfyUI and reload the page; the problem may be fixed already.
- Look through [FAQ and troubleshooting](FAQ-and-troubleshooting).
- If a bundle or file misbehaves, open the library window: files this version cannot use are listed under
  **Needs attention**, each with its reason.

## What to include

- **Versions**: Bundle Library (the `version` in `http://127.0.0.1:8188/api/bundle-library/v1/health`, with your
  address), ComfyUI and its frontend (**Settings → About**), your operating system and browser.
- **What happened**: what you did, what you expected, and what you saw instead. Steps that make it happen again help
  the most.
- **Messages**: the message on screen; lines starting with `[Bundle Library]` in the browser console (F12) and in
  the ComfyUI log, with the traceback that follows them; for a failed run, the error ComfyUI shows. Before posting,
  replace personal paths and content in them.
- **The library's state**: the answer of `/health` above. It holds counts and file names, not your content.

## Keep your data private

Your bundles hold your prompts, images and notes. Do not attach your library folder to a public issue. If one
bundle shows the problem, try to make a small bundle that does the same and export only that one
(see [Import and export](Import-and-export)), or describe its fields (names and types).

## Security problems

Please do not report a security problem in a public issue. Use **Report a vulnerability** on the repository's
**Security** tab, which reaches the maintainer privately.

## Ideas

Ideas and feature requests are welcome as issues too. Saying what you are trying to do, not only what you would
add, helps find the right change.
