// Browser scenarios for video and audio fields (Phase 6): editing them in the
// library, the node preview, and playback. The files come from fixtures/
// (make_fixtures.py). Set-up and safety notes are in harness.cjs.
const path = require("path");
const fs = require("fs");
const { startSession } = require("./harness.cjs");

const FIXTURES = path.join(__dirname, "fixtures");
const NAME = "[test] Media UI";

(async () => {
    const session = await startSession("media");
    const { page, ev, check, shot, finish } = session;
    const overlay = page.locator(".bl-overlay");
    const fields = page.locator(".bl-overlay .bl-field");
    const button = (name, scope = overlay) => scope.getByRole("button", { name, exact: true });
    const menuItem = (name, scope = overlay) => scope.getByRole("menuitem", { name, exact: true });
    const until = (fn, arg) => page.waitForFunction(fn, arg, { timeout: 10000 }).then(() => true, () => false);
    const api = (method, route) => ev(([m, r]) => window.__bl.request(m, r), [method, route]);
    const choose = async (card, label, file) => {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button(label, card).click()]);
        await chooser.setFiles(file);
    };
    const cardError = (index) => ev((i) => document.querySelectorAll(".bl-overlay .bl-field")[i]
        .querySelector(".bl-error:not([hidden])")?.textContent ?? null, index);

    // ---- editing video and audio fields --------------------------------------
    await ev(() => window.__bl.app.extensionManager.command.execute("BundleLibrary.Open"));
    await overlay.waitFor();
    await button("+ New bundle").click();
    await page.keyboard.type(NAME);
    for (const [type, name] of [["Video", "clip"], ["Audio", "bgm"]]) {
        await button("+ Add field ▾").click();
        await menuItem(type).click();
        await page.keyboard.type(name);
    }
    const empty = await ev(() => [...document.querySelectorAll(".bl-overlay .bl-field .bl-drop")].map((d) => d.textContent));
    check("new video and audio fields ask for a file", JSON.stringify(empty) === JSON.stringify([
        "Drop a video here, or Choose a video…", "Drop an audio file here, or Choose an audio file…"]), empty);

    await ev(async () => {
        const card = document.querySelectorAll(".bl-overlay .bl-field")[0];
        const data = new DataTransfer();
        data.items.add(await window.__bl.makeImage("#123456", "not a video"));
        card.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    let error = await cardError(0);
    check("an image dropped on a video card is refused before uploading", error === "Only MP4, WebM and MOV videos are accepted.", error);
    await choose(fields.nth(0), "Choose a video…",
        { name: "not-a-video.mp4", mimeType: "video/mp4", buffer: fs.readFileSync(path.join(FIXTURES, "tone.mp3")) });
    await until(() => document.querySelector(".bl-overlay .bl-field .bl-error:not([hidden])")?.textContent.includes("no video"));
    error = await cardError(0);
    check("audio sent as a video is refused by the server, with the reason", error === "This file has no video; use an audio field for it.", error);

    await choose(fields.nth(0), "Choose a video…", path.join(FIXTURES, "clip.mp4"));
    await fields.nth(0).locator("video.bl-video").waitFor();
    await choose(fields.nth(1), "Choose an audio file…", path.join(FIXTURES, "tone.mp3"));
    await fields.nth(1).locator("audio.bl-audio").waitFor();
    const cards = await ev(async () => {
        const [videoCard, audioCard] = document.querySelectorAll(".bl-overlay .bl-field");
        const video = videoCard.querySelector("video"), audio = audioCard.querySelector("audio");
        const ready = (media) => new Promise((resolve) => {
            if (media.readyState >= 1) resolve();
            media.addEventListener("loadedmetadata", resolve, { once: true });
            setTimeout(resolve, 5000);
        });
        await Promise.all([ready(video), ready(audio)]);
        return {
            video: videoCard.querySelector(".bl-media-meta div").textContent,
            poster: video.getAttribute("poster"), videoLength: video.duration, videoWidth: video.videoWidth,
            audio: audioCard.querySelector(".bl-media-meta div").textContent, audioLength: audio.duration,
            names: [...document.querySelectorAll(".bl-overlay .bl-media-meta .bl-dim")].map((d) => d.textContent),
            progressGone: [...document.querySelectorAll(".bl-overlay progress")].every((p) => p.hidden),
        };
    });
    check("the video card plays the upload, with its poster and details",
        cards.video === "160 × 120 · 24 fps · 0:02 · 37.4 KB · h264 + aac" && cards.poster.includes("/thumb?size=512")
        && Math.abs(cards.videoLength - 2) < 0.1 && cards.videoWidth === 160, cards);
    check("the audio card plays the upload, with its details",
        /^0:0[12] · 44\.1 kHz · stereo · 24\.3 KB · mp3$/.test(cards.audio) && Math.abs(cards.audioLength - 1.5) < 0.2, cards);
    check("file names are kept and the progress bars are gone",
        JSON.stringify(cards.names) === JSON.stringify(["clip.mp4", "tone.mp3"]) && cards.progressGone, cards);
    await shot("media-editor.png");

    await page.keyboard.press("Control+s");
    const saved = await until(() => document.querySelector(".bl-overlay .bl-state")?.textContent === "Saved"
        && document.querySelector(".bl-overlay .bl-list-item.selected"));
    const id = await ev(() => document.querySelector(".bl-overlay .bl-list-item.selected").dataset.id);
    const bundle = await api("GET", `/bundles/${id}`);
    const [clip, bgm] = bundle.fields.map((f) => f.asset);
    check("saved with the metadata read from the files", saved && clip.ext === "mp4" && clip.has_audio === true
        && clip.fps === 24 && bgm.ext === "mp3" && bgm.sample_rate === 44100, { clip, bgm });
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "detached" });

    // ---- the node preview ----------------------------------------------------
    await ev(async (bundleId) => {
        const b = window.__bl;
        b.app.graph.clear();
        const node = b.add("BundleLibraryLoad", [120, 120]);
        node.setSize([420, node.size[1]]);
        window.__node = node;
        await b.pick(node, bundleId);
    }, id);
    await page.waitForTimeout(600);
    const preview = await ev(() => {
        const rows = window.__node.bundlePanel.rows;
        const tile = rows.querySelector('[data-field="clip"]');
        const chip = rows.querySelector('[data-field="bgm"]');
        return {
            outs: window.__bl.outs(window.__node).map((o) => [o.label, o.type]),
            video: tile?.classList.contains("video"), poster: tile?.querySelector("img")?.getAttribute("src"),
            play: tile?.querySelector(".bl-tile-play")?.textContent, length: tile?.querySelector(".bl-tile-duration")?.textContent,
            ratio: tile && tile.offsetWidth / tile.offsetHeight, chip: chip?.textContent,
        };
    });
    check("the node outputs VIDEO and AUDIO", JSON.stringify(preview.outs) === JSON.stringify([["clip", "VIDEO"], ["bgm", "AUDIO"]]),
        preview.outs);
    check("the video is a gallery tile: poster frame, play mark, length, 4:3",
        preview.video && preview.poster.includes("/thumb?size=512") && preview.play === "▶" && preview.length === "0:02"
        && Math.abs(preview.ratio - 4 / 3) < 0.05, preview);
    check("the audio is a chip with a play button and its length", /^bgm▶0:0[12]$/.test(preview.chip), preview.chip);
    await shot("media-node.png");

    await page.locator('.bl-panel [data-field="clip"]').click();
    const played = await page.waitForFunction(() => {
        const video = document.querySelector(".bl-lightbox video");
        return video && video.currentTime > 0.2 && { time: video.currentTime, src: video.getAttribute("src") };
    }, null, { timeout: 10000 }).then((h) => h.jsonValue(), () => null);
    check("clicking the tile plays the video over the page", played && /\/assets\/[0-9a-f]{64}$/.test(played.src), played);
    await shot("media-lightbox.png");
    await page.keyboard.press("Escape");
    check("Escape closes the video", await until(() => !document.querySelector(".bl-lightbox")));

    const playButton = page.locator('.bl-panel [data-field="bgm"] .bl-play');
    await playButton.click();
    await page.waitForTimeout(300);
    const sounding = await playButton.textContent();
    await playButton.click();
    const paused = await until(() => document.querySelector('.bl-panel [data-field="bgm"] .bl-play')?.textContent === "▶");
    check("the audio chip plays, then pauses", sounding === "⏸" && paused, sounding);

    await ev(() => window.__bl.app.graph.clear());
    await finish({ expectRemoved: 1 });
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
