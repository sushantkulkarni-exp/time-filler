/**
 * background.js
 * - Buffers Tempo worklog API captures forwarded by scripts/tempoCapture.js.
 * - Builds the per-date tempoData from those captures (complete network data,
 *   not just the rendered DOM) and resolves Jira keys/summaries.
 * - Handles keyboard shortcuts (Alt+C capture, Alt+F fill today).
 * V3.1: TalentFlow edition + API-interception capture.
 */

try {
    importScripts('scripts/tempoNormalizer.js');
} catch (e) {
    console.error('Failed to load TempoNormalizer in background:', e);
}
try {
    importScripts('scripts/smartMapper.js');
} catch (e) {
    console.error('Failed to load SmartMapper in background:', e);
}

var CAPTURES_KEY = "tempoCaptures";
var MAX_CAPTURES = 500;

// ── capture buffer ───────────────────────────────────────────────────────────

function getCaptures() {
    return new Promise(function (resolve) {
        chrome.storage.local.get(CAPTURES_KEY, function (r) {
            resolve((r && r[CAPTURES_KEY]) || []);
        });
    });
}

function setCaptures(list) {
    return new Promise(function (resolve) {
        var obj = {}; obj[CAPTURES_KEY] = list;
        chrome.storage.local.set(obj, function () { resolve(); });
    });
}

// Seen-endpoints is a purely diagnostic, ephemeral map kept in service-worker
// memory (avoids a storage write per JSON response on every Jira page). It is
// repopulated as Tempo fires requests, so reload the Tempo tab before exporting.
var seenMem = {};

// Collapse a URL to host+path (drop query/hash) so we count endpoints, not
// every parameterised request, in the seen-endpoints diagnostic map.
function endpointKey(url) {
    try {
        var u = new URL(url);
        return u.host + u.pathname;
    } catch (e) {
        return String(url || "").split("?")[0].slice(0, 120);
    }
}

// ── atlassian origin (for Jira issue resolution) ──────────────────────────────

function getAtlassianOrigin(preferredTab) {
    return new Promise(function (resolve) {
        function originOf(url) {
            try {
                var u = new URL(url);
                if (u.hostname.indexOf("atlassian.net") !== -1) return u.origin;
            } catch (e) { }
            return null;
        }
        if (preferredTab && preferredTab.url) {
            var o = originOf(preferredTab.url);
            if (o) return resolve(o);
        }
        chrome.tabs.query({ url: "*://*.atlassian.net/*" }, function (tabs) {
            for (var i = 0; i < (tabs || []).length; i++) {
                var o2 = originOf(tabs[i].url);
                if (o2) return resolve(o2);
            }
            resolve(null);
        });
    });
}

/**
 * Build tempoData from buffered captures (the complete API path) and resolve
 * Jira keys/summaries. Stores it under `tempoData` and returns a summary.
 */
async function buildTempoDataFromCaptures(preferredTab, onProgress) {
    if (typeof TempoNormalizer === "undefined") {
        return { ok: false, error: "Normalizer not loaded" };
    }
    var captures = await getCaptures();
    var origin = await getAtlassianOrigin(preferredTab);
    var tempoData = await TempoNormalizer.buildTempoData(captures, {
        origin: origin,
        onProgress: onProgress
    });

    var dayCount = Object.keys(tempoData).length;
    var taskCount = 0;
    Object.keys(tempoData).forEach(function (d) { taskCount += tempoData[d].length; });

    if (taskCount > 0) {
        await new Promise(function (resolve) {
            chrome.storage.local.set({ tempoData: tempoData }, function () { resolve(); });
        });
    }

    return {
        ok: true,
        tempoData: tempoData,
        dayCount: dayCount,
        taskCount: taskCount,
        captureCount: captures.length,
        resolvedOrigin: origin,
        source: "api"
    };
}

function findTalentFlowTab() {
    return new Promise(function (resolve) {
        chrome.tabs.query({
            url: ["*://*.centralogic.ai/*", "*://*.talentflow.io/*", "*://*.talentflow/*"]
        }, function (tabs) {
            resolve((tabs && tabs[0]) || null);
        });
    });
}

async function fillSelectedDate(date, preferredTab) {
    var storage = await chrome.storage.local.get(['tempoData', 'startTime', 'selectedProject']);
    var tempoData = storage.tempoData;
    var startTime = storage.startTime || "09:30";
    var selectedProject = storage.selectedProject || "JoinFast";

    if (!tempoData || !tempoData[date]) {
        return { ok: false, error: "No data for the selected date." };
    }

    if (typeof SmartMapper !== 'undefined') {
        SmartMapper.config.startTime = startTime;
    }

    var processedData = {};
    processedData[date] = (typeof SmartMapper !== 'undefined')
        ? SmartMapper.processDay(tempoData[date])
        : tempoData[date];

    var targetTab = preferredTab || await findTalentFlowTab();
    if (!targetTab || !targetTab.id) {
        return { ok: false, error: "Open the TalentFlow tab first." };
    }

    await chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: false },
        files: ['scripts/orgAutofill.js']
    });

    chrome.tabs.sendMessage(targetTab.id, {
        action: "fillOrgTimesheet",
        tempoData: processedData,
        projectName: selectedProject
    });

    return { ok: true, tabId: targetTab.id, date: date };
}

