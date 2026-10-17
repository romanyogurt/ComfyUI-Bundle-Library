// Choosing a file the library already keeps, for a media field (0.0.29): the
// stored files of the field's kind as a grid of previews, most recently stored
// first, with the names bundles gave them and the bundles that use them. A file
// chosen here is not uploaded again (files are kept by their content); the
// server keeps it through a cleanup's grace time again, as after an upload.
import { listStoredAssets, takeStoredAsset, thumbnailURL } from "./api.js";
import { button, el, formatBytes, formatDuration, formatTime, icon } from "./dom.js";
import { msg, t } from "./i18n.js";

const TITLES = { image: msg("picker.title_image"), video: msg("picker.title_video"), audio: msg("picker.title_audio") };

/** How many bundles use a stored file, in words: in use, only in the trash, or none. */
function usage(asset) {
    const live = new Set(asset.used_by.filter((use) => !use.deleted).map((use) => use.id)).size;
    if (live) return t("picker.used_by", { count: live });
    return asset.used_by.length ? t("picker.trash_only") : t("picker.unused");
}

/** What a filter is matched against: the file's names and the bundles and fields that use it. */
function searchText(asset) {
    return [...asset.names, ...asset.used_by.flatMap((use) => [use.name, use.field])].join("\n").toLowerCase();
}

/**
 * Show the stored files of `kind` over the library window (`modal`'s layer);
 * resolves to the asset chosen, as an upload answers it (with the name bundles
 * gave the file most), or null when none was. `current` is the SHA-256 of the
 * field's file: it is marked, and choosing it changes nothing (null).
 */
export function pickStoredAsset(modal, kind, current) {
    return new Promise((resolve) => {
        const box = el("div", "bl-confirm wide bl-picker");
        const filter = el("input", "bl-input bl-picker-filter");
        filter.type = "search";
        filter.placeholder = t("picker.filter");
        filter.setAttribute("aria-label", t("picker.filter"));
        const note = el("div", "bl-hint bl-picker-note", t("common.loading"));
        const grid = el("div", "bl-picker-grid");
        const problem = el("div", "bl-error");
        problem.hidden = true;
        const cancel = button(t("common.cancel"));
        const row = el("div", "bl-confirm-buttons");
        row.append(cancel);
        box.append(el("div", "bl-confirm-title", t(TITLES[kind])), filter, note, grid, problem, row);
        let assets = [];
        let done = false;
        let token = null;
        const finish = (asset) => {
            if (done) return;
            done = true;
            modal.hideLayer(token); // its own layer only
            resolve(asset);
        };
        const choose = async (asset) => {
            if (asset.sha256 === current) return finish(null); // the file it has: nothing changes
            grid.inert = true;
            problem.hidden = true;
            try {
                const { asset: info } = await takeStoredAsset(asset.sha256);
                finish(asset.names.length ? { ...info, original_name: asset.names[0] } : info);
            } catch (error) {
                if (done) return; // dismissed meanwhile
                problem.textContent = error.message;
                problem.hidden = false;
                grid.inert = false;
            }
        };
        const tile = (asset) => {
            const item = button("", "bl-picker-tile");
            item.dataset.sha256 = asset.sha256;
            const preview = el("div", "bl-picker-preview");
            if (kind === "audio") {
                preview.append(icon("volume-up"));
            } else {
                const img = el("img");
                img.src = thumbnailURL(asset.sha256, 256);
                img.loading = "lazy";
                img.alt = "";
                img.draggable = false;
                preview.append(img);
            }
            if (asset.duration != null) preview.append(el("span", "bl-picker-duration", formatDuration(asset.duration)));
            if (asset.sha256 === current) {
                item.classList.add("current");
                preview.append(el("span", "bl-picker-current", t("picker.current")));
            }
            const name = asset.names[0] ?? `${asset.ext.toUpperCase()} · ${formatBytes(asset.bytes)}`;
            item.append(preview, el("div", "bl-picker-name", name), el("div", "bl-picker-use", usage(asset)));
            item.setAttribute("aria-label", `${name} · ${usage(asset)}`);
            item.title = [...asset.names,
                ...asset.used_by.map((use) => [use.name, use.field, use.deleted ? t("picker.in_trash") : null].filter(Boolean).join(" · ")),
                t("picker.stored_at", { time: formatTime(asset.stored_at) })].join("\n");
            item.addEventListener("click", () => void choose(asset));
            return item;
        };
        const draw = () => {
            const query = filter.value.trim().toLowerCase();
            const shown = query ? assets.filter((asset) => searchText(asset).includes(query)) : assets;
            grid.replaceChildren(...shown.map(tile));
            note.textContent = !assets.length ? t("picker.empty") : !shown.length ? t("picker.no_match") : "";
            note.hidden = !note.textContent;
        };
        cancel.addEventListener("click", () => finish(null));
        filter.addEventListener("input", draw);
        token = modal.showLayer(box, () => finish(null));
        filter.focus();
        listStoredAssets(kind).then((answer) => {
            if (done) return;
            assets = answer.assets;
            draw();
        }, (error) => {
            if (!done) note.textContent = t("picker.failed", { reason: error.message });
        });
    });
}
