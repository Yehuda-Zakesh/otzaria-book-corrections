# Native book correction API archive

This branch preserves the latest native reporting implementation from main at
81948d1, including the plugin caller, report preparation, tests, and the Otzaria
integration patch in `docs/otzaria-book-reporting.patch`.

`docs/otzaria-book-reporting-current.patch` is the complete updated Otzaria
integration, exported from the local Otzaria commits fa1d2cced, 25de39381 and
a68e30f09 (base 920a4fe75). It includes queue control, reader-book context,
source validation, the current `feedback.send_email` permission, and tests.
Prefer this updated patch; the original patch is kept as historical context.

It calls `feedback.submitBookCorrection` and requires Otzaria 0.9.99 with that
method installed. It is not the version intended for the current Otzaria release.
Main uses the existing reporting endpoint and does not call this new API.

The older `archive/native-reporting` branch remains available unchanged. Use this
branch as the starting point when the native API is accepted. Multi-book tabs and
the release workflows on main can then be brought over without restoring the old
minimum version or permission mappings from the historical patch.
