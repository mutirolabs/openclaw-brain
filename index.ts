// Plugin entry. Consumed by OpenClaw's bundled channel loader via the
// `openclaw.extensions` field in package.json.
//
// `defineBundledChannelEntry` wires the channel plugin descriptor (loaded
// from ./src/channel.ts) into OpenClaw's registry. The heavier runtime
// module (./src/channel.runtime.ts) is loaded lazily from inside the channel
// plugin itself (via `createLazyRuntimeNamedExport`), so we do not need to
// register it here as a `PluginRuntime` setter.

import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "mutiro",
  name: "Mutiro",
  description: "The official Mutiro Channel extension for OpenClaw.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./src/channel.js",
    exportName: "mutiroPlugin",
  },
});
