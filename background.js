/**
 * background.js
 * Handles keyboard shortcut commands (Alt+C to capture, Alt+F to fill today).
 * V3: TalentFlow edition.
 */

try {
    importScripts('scripts/smartMapper.js');
} catch (e) {
    console.error('Failed to load SmartMapper in background:', e);
}

chrome.commands.onCommand.addListener(async function (command) {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab) return;

    // ── Alt+C: Capture from Jira Tempo ──────────────────────────────
    if (command === "capture_data") {
        if (!tab.url || !tab.url.includes("atlassian.net")) {
            console.log("Not on Jira — skipping capture shortcut.");
            return;
        }
        try {
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
                chrome.action.setBadgeText({ text: "OK", tabId: tab.id });
                chrome.action.setBadgeBackgroundColor({ color: "#00875A" });
                setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
            }
        } catch (e) {
            console.error("Capture shortcut error:", e);
        }
    }

    // ── Alt+F: Fill today on TalentFlow ─────────────────────────────
    if (command === "fill_data") {
        var today = new Date().toISOString().split('T')[0];
        try {
            var storage = await chrome.storage.local.get(['tempoData', 'startTime', 'selectedProject']);
            var tempoData = storage.tempoData;
            var startTime = storage.startTime || "09:30";
            var selectedProject = storage.selectedProject || "JoinFast";

            if (!tempoData || !tempoData[today]) {
                chrome.action.setBadgeText({ text: "NO", tabId: tab.id });
                chrome.action.setBadgeBackgroundColor({ color: "#DE350B" });
                setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
                return;
            }

            if (typeof SmartMapper !== 'undefined') {
                SmartMapper.config.startTime = startTime;
            }

            var processedData = {};
            processedData[today] = (typeof SmartMapper !== 'undefined')
                ? SmartMapper.processDay(tempoData[today])
                : tempoData[today];

            await chrome.scripting.executeScript({
                target: { tabId: tab.id, allFrames: false },
                files: ['scripts/orgAutofill.js']
            });

            chrome.tabs.sendMessage(tab.id, {
                action: "fillOrgTimesheet",
                tempoData: processedData,
                projectName: selectedProject
            });

            chrome.action.setBadgeText({ text: "GO", tabId: tab.id });
            setTimeout(function () { chrome.action.setBadgeText({ text: "", tabId: tab.id }); }, 2000);
        } catch (e) {
            console.error("Fill shortcut error:", e);
        }
    }
});
