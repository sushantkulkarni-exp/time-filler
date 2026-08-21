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

    function setStatus(message, isError) {
        var panel = document.getElementById("tempo-helper-panel-status");
        if (!panel) return;
        panel.innerText = message || "";
        panel.style.color = isError ? "#c23b3b" : "#0052CC";
    }

    function refreshPanel() {
        var select = document.getElementById("tempo-helper-panel-dates");
        var fillBtn = document.getElementById("tempo-helper-panel-fill");
        if (!select || !fillBtn) return;

        chrome.storage.local.get(['tempoData'], function (storage) {
            var data = storage.tempoData || {};
            var dates = Object.keys(data).sort();
            select.innerHTML = "";
            if (dates.length === 0) {
                var emptyOpt = document.createElement("option");
                emptyOpt.value = "";
                emptyOpt.textContent = "No saved dates";
                select.appendChild(emptyOpt);
                fillBtn.disabled = true;
                return;
            }

            dates.forEach(function (date) {
                var opt = document.createElement("option");
                opt.value = date;
                opt.textContent = date;
                select.appendChild(opt);
            });
            fillBtn.disabled = false;
        });
    }

    function removePanel() {
        var panel = document.getElementById("tempo-helper-panel");
        if (panel) panel.remove();
    }

    function injectPanel() {
        if (document.getElementById("tempo-helper-panel")) return;

        var panel = document.createElement("div");
        panel.id = "tempo-helper-panel";
        panel.style.cssText = "position:fixed;right:14px;top:14px;z-index:2147483647;background:#fff;border:1px solid #dfe1e6;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.16);padding:10px 12px;font-family:Arial,sans-serif;max-width:260px;";

        panel.innerHTML = [
            '<div style="font-size:12px;font-weight:700;color:#0052CC;margin-bottom:8px;">Tempo Helper</div>',
            '<div style="display:flex;gap:8px;margin-bottom:8px;">',
            '  <button id="tempo-helper-panel-capture" style="flex:1;padding:6px 8px;border:0;border-radius:6px;background:#0052CC;color:#fff;cursor:pointer;">Capture</button>',
            '  <button id="tempo-helper-panel-clear" style="flex:1;padding:6px 8px;border:0;border-radius:6px;background:#DE350B;color:#fff;cursor:pointer;">Clear</button>',
            '</div>',
            '<div style="margin-bottom:8px;">',
            '  <label style="display:block;font-size:11px;color:#6b778c;margin-bottom:4px;">Fill a specific date</label>',
            '  <select id="tempo-helper-panel-dates" style="width:100%;padding:6px;border:1px solid #dfe1e6;border-radius:6px;font-size:12px;"></select>',
            '</div>',
            '<button id="tempo-helper-panel-fill" style="width:100%;padding:7px 8px;border:0;border-radius:6px;background:#00875A;color:#fff;cursor:pointer;">Fill Selected Date</button>',
            '<div id="tempo-helper-panel-status" style="margin-top:8px;font-size:11px;color:#0052CC;min-height:14px;"></div>'
        ].join("");

        document.documentElement.appendChild(panel);

        document.getElementById("tempo-helper-panel-capture").addEventListener("click", async function () {
            setStatus("Capturing…");
            var resp = await chrome.runtime.sendMessage({ type: "build-tempo-data" });
            if (resp && resp.ok) {
                setStatus("Captured " + (resp.dayCount || 0) + " day(s)." );
                refreshPanel();
            } else {
                setStatus("Capture failed.", true);
            }
        });

        document.getElementById("tempo-helper-panel-clear").addEventListener("click", async function () {
            setStatus("Clearing…");
            var resp = await chrome.runtime.sendMessage({ type: "tempo-clear-all-data" });
            if (resp && resp.ok) {
                setStatus("Cleared all saved data.");
                refreshPanel();
            } else {
                setStatus("Clear failed.", true);
            }
        });

        document.getElementById("tempo-helper-panel-fill").addEventListener("click", async function () {
            var select = document.getElementById("tempo-helper-panel-dates");
            if (!select || !select.value) {
                setStatus("Choose a date first.", true);
                return;
            }
            setStatus("Filling…");
            var resp = await chrome.runtime.sendMessage({ type: "fill-selected-date", date: select.value });
            if (resp && resp.ok) {
                setStatus("Filled " + select.value + " for TalentFlow.");
            } else {
                setStatus(resp && resp.error ? resp.error : "Fill failed.", true);
            }
        });

        refreshPanel();
    }

    if (window === window.top) {
        chrome.storage.local.get(["showFloatingTempoHelper"], function (storage) {
            if (storage.showFloatingTempoHelper === true) {
                injectPanel();
            }
        });

        chrome.storage.onChanged.addListener(function (changes, areaName) {
            if (areaName !== "local") return;

            if (changes.showFloatingTempoHelper) {
                if (changes.showFloatingTempoHelper.newValue === true) {
                    injectPanel();
                } else {
                    removePanel();
                }
            }

            if (changes.tempoData) {
                refreshPanel();
            }
        });
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
