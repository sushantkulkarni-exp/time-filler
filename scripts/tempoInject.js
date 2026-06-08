/**
 * tempoInject.js
 * Runs in the PAGE's main world (injected by tempoCapture.js). Wraps fetch +
 * XMLHttpRequest so we can read the JSON responses Tempo uses to populate the
 * "My Work" calendar. Anything that looks like worklog data is forwarded to the
 * content script via window.postMessage.
 *
 * This is the "complete" capture path: it sees EVERY worklog Tempo loads over
 * the network, including cards that are never painted into the DOM (Tempo
 * virtualises the calendar, which is why pure DOM scraping misses tasks).
 *
 * Ported from the standalone "Tempo Worklog Extractor" (logger workspace).
 */

(function () {
    if (window.__tfTempoInjected) return;
    window.__tfTempoInjected = true;

    var TAG = "[TF:TempoInject]";
    var WORKLOG_HINTS = [
        "worklog",
        "work-log",
        "timesheet",
        "time-sheet",
        "plan-item",
        "planitem",
        "calendar-event",
        "calendarevent",
        "/4/worklogs",
        "/tempo-timesheets/",
        "my-work"
    ];

    function looksRelevant(url) {
        if (!url) return false;
        var u = String(url).toLowerCase();
        for (var i = 0; i < WORKLOG_HINTS.length; i++) {
            if (u.indexOf(WORKLOG_HINTS[i]) !== -1) return true;
        }
        return false;
    }

    function send(payload) {
        try {
            var msg = { source: "tf-tempo-capture", kind: "response" };
            for (var k in payload) { if (payload.hasOwnProperty(k)) msg[k] = payload[k]; }
            window.postMessage(msg, window.location.origin);
        } catch (e) {
            console.warn(TAG, "postMessage failed", e);
        }
    }

    // Lightweight diagnostic: report EVERY JSON endpoint seen (URL only, no
    // body) so the export can reveal worklog endpoints the filter might miss.
    function sendSeen(url, method, matched) {
        try {
            window.postMessage({
                source: "tf-tempo-capture",
                kind: "seen",
                url: String(url || ""),
                method: method || "GET",
                matched: !!matched
            }, window.location.origin);
        } catch (e) { /* swallow */ }
    }

    // ---- fetch hook ----
    var origFetch = window.fetch;
    if (typeof origFetch === "function") {
        window.fetch = function () {
            var args = arguments;
            var req = args[0];
            var url = typeof req === "string" ? req : (req && req.url);
            var method =
                (args[1] && args[1].method) ||
                (typeof req === "object" && req && req.method) ||
                "GET";
            var self = this;
            return origFetch.apply(self, args).then(function (response) {
                try {
                    var clone = response.clone();
                    var ct = clone.headers.get("content-type") || "";
                    if (ct.indexOf("json") !== -1) {
                        var matched = looksRelevant(url);
                        sendSeen(url, method, matched);
                        if (matched) {
                            clone.json().then(function (body) {
                                send({ via: "fetch", url: url, method: method, body: body });
                            }).catch(function () { });
                        }
                    }
                } catch (e) { /* swallow */ }
                return response;
            });
        };
    }

    // ---- XHR hook ----
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
        this.__tf_url = url;
        this.__tf_method = method;
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        xhr.addEventListener("load", function () {
            try {
                var ct = xhr.getResponseHeader("content-type") || "";
                if (ct.indexOf("json") === -1) return;
                var matched = looksRelevant(xhr.__tf_url);
                sendSeen(xhr.__tf_url, xhr.__tf_method, matched);
                if (matched) {
                    var body = JSON.parse(xhr.responseText);
                    send({ via: "xhr", url: xhr.__tf_url, method: xhr.__tf_method, body: body });
                }
            } catch (e) { /* swallow */ }
        });
        return origSend.apply(this, arguments);
    };

    console.log(TAG, "hooks installed in", window.location.href);
})();
