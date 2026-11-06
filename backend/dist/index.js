// Backend host for the desktop plugin (see ~/.hermes/desktop-plugins/nan-usage).
// Hidden tab: this bundle exists so dashboard plugin discovery mounts plugin_api.py.
(function () {
  "use strict";
  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !window.__HERMES_PLUGINS__) return;
  function NanUsageHidden() {
    return SDK.React.createElement(
      "p",
      { className: "text-sm text-muted-foreground p-4" },
      "NaN Usage se muestra en la app de escritorio (panel NaN Usage)."
    );
  }
  window.__HERMES_PLUGINS__.register("nan-usage", NanUsageHidden);
})();
