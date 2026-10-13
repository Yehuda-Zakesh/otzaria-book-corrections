# Existing embedded reader API and separate panel proposal

## APIs used by this plugin

The embedded reader uses host methods, not the rejected editing/panel proposal. On 13 October 2026 the exact released tag `0.9.98+801` (`35c39819140625857d4bb7f0e4b02d264dcebcab`) was also inspected: it contains none of the four embedded-reader methods below and no `feedback.submitBookCorrection`. The earlier availability entries below refer to the local development host's declared minimum, not the released 0.9.98 API. Version 0.2.1 sends reports with the released `network.fetchStream` API and hides reader selection in 0.9.98. Embedded boot from a patched host, or a newer host version, enables reader functionality.

| RPC | Required permission | Availability and host restrictions |
| --- | --- | --- |
| `reader.getDefaultTextReader({})` | `reader.open` | Since `0.9.98`; returns `{pluginId, enabled, available}`. `enabled` means this plugin is selected; `available` means a selected reader is currently usable. |
| `reader.setDefaultTextReader({enabled})` | `reader.open`, plus granted `library.books.read` and `library.content.read` | Since `0.9.98`; boolean required. Enabled plugin with a tool page, foreground instance and real user activation required. Background calls are rejected. Disabling cannot deselect another plugin. |
| `reader.setTextReaderFontSize({fontSize})` | `reader.open` | Since `0.9.98`; finite number from 14 through 60. Requires a live associated text-reader tab, foreground instance and this plugin still selected as that tab's reader. The adapter does not require a separate activation check here. |
| `reader.reportTextReaderLocation({index, ref?})` | `reader.open` | Since `0.9.98`; nonnegative integer index. Same instance/tab ownership checks as font size. Optional string `ref` up to 500 characters updates the native title. Updates native visible indices and saves tabs, including when another book tab is selected. |
| `reader.openBook({id?, bookId?, bookUid?, index?, reader:'native', navigateToPositionIfReused:true})` | `reader.open` | `openBook` itself exists since `0.9.89`; the embedded-reader/native override belongs to the `0.9.98` reader integration. Use the book's stable identity. `reader:'native'` forces the matching text-book tab to the native reader without disabling the global plugin preference. |
| `feedback.submitBookCorrection({...})` | `feedback.send_email` | Since `0.9.99`. This is independent of the embedded reader APIs. Host validates an unambiguous official library text book and report snapshots; a reader-only `0.9.98` build is insufficient for this submission route. |

The current [manifest](../plugin/manifest.json) declares `minAppVersion: 0.9.98`, `reader.open`, both library read permissions, `reader.toolbar` and `network.access`. Reports use only the allowlisted reporting endpoint; no call to `feedback.submitBookCorrection` is bundled. Permission declarations do not replace runtime grants. `setDefaultTextReader` runs only from an explicit user action when reader support is available; initialization never invokes it.

Source evidence in the local Otzaria checkout (`C:/Users/Zeev Levental/Documents/otzaria`):

- `lib/plugins/bridge/plugin_bridge_handler.dart:374`–377 and `:450`: runtime RPC permission map; the four embedded reader methods map to `reader.open`, correction submission to `feedback.send_email`. `reader.openBook` is in the same reader permission map.
- `lib/plugins/bridge/plugin_bridge_adapter.dart:2389` (`getDefaultTextReader`), `:2396` (selection activation and grants), `:2419` (font-size ownership and bounds), `:2439` (location ownership and saving), `:2475` / `:2517` (`openBook` / native override), `:5926` (correction submission validation).
- `lib/plugins/services/plugin_text_reader_registry.dart:16` defines the three required reader/library permissions; `:123` enforces ownership when selecting/deselecting a reader.
- `lib/plugins/services/plugin_extended_validator.dart:463`–466 declares the reader methods' `0.9.98` minimum; `:510` declares submission's `0.9.99` minimum. Its permission map at `:308`–311 / `:381` agrees with the runtime bridge.
- `docs/plugin-sdk/DEFAULT_TEXT_READER.md` documents foreground/user-gesture selection, per-book embedded instances, native toolbar/navigation and reader events. `docs/plugin-sdk/API_REFERENCE.md` lists availability and submission parameters.

Embedded instances receive `plugin.boot.reader`, `reader.textReaderNavigate` and `reader.textReaderCommand`. The host supplies book tabs, toolbar and navigation; the plugin supplies the editable text surface and reports its visible location. SDK theme colors/typography can be reused, but Flutter widgets cannot be imported into a WebView as live DOM components. UI matching therefore combines host-owned controls with explicitly reproduced web behavior.

## Historical proposal: reader side panel (not implemented)

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
