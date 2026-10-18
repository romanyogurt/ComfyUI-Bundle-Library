Your bundles live on the ComfyUI server, in one folder. This page covers where it is, how to back it up and move it,
and what to know when ComfyUI is shared.

- [Where the library lives](#where-the-library-lives)
- [Backing up](#backing-up)
- [Restoring and moving](#restoring-and-moving)
- [Sharing a ComfyUI server](#sharing-a-comfyui-server)
- [Editing the files by hand](#editing-the-files-by-hand)
- [Uninstalling](#uninstalling)

## Where the library lives

In `bundle_library/` inside ComfyUI's user folder: `ComfyUI/user/bundle_library/`, or under the folder that ComfyUI's
`--user-directory` option names. It is made the first time Bundle Library is used. What is inside is described in
[File formats](File-formats.md#the-library-folder).

## Backing up

Copy these, from the library folder:

- `bundles/`: the bundles, those in the trash too;
- `assets/`: the images, videos and audio;
- the files directly in the folder (`organization.json`: categories and favorites).

`thumbs/` and `tmp/` need no backup: thumbnails are made again when needed.

Each file is always complete on the disk (see [HTTP API](HTTP-API.md#writing)), but a copy made while you save could
hold a bundle without a file it just got. For a copy you can trust, make it while nothing is being saved, or with
ComfyUI stopped. Back up before updating Bundle Library (see
[Compatibility and versions](Compatibility-and-versions.md#updating-safely)), and before cleaning up unused files.

An [export](Import-and-export.md) of all your bundles (Ctrl+A in the list, then **Export ZIP**) is a portable copy too:
it holds the bundles and their files, and categories by name, but not favorites.

## Restoring and moving

- **Restoring a backup**: stop ComfyUI, move the current `bundle_library/` folder aside, put the backup in its place,
  and start ComfyUI.
- **Moving to another computer**: copy the folder the same way, or export all bundles and import the ZIP there.
  Either way the bundles keep their ids, so workflows find them.

## Sharing a ComfyUI server

- **Several users** (`--multi-user`): there is one library, shared by everyone. Users do not have libraries of their
  own.
- **Other computers** (`--listen`): Bundle Library has no login, like ComfyUI itself. Anyone who can reach the server
  can read the library, and use its API (see [HTTP API](HTTP-API.md#basics)). Reach ComfyUI through a VPN, or put a
  proxy that asks for a login in front of it.
- **One ComfyUI per library**: two ComfyUI processes should not use the same library folder.

## Editing the files by hand

Bundle files are JSON and can be edited by hand; the library reads a changed file the next time its list is read.
A file it cannot use is listed under **Needs attention** with the reason, and the others are not affected. Still,
the [library window](The-library-window.md) and the [API](Automating-with-the-API.md) check every change and keep
revisions; prefer them.

## Uninstalling

Removing the node pack leaves the library folder in place, so reinstalling brings your bundles back. Delete the
folder yourself if you no longer want it. Workflows that use Load Bundle show the node as missing while the pack is
not installed.
