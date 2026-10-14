import { app } from "../../scripts/app.js";
import { listBundles, thumbnailURL } from "./api.js";
import { COMFY_TYPES, parseSpec, planSlots, serializeSpec, slotStatuses } from "./reconcile.js";
import { openLibrary } from "./spike_modal.js";

export const NODE_ID = "BundleLibraryLoad";

const OUTPUT = 2; // LiteGraph.OUTPUT
const STATUS_TEXT = {
    missing: "이 번들에 없음 — 실행 시 오류",
    type_mismatch: "타입이 다름 — 실행 시 오류",
};

function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function specOf(node) {
    return parseSpec(widget(node, "slot_spec")?.value) ?? [];
}

const isLinked = (output) => (output?.links?.length ?? 0) > 0;
const outputName = (index) => `field_${String(index + 1).padStart(2, "0")}`;

function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
}

/** Show output `index` as the field `slot` describes. */
function dressOutput(node, index, slot) {
    const output = node.outputs[index];
    output.name = outputName(index);
    output.label = slot.name;
    const type = COMFY_TYPES[slot.type];
    if (output.type === type) return;
    if (node.graph) node.setOutputDataType(index, type); // also recolours its links
    else output.type = type;
}

function fitHeight(node) {
    node.setSize([node.size[0], node.computeSize([...node.size])[1]]);
    node.setDirtyCanvas(true, true);
}

function recordUndoStep() {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.captureCanvasState?.();
}

/**
 * Re-apply `slot_spec` after the frontend rebuilt the outputs from the node
 * definition (load, paste, undo): definition names and `*` types come back,
 * only labels survive. Synchronous, so links recreated after configure are
 * type-checked against the real types.
 */
function restoreOutputs(node) {
    const slots = specOf(node);
    for (let i = node.outputs.length - 1; i >= slots.length; i--) {
        if (!isLinked(node.outputs[i])) node.removeOutput(i);
    }
    slots.forEach((slot, i) => {
        if (node.outputs[i]) dressOutput(node, i, slot);
    });
}

/** Point the node at `bundle`, reshaping its outputs per planSlots(). */
export function selectBundle(node, bundle) {
    const current = specOf(node).map((slot, i) => ({ ...slot, linked: isLinked(node.outputs[i]) }));
    const { slots, overflow } = planSlots(current, bundle.fields);
    const kept = new Set(slots.filter((s) => s.from !== null).map((s) => s.from));
    for (let i = node.outputs.length - 1; i >= 0; i--) {
        if (!kept.has(i) && !isLinked(node.outputs[i])) node.removeOutput(i);
    }
    slots.forEach((slot, i) => {
        if (slot.from === null) node.addOutput(outputName(i), COMFY_TYPES[slot.type]);
        dressOutput(node, i, slot);
    });
    widget(node, "slot_spec").value = serializeSpec(slots);
    widget(node, "bundle_id").value = bundle.id;
    node.properties.bundle_name = bundle.name;
    if (overflow) {
        app.extensionManager?.toast?.add({
            severity: "warn",
            summary: "Load Bundle",
            detail: `출력은 ${slots.length}개까지라 필드 ${overflow}개를 표시하지 못했습니다.`,
            life: 6000,
        });
    }
    fitHeight(node);
    recordUndoStep();
    void refreshPanel(node);
}

function previewValue(bundle, field) {
    if (field.type === "image") {
        if (!field.preview) return el("span", "bl-empty", "(이미지 없음)");
        const img = el("img", "bl-thumb");
        img.loading = "lazy";
        img.src = thumbnailURL(bundle.id, field.name);
        img.alt = field.name;
        return img;
    }
    if (field.type === "text") return el("span", "bl-text", field.preview);
    if (field.type === "boolean") return el("span", "bl-value", field.preview ? "✓ true" : "✗ false");
    return el("span", "bl-value", String(field.preview));
}

