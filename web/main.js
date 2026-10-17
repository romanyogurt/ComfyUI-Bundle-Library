import { app } from "../../scripts/app.js";
import { checkVersion, getMessages } from "./api.js";
import { NODE_ID, setupLoaderNode } from "./loader_node.js";
import { openLibrary, renderSidebar } from "./library_modal.js";
import { useLoader, useLocale } from "./i18n.js";

// The pack speaks the language ComfyUI is set to (Settings > Comfy > Locale), read whenever text is made.
useLocale(() => app.extensionManager?.setting?.get("Comfy.Locale"));

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = new URL("./bundle_library.css", import.meta.url).href;
document.head.append(stylesheet);

app.registerExtension({
    name: "BundleLibrary",
    commands: [
        {
            id: "BundleLibrary.Open",
            label: "Open Bundle Library",
            icon: "pi pi-box",
            function: () => openLibrary(),
        },
    ],
    menuCommands: [{ path: ["Extensions"], commands: ["BundleLibrary.Open"] }],

    // ComfyUI waits for init before it registers the nodes and loads the workflow: the messages are here before
    // anything of the pack is drawn. A server that does not answer holds ComfyUI up for 5 seconds at most.
    async init() {
        await Promise.race([useLoader(getMessages), new Promise((done) => setTimeout(done, 5000))]);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name === NODE_ID) setupLoaderNode(nodeType);
    },

    setup() {
        app.extensionManager.registerSidebarTab({
            id: "bundle-library",
            icon: "pi pi-box",
            title: "Bundle Library",
            tooltip: "Bundle Library",
            type: "custom",
            render: renderSidebar,
        });
        void checkVersion();
    },
});
