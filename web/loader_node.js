import { app } from "../../scripts/app.js";
import { CHANGED_EVENT, forgetBundles, listBundles, thumbnailURL } from "./api.js";
import { el } from "./dom.js";
import { openLibrary } from "./library_modal.js";
import { COMFY_TYPES, parseSpec, planChanges, planSlots, serializeSpec, slotStatuses } from "./reconcile.js";

export const NODE_ID = "BundleLibraryLoad";

const OUTPUT = 2; // LiteGraph.OUTPUT
const MARGIN = 4; // around the panel inside its widget area
const GAP = 6; // between the bar and the preview (bundle_library.css)
const MAX_PREVIEW = 320; // a taller preview scrolls
const PROBLEMS = { missing: "not in this bundle", type_mismatch: "another type in this bundle" };

// Nodes showing a panel, for the refreshes that concern them all.
const panels = new Set();

function refreshAllPanels() {
    forgetBundles();
    for (const node of panels) {
        if (node.graph) void refreshPanel(node);
    }
}

// The list may have changed in another tab or through the library modal.
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshAllPanels();
});
window.addEventListener(CHANGED_EVENT, refreshAllPanels);

function widget(node, name) {
    return node.widgets?.find((w) => w.name === name);
}

function specOf(node) {
    return parseSpec(widget(node, "slot_spec")?.value) ?? [];
}

const isLinked = (output) => (output?.links?.length ?? 0) > 0;
const outputName = (index) => `field_${String(index + 1).padStart(2, "0")}`;

/** The node's slots with whether each output is linked, as planSlots() takes them. */
function currentSlots(node) {
    return specOf(node).map((slot, i) => ({ ...slot, linked: isLinked(node.outputs[i]) }));
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

/**
 * Height of the panel widget. The classic renderer sizes the node from it,
 * so it follows the rendered content; Nodes 2.0 lays the panel out by its
 * content anyway. Offscreen (nothing rendered) it falls back to an estimate.
 */
function panelHeight(node) {
    const { bar, preview, rows, notice } = node.bundlePanel;
    const barHeight = bar.offsetHeight || 26;
    if (preview.hidden) return barHeight + 2 * MARGIN;
    const content = (rows.offsetHeight || 22 * Math.max(specOf(node).length, 1))
        + (notice.hidden ? 0 : (notice.offsetHeight || 30) + 4);
    return barHeight + GAP + Math.min(content, MAX_PREVIEW) + 2 * MARGIN;
}

/** Size the node to its content. Only after the user changed something:
 * resizing on load would mark an untouched workflow as modified. */
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

/** Point the node at `bundle` (a summary from the list), reshaping its outputs per planSlots(). */
export function selectBundle(node, bundle) {
    const current = currentSlots(node);
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
            detail: `A node has ${slots.length} outputs at most, so ${overflow} field(s) are not shown.`,
            life: 6000,
        });
    }
    renderPreview(node, bundle);
    fitHeight(node);
    recordUndoStep();
    void refreshPanel(node); // the dropdown's marks depend on the new links and outputs
}

function previewValue(field) {
    if (field.type === "image") {
        if (!field.preview) return el("span", "bl-empty", "(no image)");
        const img = el("img", "bl-thumb");
        img.src = thumbnailURL(field.preview.sha256);
        img.alt = field.name;
        return img;
    }
    if (field.type === "text") return el("span", "bl-text", field.preview);
    if (field.type === "boolean") return el("span", "bl-value", field.preview ? "✓ true" : "✗ false");
    return el("span", "bl-value", String(field.preview));
}

function renderNotice(node, bundle) {
    const { notice } = node.bundlePanel;
    const { added, removed, retyped } = planChanges(currentSlots(node), bundle.fields);
    const parts = [...added.map((n) => `+${n}`), ...removed.map((n) => `−${n}`), ...retyped.map((n) => `~${n}`)];
    notice.replaceChildren();
    notice.hidden = parts.length === 0;
    if (notice.hidden) return;
    const update = el("button", "bl-update", "Update outputs");
    update.title = "Add new fields, drop unconnected outputs that left the bundle, retype unconnected outputs";
    update.addEventListener("click", () => selectBundle(node, bundle));
    notice.append(el("span", "bl-notice-text", `Bundle fields changed: ${parts.join(", ")}`), update);
}