// ── message routing ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;

    if (msg.type === "tempo-captured") {
        (async function () {
            var list = await getCaptures();
            list.push(msg.payload);
            while (list.length > MAX_CAPTURES) list.shift();
            await setCaptures(list);
            try { sendResponse({ ok: true, count: list.length }); } catch (e) { }
        })();
        return true;
    }

    if (msg.type === "tempo-get-captures") {
        getCaptures().then(function (list) {
            try { sendResponse({ ok: true, captures: list, count: list.length }); } catch (e) { }
        });
        return true;
    }

    if (msg.type === "tempo-seen") {
        var k = endpointKey(msg.payload && msg.payload.url);
        if (!seenMem[k]) {
            seenMem[k] = {
                method: (msg.payload && msg.payload.method) || "GET",
                matched: false,
                count: 0,
                sampleUrl: (msg.payload && msg.payload.url) || ""
            };
        }
        seenMem[k].count++;
        if (msg.payload && msg.payload.matched) seenMem[k].matched = true;
        // Fire-and-forget; no response needed.
        return false;
    }

    if (msg.type === "tempo-clear-captures" || msg.type === "tempo-clear-all-data") {
        seenMem = {};
        chrome.storage.local.clear(function () {
            try { sendResponse({ ok: true }); } catch (e) { }
        });
        return true;
    }

    if (msg.type === "fill-selected-date") {
        (async function () {
            var result = await fillSelectedDate(msg.date, sender && sender.tab);
            try { sendResponse(result); } catch (e) { }
        })();
        return true;
    }

    // Build the full diagnostic export: raw captures, every JSON endpoint
    // seen (matched or not), and the normalized + Jira-resolved tempoData.
    if (msg.type === "tempo-export") {
        (async function () {
            var captures = await getCaptures();
            var seen = seenMem;
            var built = await buildTempoDataFromCaptures(sender && sender.tab);
            var tempoData = (built && built.tempoData) || {};

            // Flat task list for easy diffing against Tempo.
            var tasks = [];
            Object.keys(tempoData).forEach(function (d) {
                tempoData[d].forEach(function (t) { tasks.push(t); });
            });

            var seenList = Object.keys(seen).map(function (k) {
                return {
                    endpoint: k,
                    method: seen[k].method,
                    matched: seen[k].matched,
                    count: seen[k].count,
                    sampleUrl: seen[k].sampleUrl
                };
            }).sort(function (a, b) { return b.count - a.count; });

            try {
                sendResponse({
                    ok: true,
                    export: {
                        exportedAt: new Date().toISOString(),
                        resolvedOrigin: built && built.resolvedOrigin,
                        summary: {
                            rawCaptureResponses: captures.length,
                            jsonEndpointsSeen: seenList.length,
                            matchedEndpoints: seenList.filter(function (e) { return e.matched; }).length,
                            days: Object.keys(tempoData).length,
                            tasks: tasks.length
                        },
                        seenEndpoints: seenList,
                        tempoData: tempoData,
                        tasks: tasks,
                        rawCaptures: captures
                    }
                });
            } catch (e) { }
        })();
        return true;
    }

    if (msg.type === "build-tempo-data") {
        buildTempoDataFromCaptures(sender && sender.tab)
            .then(function (res) { try { sendResponse(res); } catch (e) { } })
            .catch(function (err) { try { sendResponse({ ok: false, error: String(err) }); } catch (e) { } });
        return true;
    }
});

// ── keyboard shortcuts ────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async function (command) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab) return;

    // ── Alt+C: Capture from Jira Tempo ──────────────────────────────
    if (command === "capture_data") {
        if (!tab.url || tab.url.indexOf("atlassian.net") === -1) {
            console.log("Not on Jira — skipping capture shortcut.");
            return;
        }
        try {
            // Preferred: complete API-interception capture.
            var built = await buildTempoDataFromCaptures(tab);
            var taskCount = built && built.ok ? built.taskCount : 0;

            // Fallback: legacy DOM scrape if the hook captured nothing
            // (e.g. the Tempo tab wasn't reloaded after install).
            if (!taskCount) {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    files: ['scripts/tempoScraper.js']
                });
                var results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: function () {
                        if (typeof window.scrapeTempoData === 'function') return window.scrapeTempoData();
                        return null;
                    }
                });
                var valid = null;
                for (var i = 0; i < results.length; i++) {
                    if (results[i].result && typeof results[i].result === 'object' && Object.keys(results[i].result).length > 0) {
                        valid = results[i];
                        break;
                    }
                }
                if (valid) {
                    await chrome.storage.local.set({ tempoData: valid.result });
                    taskCount = -1; // signal DOM success (count unknown here)
                }
            }

            if (taskCount !== 0) {
                chrome.action.setBadgeText({ text: "OK", tabId: tab.id });
                chrome.action.setBadgeBackgroundColor({ color: "#00875A" });
            } else {
                chrome.action.setBadgeText({ text: "NO", tabId: tab.id });
                chrome.action.setBadgeBackgroundColor({ color: "#DE350B" });
            }
            setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
        } catch (e) {
            console.error("Capture shortcut error:", e);
        }
    }

    // ── Alt+F: Fill today on TalentFlow ─────────────────────────────
    if (command === "fill_data") {
        var now = new Date();
        var today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
        try {
            var result = await fillSelectedDate(today, tab);
            if (!result.ok) {
                chrome.action.setBadgeText({ text: "NO", tabId: tab.id });
                chrome.action.setBadgeBackgroundColor({ color: "#DE350B" });
                setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
                return;
            }

            chrome.action.setBadgeText({ text: "GO", tabId: tab.id });
            setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
        } catch (e) {
            console.error("Fill shortcut error:", e);
        }
    }
});