function renderPreview(node, bundle) {
    const { preview } = node.bundlePanel;
    preview.replaceChildren();
    const slots = specOf(node);
    if (!widget(node, "bundle_id")?.value) {
        preview.append(el("div", "bl-note", "번들을 고르세요."));
        return;
    }
    if (!bundle) {
        const name = node.properties.bundle_name ?? widget(node, "bundle_id").value;
        preview.append(el("div", "bl-note bl-bad", `⚠ 번들을 찾을 수 없습니다: ${name}`));
        return;
    }
    const statuses = slotStatuses(slots, bundle.fields);
    const fields = new Map(bundle.fields.map((f) => [f.name, f]));
    slots.forEach((slot, i) => {
        const row = el("div", "bl-row");
        row.append(el("span", "bl-name", slot.name), el("span", "bl-type", slot.type));
        if (statuses[i] === "ok") row.append(previewValue(bundle, fields.get(slot.name)));
        else row.append(el("span", "bl-bad", `⚠ ${STATUS_TEXT[statuses[i]]}`));
        preview.append(row);
    });
}

function fillSelect(node, bundles) {
    const { select } = node.bundlePanel;
    const selected = widget(node, "bundle_id")?.value ?? "";
    const linked = specOf(node).filter((_, i) => isLinked(node.outputs[i]));
    select.replaceChildren(el("option", null, "번들 선택…"));
    select.firstChild.value = "";
    for (const bundle of bundles) {
        const lacking = linked.filter((s) => slotStatuses([s], bundle.fields)[0] !== "ok");
        const label = lacking.length
            ? `${bundle.name}  ⚠ ${lacking.map((s) => s.name).join(", ")} 없음`
            : bundle.name;
        const option = el("option", null, label);
        option.value = bundle.id;
        select.append(option);
    }
    if (selected && !bundles.some((b) => b.id === selected)) {
        const option = el("option", null, `⚠ 찾을 수 없음: ${node.properties.bundle_name ?? selected}`);
        option.value = selected;
        select.append(option);
    }
    select.value = selected;
}

async function refreshPanel(node, { fresh = false } = {}) {
    if (!node.bundlePanel) return;
    let bundles;
    try {
        bundles = await listBundles({ fresh });
    } catch (error) {
        node.bundlePanel.preview.replaceChildren(el("div", "bl-note bl-bad", `⚠ 목록을 불러오지 못했습니다: ${error.message}`));
        return;
    }
    fillSelect(node, bundles);
    renderPreview(node, bundles.find((b) => b.id === widget(node, "bundle_id")?.value));
}

async function pick(node, bundleId) {
    if (!bundleId) return;
    const bundles = await listBundles();
    const bundle = bundles.find((b) => b.id === bundleId);
    if (bundle) selectBundle(node, bundle);
}

function addPanel(node) {
    const root = el("div", "bl-panel");
    const bar = el("div", "bl-bar");
    const select = el("select", "bl-select");
    const open = el("button", "bl-open", "📚");
    open.title = "Bundle Library 열기";
    const preview = el("div", "bl-preview");
    bar.append(select, open);
    root.append(bar, preview);

    select.addEventListener("change", () => void pick(node, select.value));
    select.addEventListener("focus", () => void refreshPanel(node, { fresh: true }));
    open.addEventListener("click", () => openLibrary({ onPick: (bundle) => selectBundle(node, bundle) }));
    // Keep wheel scrolling inside the preview instead of zooming the canvas.
    preview.addEventListener("wheel", (e) => {
        if (preview.scrollHeight > preview.clientHeight) e.stopPropagation();
    });

    const panel = node.addDOMWidget("bundle_panel", "BUNDLE_LIBRARY_PANEL", root, {
        serialize: false, // keep it out of the API prompt
        hideOnZoom: false,
        getMinHeight: () => 56 + Math.min(specOf(node).length, 6) * 40,
    });
    panel.serialize = false; // and out of widgets_values
    node.bundlePanel = { root, select, preview };
}

export function setupLoaderNode(nodeType) {
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = onNodeCreated?.apply(this, arguments);
        // Called synchronously by createNode, before configure on load.
        for (let i = this.outputs.length - 1; i >= 0; i--) this.removeOutput(i);
        // `advanced` hides these in Nodes 2.0 (behind "Show advanced inputs");
        // the classic renderer ignores it, so hide them there outright.
        for (const name of ["bundle_id", "slot_spec"]) widget(this, name).hidden = true;
        this.properties ??= {};
        addPanel(this);
        this.setSize([Math.max(this.size[0], 320), this.computeSize()[1]]);
        void refreshPanel(this);
        return result;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
        const result = onConfigure?.apply(this, arguments);
        restoreOutputs(this);
        void refreshPanel(this);
        return result;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (side) {
        const result = onConnectionsChange?.apply(this, arguments);
        if (side === OUTPUT) void refreshPanel(this);
        return result;
    };
}
