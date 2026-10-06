# Proposed reader panel API

Status: proposal against Otzaria tag `0.9.98+801`. None of these panel methods exist in that release. Requires a small host change; does not require changing any book database.

## Host the existing plugin UI

```ts
Otzaria.call('plugin.openPanel', {
  param: { selection }, // JSON, at most 64 KiB
  width: 380           // optional logical pixels; host clamps to available space
}); // RPC data: { panelId, instanceId }

Otzaria.on('plugin.panelOpened', ({ panelId, param }) => { /* load selection */ });
Otzaria.call('plugin.closePanel', { panelId });
Otzaria.on('plugin.panelClosed', ({ panelId, reason }) => { /* release ownership */ });
```

Use permission `ui.reader_panel` for opening/closing an owned panel. Both background and foreground SDK instances can call these methods. Identity comes from the bridge's authenticated `plugin.pluginId` and `instanceId`; callers cannot open another plugin or inject an owner ID. Lifecycle events are private owner events, delivered without a separate broad event subscription permission.

One panel per reader tab, with an explicit owner. A second plugin receives `error.busy`; reopening by the same owner delivers new `param` to the existing panel without dropping its editor state. Return the RPC promptly after registering the request; do not wait for user editing. Queue `plugin.panelOpened` until the exact panel instance has completed SDK boot. Limit boot to 15 seconds, surface host creation failures, discard stale pending events, and send `plugin.panelClosed` with reason `boot_failed`. No timeout for user thinking or reading.

The panel remains beside the reading surface while the user scrolls or follows references. Use a native resizable side column with a close button; no modal barrier and no navigation to Tools. In narrow windows use a compact docked bottom region that leaves the reader interactive. Bind it to its originating reader tab; hide on another tab and close when that reader tab closes. Closing, disabling/uninstalling the plugin, or destroying the owning runtime cancels pending work and disposes the WebView. Reasons: `user`, `reader_closed`, `plugin_disabled`, `owner_gone`, `boot_failed`.

Send/edit/error states remain plugin code. Existing network and plugin-storage permissions still apply. The host never interprets corrected text, sends a report, rewrites source content, or calls book write repositories. An optional successful submission closes the panel from plugin code after the server accepts the report. Draft saving remains in plugin storage.

## Real integration points

- `lib/plugins/bridge/plugin_bridge_adapter.dart`: `_handlePlugin`, `PluginBridgeAdapter.instanceId`, and `PluginBridgeDependencies.dispatchEventToPlugin` provide authenticated routing for the two methods and private lifecycle events. Wire the same service in adapters built by `plugin_tab_page.dart` and `plugin_background_host.dart`.
- `lib/plugins/view/plugin_tab_page.dart`: `PluginTabPage(plugin: InstalledPlugin, instanceId: String)` already supplies WebView, injected SDK, theme, permission gates, and creation-error UI. Reuse it with a distinct `panel:<id>` instance; adapt its ready/dispose hooks to notify the panel service independently of tool-tab navigation.
- `lib/text_book/view/text_book_screen.dart`: the `TextBookScaffold(...)` call around line 2877 is the shared reader surface for combined, split and page-shape strategies. Wrap that surface in a panel host rather than changing each strategy or database provider. Keep text-field shortcuts/focus scoped so typing does not trigger reader shortcuts.
- Add `PluginPanelService` with panel ownership, per-instance boot queues and a notifier observed by the reader host. Do not use `PluginPageLauncher.open` for panel delivery: its `_pending` and `_deliveryChain` are keyed by plugin ID, and `_hasReadyPage` accepts any ready page. With a tool tab already open this can route the selection to the wrong instance.
- Extend `plugin_bridge_handler.dart`, `plugin_valid_permissions.dart`, `plugin_extended_validator.dart`, SDK declarations and generated API reference/spec with the new methods, permission, events and actual first supporting app version. Existing `0.9.98` installations must receive a clear unsupported-version message.
- For direct context-menu opening add `openIn: 'reader-panel'` to `PluginContextMenuItem` and startup parsing/validation. Reject combinations with `openPlugin` or `action`. Require `ui.reader_panel` alongside the existing `reader.context_menu` and `app.startup_contributions` permissions. `dispatchPluginContextMenuItemClick` in `lib/plugins/utils/plugin_context_menu_entries.dart` should snapshot its existing full selection payload at click time and queue the existing `contextMenu.itemClicked` event for the exact panel instance after boot. Keep the reader tab active and preserve that snapshot while the user continues scrolling. This route requires no background permission or engine activation.

The plugin must prevent two editors sharing the single `draft` key: when a panel owns a correction, the optional Tools tab is read-only or explicitly transfers ownership. Never let both instances race to save/send the same draft.

## Required checks

Open from a selection while a Tools tab is already running; verify exact instance delivery. Exercise front/background callers, boot timeout and WebView failure, double-submit prevention, network failure, tab switching/closing and plugin disable. Verify all three reader layouts remain scrollable and theme/RTL/focus remain correct. Assert that opening, typing, submitting and closing invoke no book database write method.
