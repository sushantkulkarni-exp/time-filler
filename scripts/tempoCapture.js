/**
 * tempoCapture.js
 * Content script for *.atlassian.net / *.tempo.io. Runs at document_start in
 * every frame so the network hook is installed BEFORE Tempo fires its first
 * XHR. Two jobs:
 *   1. Inject tempoInject.js into the page's main world.
 *   2. Forward every worklog response the hook captures to the background
 *      service worker, which buffers them in chrome.storage.local.
 *
 * NOTE: because the hook must be in place before Tempo's first request, the
 * Tempo tab has to be reloaded once after installing/updating the extension.
 */

(function () {
    var TAG = "[TF:TempoCapture]";

    // 1. Inject the main-world hook (must beat Tempo's own scripts).
    try {
        var s = document.createElement("script");
        s.src = chrome.runtime.getURL("scripts/tempoInject.js");
        s.async = false;
        (document.head || document.documentElement).appendChild(s);
        s.onload = function () { s.remove(); };
    } catch (e) {
        console.warn(TAG, "failed to inject hook", e);
    }

    // 2. Forward page -> background.
    window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.source !== "tf-tempo-capture") return;
        try {
            if (data.kind === "response") {
                chrome.runtime.sendMessage({
                    type: "tempo-captured",
                    payload: {
                        url: data.url,
                        method: data.method,
                        via: data.via,
                        capturedAt: new Date().toISOString(),
                        body: data.body
                    }
                });
            } else if (data.kind === "seen") {
                chrome.runtime.sendMessage({
                    type: "tempo-seen",
                    payload: { url: data.url, method: data.method, matched: data.matched }
                });
            }
        } catch (e) {
            // Extension context may be invalidated on reload — ignore.
        }
    });
})();
