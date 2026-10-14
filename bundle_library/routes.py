"""HTTP API under /bundle-library/v1 (docs/data-format.md).

register() adds the routes to a RouteTableDef: ComfyUI's PromptServer table at
runtime, a fresh one in the tests. Nothing here imports ComfyUI.
"""

import asyncio
import functools
import hashlib
import json
import logging
from urllib.parse import urlsplit

from aiohttp import web

from .assets import MIME_TYPES
from .constants import API_PREFIX, MAX_JSON_BODY, MEDIA_TYPES, VERSION
from .model import LibraryError, check_bundle_id, check_sha256

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


def _error_response(error):
    return web.json_response(
        {"error": {"code": error.code, "message": error.message, **error.details}}, status=error.status)


def _api(handler):
    """Answer LibraryError with its JSON body, and anything else with a 500 that
    names no files (the details go to the ComfyUI log)."""
    @functools.wraps(handler)
    async def wrapped(request):
        try:
            return await handler(request)
        except LibraryError as e:
            return _error_response(e)
        except Exception:
            logging.exception("[Bundle Library] %s %s failed", request.method, request.path)
            return _error_response(
                LibraryError(500, "internal", "Server error; see the ComfyUI log for details."))
    return wrapped


def _writes(handler):
    @functools.wraps(handler)
    async def wrapped(request):
        problem = write_guard_error(request)
        if problem:
            raise LibraryError(403, problem, "Changes to the library must come from the ComfyUI page.")
        return await handler(request)
    return wrapped


def _too_large(limit):
    return LibraryError(413, "too_large", f"Request too large; the limit is {limit // (1024 * 1024)} MB.")


async def _read_json(request):
    if request.content_type != "application/json":
        raise LibraryError(415, "unsupported_media_type", "The body must be JSON (application/json).")
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
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise LibraryError(400, "invalid_json", "The body is not valid JSON.") from None
    if not isinstance(data, dict):
        raise LibraryError(400, "invalid", "The body must be a JSON object.")
    return data


def register(routes, get_store):
    """Add the API to `routes`. `get_store` returns the BundleStore to serve."""
    prefix = API_PREFIX

    @routes.get(prefix + "/health")
    @_api
    async def health(request):
        report = await asyncio.to_thread(get_store().health)
        return web.json_response({"version": VERSION, **report})

    @routes.get(prefix + "/bundles")
    @_api
    async def list_bundles(request):
        sort = request.query.get("sort", "name")
        if sort not in ("name", "updated"):
            raise LibraryError(400, "invalid", "sort must be 'name' or 'updated'.")
        listing = await asyncio.to_thread(
            get_store().list, request.query.get("q", ""), request.query.get("tag", ""), sort)
        return web.json_response(listing)

    @routes.post(prefix + "/bundles")
    @_api
    @_writes
    async def create_bundle(request):
        data = await _read_json(request)
        return web.json_response(await asyncio.to_thread(get_store().create, data), status=201)

    @routes.get(prefix + "/bundles/{bundle_id}")
    @_api
    async def get_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        return web.json_response(await asyncio.to_thread(get_store().get, bundle_id))

    @routes.put(prefix + "/bundles/{bundle_id}")
    @_api
    @_writes
    async def update_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        data = await _read_json(request)
        bundle = await asyncio.to_thread(get_store().update, bundle_id, data, data.get("expected_revision"))
        return web.json_response(bundle)

    @routes.delete(prefix + "/bundles/{bundle_id}")
    @_api
    @_writes
    async def delete_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        try:
            expected = int(request.query["expected_revision"])
        except (KeyError, ValueError):
            raise LibraryError(400, "invalid", "expected_revision (an integer) is required.") from None
        await asyncio.to_thread(get_store().delete, bundle_id, expected)
        return web.json_response({"deleted": bundle_id})

    @routes.post(prefix + "/bundles/{bundle_id}/duplicate")
    @_api
    @_writes
    async def duplicate_bundle(request):
        bundle_id = check_bundle_id(request.match_info["bundle_id"])
        data = await _read_json(request)
        bundle = await asyncio.to_thread(
            get_store().duplicate, bundle_id, data.get("mode", "values"), data.get("name"))
        return web.json_response(bundle, status=201)

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
            raise LibraryError(415, "unsupported_media_type", "Upload files as multipart/form-data.")
        reader = await request.multipart()
        kind = "image"
        part = await reader.next()
        while part is not None and getattr(part, "name", None) != "file":
            if getattr(part, "name", None) == "kind":
                kind = (await part.read_chunk()).decode("utf-8", "replace").strip()  # one chunk at most
                if kind not in MEDIA_TYPES:
                    raise LibraryError(400, "invalid", "kind must be image, video or audio.")
            await part.release()
            part = await reader.next()
        if part is None:
            raise LibraryError(400, "invalid", "The 'file' field is missing.")
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
                raise LibraryError(400, "invalid", "The file is empty.")
            info, created = await asyncio.to_thread(assets.finalize, temp, digest.hexdigest(), part.filename, kind)
        finally:
            temp.unlink(missing_ok=True)
        return web.json_response({"asset": info}, status=201 if created else 200)

    @routes.get(prefix + "/assets/{sha256}")
    @_api
    async def get_asset(request):
        sha256 = check_sha256(request.match_info["sha256"])
        path = await asyncio.to_thread(get_store().assets.path, sha256)
        if path is None:
            raise LibraryError(404, "not_found", "File not found.")
        return web.FileResponse(path, headers={"Content-Type": MIME_TYPES[path.suffix[1:]], **IMMUTABLE})

    @routes.get(prefix + "/assets/{sha256}/thumb")
    @_api
    async def get_thumbnail(request):
        sha256 = check_sha256(request.match_info["sha256"])
        try:
            size = int(request.query.get("size", "256"))
        except ValueError:
            raise LibraryError(400, "invalid", "size must be an integer.") from None
        path = await asyncio.to_thread(get_store().assets.thumbnail, sha256, size)
        if path is None:
            raise LibraryError(404, "not_found", "No thumbnail for this file.")
        return web.FileResponse(path, headers={"Content-Type": "image/webp", **IMMUTABLE})
