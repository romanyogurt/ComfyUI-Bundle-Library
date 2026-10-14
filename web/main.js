import { app } from "../../scripts/app.js";
import { NODE_ID, setupLoaderNode } from "./loader_node.js";
import { openLibrary, renderSidebar } from "./library_modal.js";

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
    menuCommands: [{ path: ["Extensions", "Bundle Library"], commands: ["BundleLibrary.Open"] }],

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
    },
});
