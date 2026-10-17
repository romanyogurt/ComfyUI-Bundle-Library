"""HTTP API under /bundle-library/v1.

register() adds the routes to a RouteTableDef: ComfyUI's PromptServer table at
runtime, a fresh one in the tests. Nothing here imports ComfyUI.
"""

import asyncio
import functools
import hashlib
import json
import logging
from urllib.parse import quote, urlsplit

from aiohttp import web

from .assets import MIME_TYPES
from .constants import API_PREFIX, MAX_JSON_BODY, MEDIA_TYPES, VERSION
from .exchange import MAX_IMPORT_BYTES, Exports, Imports, file_name
from .model import LibraryError, check_bundle_id, check_sha256, lone_surrogates
from .store import UNSYNCED, present
from .text import Text, catalogs, said

CHUNK = 64 * 1024
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"}


def write_guard_error(request):
    """Why a state-changing request must be refused, or None.

    The custom header forces a CORS preflight for any other origin, which
    ComfyUI does not answer with allow headers. Core's own Host/Origin check
    only runs for loopback hosts, so the Origin comparison is repeated here
    for access through the Tailscale domain.
    """
    if request.headers.get("X-Bundle-Library") != "1":
        return "missing_header"
    site = request.headers.get("Sec-Fetch-Site")
    if site is not None and site not in ("same-origin", "none"):
        return "cross_site"
    origin = request.headers.get("Origin")
    if origin and urlsplit(origin).netloc.lower() != request.host.lower():
        return "origin_mismatch"
    return None


def _json(data, **kwargs):
    """An answer, with "<key>_i18n" beside each message a page may say in its own language (text.py)."""
    return web.json_response(said(data), **kwargs)


def _error_response(error):
    return _json({"error": {"code": error.code, "message": error.message, **error.details}}, status=error.status)


def _api(handler):
    """Answer LibraryError with its JSON body, and anything else with a 500 that
    names no files (the details go to the ComfyUI log)."""
    @functools.wraps(handler)
    async def wrapped(request):
        try:
            return await handler(request)
        except LibraryError as e:
            return _error_response(e)
        except OSError as e:  # the library folder could not be read or written; trying again may work
            logging.exception("[Bundle Library] %s %s failed", request.method, request.path)
            return _error_response(LibraryError(500, "io_error", Text("request.io_error", value=e.strerror or type(e).__name__), retry=True))
        except Exception:
            logging.exception("[Bundle Library] %s %s failed", request.method, request.path)
            return _error_response(
                LibraryError(500, "internal", Text("request.internal")))
    return wrapped


def _writes(handler):
    @functools.wraps(handler)
    async def wrapped(request):
        problem = write_guard_error(request)
        if problem:
            raise LibraryError(403, problem, Text("request.write_guard"))
        # The page sends the version of its scripts; files updated without a
        # restart (or a page left open across one) must not write.
        page = request.headers.get("X-Bundle-Library-Version")
        if page is not None and page != VERSION:
            raise LibraryError(409, "version_mismatch",
                               Text("request.version_mismatch", value=page[:20], VERSION=VERSION),
                               page_version=page[:20], server_version=VERSION)
        return await handler(request)
    return wrapped