function renderPreview(node, bundle) {
    const { rows, notice } = node.bundlePanel;
    rows.replaceChildren();
    notice.hidden = true;
    if (!widget(node, "bundle_id")?.value) {
        rows.append(el("div", "bl-note", "Select a bundle."));
        return;
    }
    if (!bundle) {
        const name = node.properties.bundle_name ?? widget(node, "bundle_id").value;
        rows.append(el("div", "bl-note bl-bad", `⚠ Bundle not found: ${name}`));
        return;
    }
    const slots = specOf(node);
    const statuses = slotStatuses(slots, bundle.fields);
    const fields = new Map(bundle.fields.map((f) => [f.name, f]));
    slots.forEach((slot, i) => {
        const row = el("div", "bl-row");
        row.append(el("span", "bl-name", slot.name), el("span", "bl-type", slot.type));
        if (statuses[i] === "ok") {
            row.append(previewValue(fields.get(slot.name)));
        } else if (isLinked(node.outputs[i])) {
            row.append(el("span", "bl-bad", `⚠ ${PROBLEMS[statuses[i]]}; running will fail`));
        } else {
            row.append(el("span", "bl-dim", `${PROBLEMS[statuses[i]]} (not connected)`));
        }
        rows.append(row);
    });
    renderNotice(node, bundle);
}

function fillSelect(node, bundles) {
    const { select } = node.bundlePanel;
    const selected = widget(node, "bundle_id")?.value ?? "";
    const linked = currentSlots(node).filter((s) => s.linked);
    const options = [["", "Select a bundle…"]];
    for (const bundle of bundles) {
        const lacking = linked.filter((s) => slotStatuses([s], bundle.fields)[0] !== "ok");
        options.push([bundle.id, lacking.length
            ? `${bundle.name}  ⚠ no ${lacking.map((s) => s.name).join(", ")}`
            : bundle.name]);
    }
    if (selected && !bundles.some((b) => b.id === selected)) {
        options.push([selected, `⚠ Not found: ${node.properties.bundle_name ?? selected}`]);
    }
    // Rebuilding the options of an open dropdown closes it, so only rebuild on a real change.
    const signature = JSON.stringify(options);
    if (node.bundlePanel.optionsSignature !== signature) {
        node.bundlePanel.optionsSignature = signature;
        select.replaceChildren(...options.map(([value, label]) => {
            const option = el("option", null, label);
            option.value = value;
            return option;
        }));
    }
    if (select.value !== selected) select.value = selected;
}

async function refreshPanel(node, { fresh = false } = {}) {
    if (!node.bundlePanel) return;
    let bundles;
    try {
        bundles = await listBundles({ fresh });
    } catch (error) {
        node.bundlePanel.rows.replaceChildren(
            el("div", "bl-note bl-bad", `⚠ Could not load the bundle list: ${error.message}`));
        return;
    }
    fillSelect(node, bundles);
    renderPreview(node, bundles.find((b) => b.id === widget(node, "bundle_id")?.value));
}

async function pick(node, bundleId) {
    if (!bundleId) return;
    const bundle = (await listBundles()).find((b) => b.id === bundleId);
    if (bundle) selectBundle(node, bundle);
}

function setCollapsed(node, collapsed) {
    const { preview, toggle } = node.bundlePanel;
    preview.hidden = collapsed;
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.title = collapsed ? "Show the preview" : "Hide the preview";
}

function addPanel(node) {
    const root = el("div", "bl-panel");
    const bar = el("div", "bl-bar");
    const toggle = el("button", "bl-toggle");
    const select = el("select", "bl-select");
    const open = el("button", "bl-open", "📚");
    open.title = "Open the Bundle Library";
    const preview = el("div", "bl-preview");
    const rows = el("div", "bl-rows");
    const notice = el("div", "bl-notice");
    notice.hidden = true;
    preview.append(rows, notice);
    bar.append(toggle, select, open);
    root.append(bar, preview);
    node.bundlePanel = { root, bar, toggle, select, preview, rows, notice };
    setCollapsed(node, !!node.properties.preview_collapsed);

    toggle.addEventListener("click", () => {
        node.properties.preview_collapsed = !node.properties.preview_collapsed;
        setCollapsed(node, node.properties.preview_collapsed);
        fitHeight(node);
        recordUndoStep();
    });
    select.addEventListener("change", () => void pick(node, select.value));
    select.addEventListener("focus", () => void refreshPanel(node, { fresh: true }));
    open.addEventListener("click", () => openLibrary({
        onPick: (bundle) => selectBundle(node, bundle),
        linked: currentSlots(node).filter((s) => s.linked),
        selected: widget(node, "bundle_id")?.value || null,
    }));
    // Keep wheel scrolling inside the preview instead of zooming the canvas.
    preview.addEventListener("wheel", (e) => {
        if (preview.scrollHeight > preview.clientHeight) e.stopPropagation();
    });

    const panel = node.addDOMWidget("bundle_panel", "BUNDLE_LIBRARY_PANEL", root, {
        serialize: false, // keep it out of the API prompt
        hideOnZoom: false,
        margin: MARGIN,
        getMinHeight: () => panelHeight(node),
    });
    panel.serialize = false; // and out of widgets_values
    panels.add(node);
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
        setCollapsed(this, !!this.properties.preview_collapsed);
        void refreshPanel(this);
        return result;
    };

    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function (side) {
        const result = onConnectionsChange?.apply(this, arguments);
        if (side === OUTPUT) void refreshPanel(this);
        return result;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
        panels.delete(this);
        return onRemoved?.apply(this, arguments);
    };
}
