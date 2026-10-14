import hashlib
import io
import tempfile
import unittest
import uuid
from pathlib import Path

from aiohttp import FormData, web
from aiohttp.test_utils import AioHTTPTestCase
from PIL import Image

from bundle_library import routes
from bundle_library.constants import MAX_JSON_BODY
from bundle_library.store import BundleStore

from . import helpers

P = "/bundle-library/v1"
WRITE = {"X-Bundle-Library": "1"}
FAKE_TRASH_ID = f"{uuid.uuid4()}.20261015T000000Z"


class RoutesTest(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = BundleStore(self.root, max_image_bytes=300_000, max_image_pixels=1_000_000)
        table = web.RouteTableDef()
        routes.register(table, lambda: self.store)
        app = web.Application()
        app.add_routes(table)
        return app

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def upload(self, data, filename="up.png", headers=WRITE, field="file", kind=None):
        form = FormData(quote_fields=False)  # browsers send the file name as raw UTF-8
        if kind is not None:
            form.add_field("kind", kind)
        form.add_field(field, data, filename=filename, content_type="application/octet-stream")
        return await self.client.post(P + "/assets", data=form, headers=headers)

    async def body(self, response, status):
        payload = await response.json()
        self.assertEqual(response.status, status, payload)
        return payload

    async def error(self, response, status, code):
        payload = await self.body(response, status)
        self.assertEqual(payload["error"]["code"], code, payload)
        self.assertTrue(payload["error"]["message"])
        return payload["error"]

    async def bundle_data(self, name="Red Dress Girl", color="red"):
        sha = (await self.body(await self.upload(helpers.png(color)), 201))["asset"]["sha256"]
        return {"name": name, "tags": ["character"], "fields": [
            {"name": "prompt", "type": "text", "value": "두 줄\n\n 공백 "},
            {"name": "ref_1", "type": "image", "asset": {"sha256": sha}},
            {"name": "use_bgm", "type": "boolean", "value": True},
        ]}

    async def test_writes_need_the_header_and_the_same_origin(self):
        data = await self.bundle_data()
        same_origin = f"http://{self.client.host}:{self.client.port}"
        await self.error(await self.client.post(P + "/bundles", json=data), 403, "missing_header")
        await self.error(await self.client.post(P + "/bundles", json=data, headers={**WRITE, "Origin": "http://evil.example"}),
                         403, "origin_mismatch")
        await self.error(await self.client.post(P + "/bundles", json=data, headers={**WRITE, "Sec-Fetch-Site": "cross-site"}),
                         403, "cross_site")
        await self.error(await self.upload(helpers.png(), headers={}), 403, "missing_header")
        await self.body(await self.client.post(P + "/bundles", json=data, headers={
            **WRITE, "Origin": same_origin, "Sec-Fetch-Site": "same-origin"}), 201)

    async def test_every_write_route_is_guarded(self):
        bundle = await self.body(await self.client.post(P + "/bundles", json=await self.bundle_data(), headers=WRITE), 201)
        path = f"{P}/bundles/{bundle['id']}"
        writes = {
            "PUT": lambda headers: self.client.put(path, json={**bundle, "expected_revision": 1}, headers=headers),
            "DELETE": lambda headers: self.client.delete(path + "?expected_revision=1", headers=headers),
            "duplicate": lambda headers: self.client.post(path + "/duplicate", json={"mode": "values"}, headers=headers),
            "upload": lambda headers: self.upload(helpers.png("teal"), headers=headers),
            "restore": lambda headers: self.client.post(f"{P}/trash/{FAKE_TRASH_ID}/restore", headers=headers),
            "delete for good": lambda headers: self.client.delete(f"{P}/trash/{FAKE_TRASH_ID}", headers=headers),
            "empty trash": lambda headers: self.client.delete(P + "/trash", headers=headers),
            "cleanup": lambda headers: self.client.post(P + "/cleanup", json={"sha256": []}, headers=headers),
        }
        refusals = [({}, "missing_header"), ({**WRITE, "Sec-Fetch-Site": "same-site"}, "cross_site"),
                    ({**WRITE, "Origin": "null"}, "origin_mismatch"),
                    ({**WRITE, "Origin": f"http://{self.client.host}:{self.client.port}.evil.example"}, "origin_mismatch")]
        for name, write in writes.items():
            for headers, code in refusals:
                with self.subTest(route=name, code=code, headers=headers):
                    await self.error(await write(headers), 403, code)
        self.assertEqual((await self.body(await self.client.get(path), 200))["revision"], 1)  # nothing changed
        self.assertEqual(len((await self.body(await self.client.get(P + "/bundles"), 200))["bundles"]), 1)
        for name, request in (("PUT", self.client.put), ("duplicate", self.client.post)):
            with self.subTest(route=name):
                target = path if name == "PUT" else path + "/duplicate"
                await self.error(await request(target, data="mode=values", headers={
                    **WRITE, "Content-Type": "application/x-www-form-urlencoded"}), 415, "unsupported_media_type")

    async def test_bodies_must_be_small_json_objects(self):
        await self.error(await self.client.post(P + "/bundles", data="name=x", headers={
            **WRITE, "Content-Type": "application/x-www-form-urlencoded"}), 415, "unsupported_media_type")
        await self.error(await self.client.post(P + "/bundles", data=b"{oops", headers={
            **WRITE, "Content-Type": "application/json"}), 400, "invalid_json")
        await self.error(await self.client.post(P + "/bundles", json=[1, 2], headers=WRITE), 400, "invalid")
        huge = b'{"name": "' + b"a" * MAX_JSON_BODY + b'"}'
        await self.error(await self.client.post(P + "/bundles", data=io.BytesIO(huge), headers={
            **WRITE, "Content-Type": "application/json"}), 413, "too_large")

    async def test_bundle_lifecycle(self):
        created = await self.body(await self.client.post(P + "/bundles", json=await self.bundle_data(), headers=WRITE), 201)
        bundle_id = created["id"]
        self.assertEqual(await self.body(await self.client.get(f"{P}/bundles/{bundle_id}"), 200), created)
        listing = await self.body(await self.client.get(P + "/bundles?q=red&sort=updated"), 200)
        self.assertEqual([b["id"] for b in listing["bundles"]], [bundle_id])
        self.assertEqual(listing["bundles"][0]["fields"][0]["preview"], "두 줄\n\n 공백 ")

        change = {**await self.bundle_data("Renamed", "green"), "expected_revision": 1}
        updated = await self.body(await self.client.put(f"{P}/bundles/{bundle_id}", json=change, headers=WRITE), 200)
        self.assertEqual((updated["revision"], updated["name"]), (2, "Renamed"))
        conflict = await self.error(await self.client.put(f"{P}/bundles/{bundle_id}", json=change, headers=WRITE),
                                    409, "revision_conflict")
        self.assertEqual(conflict["current_revision"], 2)

        copy = await self.body(await self.client.post(f"{P}/bundles/{bundle_id}/duplicate",
                                                      json={"mode": "structure"}, headers=WRITE), 201)
        self.assertEqual(copy["name"], "Renamed copy")
        self.assertIsNone(copy["fields"][1]["asset"])

        await self.error(await self.client.delete(f"{P}/bundles/{bundle_id}", headers=WRITE), 400, "invalid")
        await self.error(await self.client.delete(f"{P}/bundles/{bundle_id}?expected_revision=1", headers=WRITE),
                         409, "revision_conflict")
        await self.body(await self.client.delete(f"{P}/bundles/{bundle_id}?expected_revision=2", headers=WRITE), 200)
        await self.error(await self.client.get(f"{P}/bundles/{bundle_id}"), 404, "not_found")

    async def test_bundle_errors(self):
        await self.error(await self.client.get(P + "/bundles/not-a-uuid"), 400, "invalid_id")
        await self.error(await self.client.get(P + "/bundles/..%2F..%2Fetc%2Fpasswd"), 400, "invalid_id")
        await self.error(await self.client.get(f"{P}/bundles/{uuid.uuid4()}"), 404, "not_found")
        await self.error(await self.client.get(P + "/bundles?sort=size"), 400, "invalid")
        data = await self.bundle_data()
        await self.body(await self.client.post(P + "/bundles", json=data, headers=WRITE), 201)
        await self.error(await self.client.post(P + "/bundles", json={**data, "name": data["name"].upper()}, headers=WRITE),
                         409, "name_conflict")
        mesh = {**data, "name": "Mesh", "fields": [{"name": "model", "type": "mesh", "value": None}]}
        await self.error(await self.client.post(P + "/bundles", json=mesh, headers=WRITE), 400, "unsupported_type")
        unknown = {**data, "name": "Unknown", "fields": [{"name": "ref", "type": "image", "asset": {"sha256": "d" * 64}}]}
        await self.error(await self.client.post(P + "/bundles", json=unknown, headers=WRITE), 400, "unknown_asset")

    async def test_uploads(self):
        data = helpers.png("purple")
        first = await self.body(await self.upload(data, "보라.png"), 201)
        self.assertEqual(first["asset"]["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(first["asset"]["original_name"], "보라.png")
        again = await self.body(await self.upload(data, "copy.png"), 200)  # same content, kept once
        self.assertEqual(again["asset"]["sha256"], first["asset"]["sha256"])

        noise = helpers.encode(Image.effect_noise((400, 400), 64).convert("RGB"), "PNG")
        self.assertGreater(len(noise), 300_000)
        await self.error(await self.upload(noise), 413, "too_large")
        await self.error(await self.upload(helpers.png(size=(1100, 1000))), 413, "too_many_pixels")
        await self.error(await self.upload(helpers.gif(), "a.gif"), 415, "unsupported_format")
        small_noise = helpers.encode(Image.effect_noise((200, 200), 64).convert("RGB"), "PNG")
        await self.error(await self.upload(small_noise[: len(small_noise) // 2]), 400, "corrupt_image")
        await self.error(await self.upload(b""), 400, "invalid")
        await self.error(await self.upload(data, field="other"), 400, "invalid")
        await self.error(await self.client.post(P + "/assets", data=data, headers={
            **WRITE, "Content-Type": "image/png"}), 415, "unsupported_media_type")
        self.assertEqual(list((self.root / "tmp").iterdir()), [])

    async def test_media_uploads(self):
        clip = await self.body(await self.upload(helpers.video("mp4", "libx264", audio_codec="aac"), "clip.mp4",
                                                 kind="video"), 201)
        self.assertEqual((clip["asset"]["ext"], clip["asset"]["has_audio"]), ("mp4", True))
        sound = await self.body(await self.upload(helpers.audio(), "tone.wav", kind="audio"), 201)
        self.assertEqual(sound["asset"]["mime"], "audio/wav")
        await self.error(await self.upload(helpers.audio(), kind="sticker"), 400, "invalid")
        await self.error(await self.upload(helpers.audio(), kind="video"), 415, "unsupported_format")
        self.store.assets.limits["audio"]["bytes"] = 1000  # each kind streams with its own limit
        await self.error(await self.upload(helpers.audio(), kind="audio"), 413, "too_large")

        sha = clip["asset"]["sha256"]
        part = await self.client.get(f"{P}/assets/{sha}", headers={"Range": "bytes=0-99"})
        self.assertEqual((part.status, part.headers["Content-Type"], len(await part.read())), (206, "video/mp4", 100))
        poster = await self.client.get(f"{P}/assets/{sha}/thumb?size=128")
        self.assertEqual((poster.status, poster.headers["Content-Type"]), (200, "image/webp"))
        await self.error(await self.client.get(f"{P}/assets/{sound['asset']['sha256']}/thumb?size=128"), 404, "not_found")
        self.assertEqual(list((self.root / "tmp").iterdir()), [])

    async def test_assets_are_served_read_only(self):
        data = helpers.jpeg_turned()
        sha = (await self.body(await self.upload(data, "turned.jpg"), 201))["asset"]["sha256"]
        response = await self.client.get(f"{P}/assets/{sha}")
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), data)
        self.assertEqual(response.headers["Content-Type"], "image/jpeg")
        self.assertIn("immutable", response.headers["Cache-Control"])
        self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
        thumb = await self.client.get(f"{P}/assets/{sha}/thumb?size=128")
        self.assertEqual((thumb.status, thumb.headers["Content-Type"]), (200, "image/webp"))
        await self.error(await self.client.get(f"{P}/assets/{sha}/thumb?size=999"), 400, "invalid")
        await self.error(await self.client.get(f"{P}/assets/{sha}/thumb?size=big"), 400, "invalid")
        await self.error(await self.client.get(f"{P}/assets/{'f' * 64}"), 404, "not_found")
        await self.error(await self.client.get(f"{P}/assets/{sha.upper()}"), 400, "invalid_id")
        for path in ("/assets/..%2F..%2Fbundles", "/assets/%2e%2e", "/assets/" + "a" * 63 + "%2F"):
            with self.subTest(path=path):
                response = await self.client.get(P + path)
                self.assertIn(response.status, (400, 404))

    async def test_trash_and_cleanup(self):
        data = await self.bundle_data()
        bundle = await self.body(await self.client.post(P + "/bundles", json=data, headers=WRITE), 201)
        path = f"{P}/bundles/{bundle['id']}"
        trash_id = (await self.body(await self.client.delete(path + "?expected_revision=1", headers=WRITE), 200))["trash_id"]
        listing = await self.body(await self.client.get(P + "/trash"), 200)
        self.assertEqual([(e["trash_id"], e["name"]) for e in listing["trash"]], [(trash_id, "Red Dress Girl")])
        restored = await self.body(await self.client.post(f"{P}/trash/{trash_id}/restore", headers=WRITE), 200)
        self.assertEqual((restored["id"], restored["revision"]), (bundle["id"], 2))
        await self.body(await self.client.get(path), 200)
        trash_id = (await self.body(await self.client.delete(path + "?expected_revision=2", headers=WRITE), 200))["trash_id"]
        await self.body(await self.client.delete(f"{P}/trash/{trash_id}", headers=WRITE), 200)
        await self.error(await self.client.delete(f"{P}/trash/{trash_id}", headers=WRITE), 404, "not_found")
        await self.error(await self.client.post(f"{P}/trash/..%2Fbundles/restore", headers=WRITE), 400, "invalid_id")
        self.assertEqual((await self.body(await self.client.delete(P + "/trash", headers=WRITE), 200))["deleted"], 0)
        unused = await self.body(await self.client.get(P + "/cleanup"), 200)
        self.assertEqual((unused["assets"], unused["recent"], unused["grace_hours"]), ([], 1, 24))  # uploaded just now
        sha = data["fields"][1]["asset"]["sha256"]
        report = await self.body(await self.client.post(P + "/cleanup", json={"sha256": [sha]}, headers=WRITE), 200)
        self.assertEqual((report["deleted"], report["kept"]), (0, 1))
        self.assertEqual((await self.client.get(f"{P}/assets/{sha}")).status, 200)  # still there
        await self.error(await self.client.post(P + "/cleanup", json={"sha256": "x"}, headers=WRITE), 400, "invalid")

    async def test_health_and_errors_name_no_paths(self):
        report = await self.body(await self.client.get(P + "/health"), 200)
        self.assertEqual((report["bundles"], report["corrupt"], report["writable"]), (0, [], True))
        self.assertIn("version", report)
        broken = uuid.uuid4()
        (self.root / "bundles" / f"{broken}.json").write_text("{ broken", encoding="utf-8")
        response = await self.client.get(f"{P}/bundles/{broken}")
        error = await self.error(response, 500, "corrupt_bundle")
        self.assertNotIn(str(self.root), error["message"])
        report = await self.body(await self.client.get(P + "/health"), 200)
        self.assertEqual(report["corrupt"], [f"{broken}.json"])
        self.assertNotIn(str(self.root), str(report))


if __name__ == "__main__":
    unittest.main()