def _too_large(limit):
    return LibraryError(413, "too_large", Text("request.too_large", n=limit // (1024 * 1024)))


async def _read_json(request):
    if request.content_type != "application/json":
        raise LibraryError(415, "unsupported_media_type", Text("request.json_type"))
    if request.content_length is not None and request.content_length > MAX_JSON_BODY:
        raise _too_large(MAX_JSON_BODY)
    chunks, total = [], 0
    while chunk := await request.content.read(CHUNK):
        total += len(chunk)
        if total > MAX_JSON_BODY:
            raise _too_large(MAX_JSON_BODY)
        chunks.append(chunk)
    try:
        data = json.loads(b"".join(chunks))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        raise LibraryError(400, "invalid_json", Text("request.json_invalid")) from None
    if not isinstance(data, dict):
        raise LibraryError(400, "invalid", Text("request.json_object"))
    if lone_surrogates(data):
        raise LibraryError(400, "invalid_json", Text("request.json_unicode"))
    return data


def _require(data, *keys):
    """`data` with every key in `keys` present (null counts: it is a value). A
    missing key is not taken for an empty or default value."""
    missing = [key for key in keys if key not in data]
    if missing:
        raise LibraryError(400, "invalid", Text("request.missing", list=', '.join(missing)))
    return data


def _revision(query):
    try:
        return int(query["expected_revision"])
    except (KeyError, ValueError):
        raise LibraryError(400, "invalid", Text("common.revision_required")) from None


def register(routes, get_store):
    """Add the API to `routes`. `get_store` returns the BundleStore to serve."""
    prefix = API_PREFIX

    @routes.get(prefix + "/health")
    @_api
    async def health(request):
        report = await asyncio.to_thread(get_store().health)
        return _json({"version": VERSION, **report})

    @routes.get(prefix + "/messages")
    @_api
    async def messages(request):
        # The catalogs the page says its messages with (text.py): English and the language of ?lang=
        return _json(await asyncio.to_thread(catalogs, request.query.get("lang", "")))

    @routes.get(prefix + "/bundles")
    @_api
    async def list_bundles(request):
        sort = request.query.get("sort", "name")
        if sort not in ("name", "updated"):
            raise LibraryError(400, "invalid", Text("request.sort_invalid"))
        listing = await asyncio.to_thread(
            get_store().list, request.query.get("q", ""), request.query.get("tag", ""), sort)
        return _json(listing)

    @routes.post(prefix + "/bundles")
    @_api
    @_writes
    async def create_bundle(request):
        data = await _read_json(request)
        # "category" puts the new bundle in a category too (placement_error if only that failed)
        bundle = await asyncio.to_thread(get_store().create, data, data.get("category"))
        return _json(present(bundle), status=201)

    @routes.get(prefix + "/bundles/{bundle_id}")
    @_api
    async def get_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        bundle, loaded = await asyncio.to_thread(get_store().get, bundle_id, True)
        return _json(present(bundle, loaded))

    @routes.put(prefix + "/bundles/{bundle_id}")
    @_api
    @_writes
    async def update_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        # The whole bundle is replaced: nothing left out may be taken for empty.
        data = _require(await _read_json(request), "name", "tags", "note", "fields", "expected_revision")
        bundle = await asyncio.to_thread(get_store().update, bundle_id, data, data["expected_revision"])
        return _json(present(bundle))

    @routes.delete(prefix + "/bundles/{bundle_id}")
    @_api
    @_writes
    async def delete_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        result = await asyncio.to_thread(get_store().delete, bundle_id, _revision(request.query))
        return _json({"deleted": bundle_id, "changed": result["changed"],
                                  **({"warning": result["warning"]} if "warning" in result else {})})

    @routes.post(prefix + "/bundles/{bundle_id}/duplicate")
    @_api
    @_writes
    async def duplicate_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        data = await _read_json(request)
        # Left out or null: the defaults (values; "<name> copy", also for an empty name).
        bundle = await asyncio.to_thread(
            get_store().duplicate, bundle_id, data.get("mode") or "values", data.get("name"))
        return _json(present(bundle), status=201)

    @routes.post(prefix + "/bundles/batch")
    @_api
    @_writes
    async def batch(request):
        data = await _read_json(request)
        return _json(await asyncio.to_thread(get_store().batch, data))

    @routes.post(prefix + "/export")
    @_api
    @_writes
    async def export(request):
        """Makes a ZIP of bundles in the library's temporary folder (exchange.py),
        to be downloaded within the hour from GET /export/{token}."""
        data = _require(await _read_json(request), "ids")
        store = get_store()
        result = await asyncio.to_thread(Exports(store.tmp_dir).create, store, data["ids"])
        return _json(result, status=201)

    @routes.get(prefix + "/export/{token}")
    @_api
    async def download_export(request):
        """The ZIP of an export, as a download named by ?name= (made safe again here)."""
        store = get_store()
        path = await asyncio.to_thread(Exports(store.tmp_dir).path, request.match_info["token"])
        name = file_name([request.query.get("name", "")[:120].removesuffix(".zip")])
        fallback = name.encode("ascii", "replace").decode().replace("?", "_").replace('"', "_")
        return web.FileResponse(path, headers={
            "Content-Type": "application/zip", "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(name)}'})

    @routes.post(prefix + "/import")
    @_api
    @_writes
    async def upload_import(request):
        """Receives an export ZIP (multipart field "file") and answers with what
        importing it would do (exchange.py); nothing in the library changes yet."""
        if not request.content_type.startswith("multipart/"):
            raise LibraryError(415, "unsupported_media_type", Text("request.zip_multipart"))
        store = get_store()
        imports = Imports(store.tmp_dir)
        reader = await request.multipart()
        part = await reader.next()
        while part is not None and getattr(part, "name", None) != "file":
            await part.release()
            part = await reader.next()
        if part is None:
            raise LibraryError(400, "invalid", Text("request.file_missing"))
        token, temp = await asyncio.to_thread(imports.new_part)
        total = 0
        try:
            with open(temp, "wb") as f:
                while chunk := await part.read_chunk(CHUNK):
                    total += len(chunk)
                    if total > MAX_IMPORT_BYTES:
                        raise _too_large(MAX_IMPORT_BYTES)
                    f.write(chunk)
            if total == 0:
                raise LibraryError(400, "invalid", Text("request.file_empty"))
            path = temp.with_suffix(".zip")
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
        try:
            preview = await asyncio.to_thread(imports.inspect, store, token, part.filename)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
        return _json(preview, status=201)

    @routes.post(prefix + "/import/{token}")
    @_api
    @_writes
    async def apply_import(request):
        """Imports an uploaded export: {"conflict": skip | overwrite | copy, "category": {"mode": zip | one | none, "id"?}}."""
        data = _require(await _read_json(request), "conflict", "category")
        store = get_store()
        result = await asyncio.to_thread(Imports(store.tmp_dir).apply, store, request.match_info["token"],
                                         data["conflict"], data["category"])
        return _json(result)

    @routes.delete(prefix + "/import/{token}")
    @_api
    @_writes
    async def discard_import(request):
        """Drops an uploaded export that will not be imported."""
        store = get_store()
        await asyncio.to_thread(Imports(store.tmp_dir).discard, request.match_info["token"])
        return _json({"discarded": True})

    @routes.get(prefix + "/tags")
    @_api
    async def list_tags(request):
        return _json(await asyncio.to_thread(get_store().tags))

    @routes.post(prefix + "/tags/rename")
    @_api
    @_writes
    async def rename_tag(request):
        """Renames a tag in every bundle, in use and in the trash; with a tag that
        is there already, the two merge."""
        data = _require(await _read_json(request), "from", "to")
        return _json(await asyncio.to_thread(get_store().rename_tag, data["from"], data["to"]))

    @routes.post(prefix + "/tags/delete")
    @_api
    @_writes
    async def delete_tag(request):
        """Takes a tag off every bundle, in use and in the trash."""
        data = _require(await _read_json(request), "tag")
        return _json(await asyncio.to_thread(get_store().delete_tag, data["tag"]))

    @routes.put(prefix + "/bundles/{bundle_id}/category")
    @_api
    @_writes
    async def set_category(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        data = _require(await _read_json(request), "category")  # null: no category
        return _json(await asyncio.to_thread(get_store().set_category, bundle_id, data["category"]))

    @routes.put(prefix + "/bundles/{bundle_id}/favorite")
    @_api
    @_writes
    async def set_favorite(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        data = await _read_json(request)
        return _json(await asyncio.to_thread(get_store().set_favorite, bundle_id, data.get("favorite")))

    @routes.get(prefix + "/categories")
    @_api
    async def list_categories(request):
        return _json(await asyncio.to_thread(get_store().categories))

    @routes.post(prefix + "/categories")
    @_api
    @_writes
    async def create_category(request):
        data = await _read_json(request)
        category = await asyncio.to_thread(get_store().create_category, data.get("name"), data.get("parent"))
        return _json(category, status=201)

    @routes.patch(prefix + "/categories/{category_id}")
    @_api
    @_writes
    async def rename_category(request):
        data = await _read_json(request)
        category = await asyncio.to_thread(get_store().rename_category, request.match_info["category_id"],
                                           data.get("name"))
        return _json(category)

    @routes.delete(prefix + "/categories/{category_id}")
    @_api
    @_writes
    async def delete_category(request):
        category_id = request.match_info["category_id"]
        answer = await asyncio.to_thread(get_store().delete_category, category_id)
        return _json({"deleted": category_id, **answer})

    @routes.get(prefix + "/trash")
    @_api
    async def list_trash(request):
        return _json(await asyncio.to_thread(get_store().trash))

    @routes.post(prefix + "/bundles/{bundle_id}/restore")
    @_api
    @_writes
    async def restore_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        return _json(present(await asyncio.to_thread(get_store().restore, bundle_id)))

    @routes.delete(prefix + "/trash/{bundle_id}")
    @_api
    @_writes
    async def purge_bundle(request):
        """Deletes a bundle in the trash for good; with ?unreadable=1, also a file
        this version cannot fully read (the user asked for that file)."""
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        unreadable = request.query.get("unreadable") == "1"
        # The revision the user saw; not known for a file this version cannot fully read.
        expected = _revision(request.query) if not unreadable or "expected_revision" in request.query else None
        await asyncio.to_thread(get_store().purge, bundle_id, unreadable, expected)
        return _json({"deleted": bundle_id})

    @routes.delete(prefix + "/trash")
    @_api
    @_writes
    async def empty_trash(request):
        """Deletes for good the bundles the page showed in the trash ({"expected_revisions": {id: revision}})."""
        data = _require(await _read_json(request), "expected_revisions")
        return _json(await asyncio.to_thread(get_store().empty_trash, data["expected_revisions"]))

    @routes.get(prefix + "/cleanup")
    @_api
    async def list_unused_assets(request):
        return _json(await asyncio.to_thread(get_store().unused_assets))

    @routes.post(prefix + "/cleanup")
    @_api
    @_writes
    async def delete_unused_assets(request):
        """Deletes the files listed in "sha256" (what GET showed) that are still unused; with "recent": true, also
        those within the grace time."""
        data = await _read_json(request)
        return _json(await asyncio.to_thread(get_store().delete_unused_assets, data.get("sha256"), data.get("recent", False)))

    @routes.post(prefix + "/assets")
    @_api
    @_writes
    async def upload_asset(request):
        """One file in the multipart field "file", streamed to disk with its own
        size limit: ComfyUI's --max-upload-size does not apply to multipart().
        An optional "kind" field before it (image, video or audio; image by
        default) says what the file must be, and so which limit applies."""
        assets = get_store().assets
        if not request.content_type.startswith("multipart/"):
            raise LibraryError(415, "unsupported_media_type", Text("request.upload_multipart"))
        reader = await request.multipart()
        kind = "image"
        part = await reader.next()
        while part is not None and getattr(part, "name", None) != "file":
            if getattr(part, "name", None) == "kind":
                kind = (await part.read_chunk()).decode("utf-8", "replace").strip()  # one chunk at most
                if kind not in MEDIA_TYPES:
                    raise LibraryError(400, "invalid", Text("request.kind_invalid"))
            await part.release()
            part = await reader.next()
        if part is None:
            raise LibraryError(400, "invalid", Text("request.file_missing"))
        limit = assets.limits[kind]["bytes"]
        temp = assets.temp_path()
        digest, total = hashlib.sha256(), 0
        try:
            with open(temp, "wb") as f:
                while chunk := await part.read_chunk(CHUNK):
                    total += len(chunk)
                    if total > limit:
                        raise _too_large(limit)
                    digest.update(chunk)
                    f.write(chunk)
            if total == 0:
                raise LibraryError(400, "invalid", Text("request.file_empty"))
            info, created, synced = await asyncio.to_thread(assets.finalize, temp, digest.hexdigest(), part.filename, kind)
        finally:
            temp.unlink(missing_ok=True)
        return _json({"asset": info, **({} if synced else {"warning": UNSYNCED})}, status=201 if created else 200)

    @routes.get(prefix + "/assets")
    @_api
    async def list_assets(request):
        """The stored files of one kind (?kind=image, video or audio), for a media field to take (0.0.29)."""
        return _json(await asyncio.to_thread(get_store().stored_assets, request.query.get("kind", "")))

    @routes.post(prefix + "/assets/{sha256}/use")
    @_api
    @_writes
    async def use_asset(request):
        """A draft takes a stored file: a cleanup waits the grace time anew, as after an upload of the same content."""
        return _json({"asset": await asyncio.to_thread(get_store().keep_asset, request.match_info["sha256"])})

    @routes.get(prefix + "/assets/{sha256}")
    @_api
    async def get_asset(request):
        sha256 = check_sha256(request.match_info["sha256"])
        path = await asyncio.to_thread(get_store().assets.path, sha256)
        if path is None:
            raise LibraryError(404, "not_found", Text("request.file_not_found"))
        return web.FileResponse(path, headers={"Content-Type": MIME_TYPES[path.suffix[1:]], **IMMUTABLE})

    @routes.get(prefix + "/assets/{sha256}/thumb")
    @_api
    async def get_thumbnail(request):
        sha256 = check_sha256(request.match_info["sha256"])
        try:
            size = int(request.query.get("size", "256"))
        except ValueError:
            raise LibraryError(400, "invalid", Text("request.size_integer")) from None
        path = await asyncio.to_thread(get_store().assets.thumbnail, sha256, size)
        if path is None:
            raise LibraryError(404, "not_found", Text("request.no_thumbnail"))
        return web.FileResponse(path, headers={"Content-Type": "image/webp", **IMMUTABLE})
