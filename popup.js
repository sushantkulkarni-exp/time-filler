/**
 * popup.js — V3: TalentFlow Edition
 *
 * popup.js
 * V2: Multi-Select Dates + Project Selector
 * - Chips are toggleable (click to select/deselect)
 * - Project dropdown to choose which HuHoKa project
 * - Only selected dates are sent to orgAutofill
 * - Cross-browser compatible (Chrome, Edge, Brave)
 */

document.addEventListener('DOMContentLoaded', async function () {
    var captureSection = document.getElementById('capture-section');
    var fillSection = document.getElementById('fill-section');
    var captureBtn = document.getElementById('captureBtn');
    var fillBtn = document.getElementById('fillBtn');
    var startTimeInput = document.getElementById('startTimeConfig');
    var projectSelect = document.getElementById('projectSelect');
    var messageEl = document.getElementById('message');
    var modeBadge = document.getElementById('mode-badge');
    var selectAllBtn = document.getElementById('selectAllBtn');
    var clearAllBtn = document.getElementById('clearAllBtn');
    var todayOnlyBtn = document.getElementById('todayOnlyBtn');
    var today = new Date().toISOString().split('T')[0];

    // Track which dates are selected
    var selectedDates = new Set();

    // 1. Query active tab
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];

    if (!tab) {
        showMessage("No active tab found.", "error");
        return;
    }

    // Detect page type by URL
    var isTempo = tab.url && tab.url.includes('atlassian.net');
    var isTalentFlow = tab.url && (
        tab.url.includes('centralogic.ai') ||
        tab.url.includes('talentflow.io') ||
        tab.url.includes('talentflow')
    );

    // Load stored settings/data
    var storage = await chrome.storage.local.get(['tempoData', 'startTime', 'selectedProject']);

    if (storage.startTime && startTimeInput) {
        startTimeInput.value = storage.startTime;
    }
    if (storage.selectedProject && projectSelect) {
        projectSelect.value = storage.selectedProject;
    }

    // 2. SMART UI SWITCHING
    if (isTempo) {
        if (captureSection) captureSection.style.display = 'block';
        if (fillSection) fillSection.style.display = 'none';
        if (modeBadge) {
            modeBadge.innerText = "Mode: Capture";
            modeBadge.style.background = "#E6FCFF";
            modeBadge.style.color = "#0052CC";
        }
    } else if (isTalentFlow) {
        if (captureSection) captureSection.style.display = 'none';
        if (fillSection) fillSection.style.display = 'block';
        if (modeBadge) {
            modeBadge.innerText = "Mode: Fill (TalentFlow)";
            modeBadge.style.background = "#E3FCEF";
            modeBadge.style.color = "#006644";
        }
    } else {
        if (captureSection) captureSection.style.display = 'none';
        if (fillSection) fillSection.style.display = 'block';
        if (modeBadge) {
            modeBadge.innerText = "Mode: Fill";
            modeBadge.style.background = "#E3FCEF";
            modeBadge.style.color = "#006644";
        }

        renderDateChips(storage.tempoData);
    }

    // Select All / Clear All buttons
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', function () {
            if (!storage.tempoData) return;
            var allDates = Object.keys(storage.tempoData);
            allDates.forEach(function (d) { selectedDates.add(d); });
            refreshChipStyles();
            updateFillButton();
        });
    }

    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', function () {
            selectedDates.clear();
            refreshChipStyles();
            updateFillButton();
        });
    }
    // Today Only button
    if (todayOnlyBtn) {
        todayOnlyBtn.addEventListener('click', function () {
            selectedDates.clear();
            if (storage.tempoData && storage.tempoData[today]) {
                selectedDates.add(today);
            } else {
                // Pick the most recent date in captured data
                if (storage.tempoData) {
                    var dates = Object.keys(storage.tempoData).sort();
                    if (dates.length) selectedDates.add(dates[dates.length - 1]);
                }
            }
            refreshChipStyles();
            updateFillButton();
        });
    }


    if (projectSelect) {
        projectSelect.addEventListener('change', function () {
            chrome.storage.local.set({ selectedProject: projectSelect.value });
        });
    }

    function renderDateChips(data) {
        var container = document.getElementById('date-chips');
        if (!container) return;

        if (!data || typeof data !== 'object') {
            container.innerHTML = "<span style='font-size:10px; color:#666;'>No data captured. Go to Jira Tempo first.</span>";
            updateFillButton();
            return;
        }

        container.innerHTML = "";
        var dates = Object.keys(data).sort();

        if (dates.length === 0) {
            container.innerHTML = "<span style='font-size:10px; color:#666;'>No dates captured yet.</span>";
            updateFillButton();
            return;
        }

        // Auto-select today if it exists in captured data
        if (data[today]) {
            selectedDates.add(today);
        }

        dates.forEach(function (date) {
            var chip = document.createElement('span');
            chip.className = 'chip';
            chip.dataset.date = date;

            // Show day name + date + task count
            var dayName = "";
            try {
                dayName = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' });
            } catch (e) {
                dayName = "";
            }
            var taskCount = data[date] ? data[date].length : 0;
            var isToday = date === today;
            chip.innerText = (isToday ? '★ ' : '') + dayName + ' ' + date + ' (' + taskCount + ' task' + (taskCount !== 1 ? 's' : '') + ')';
            if (isToday) chip.title = 'Today — click to toggle selection';

            chip.addEventListener('click', function () {
                if (selectedDates.has(date)) {
                    selectedDates.delete(date);
                } else {
                    selectedDates.add(date);
                }
                refreshChipStyles();
                updateFillButton();
            });

            container.appendChild(chip);
        });

        refreshChipStyles();
        updateFillButton();
    }

    function refreshChipStyles() {
        var chips = document.querySelectorAll('.chip[data-date]');
        for (var i = 0; i < chips.length; i++) {
            if (selectedDates.has(chips[i].dataset.date)) {
                chips[i].classList.add('active');
            } else {
                chips[i].classList.remove('active');
            }
        }
    }

    function updateFillButton() {
        if (!fillBtn) return;

        var count = selectedDates.size;
        if (count === 0) {
            fillBtn.disabled = true;
            fillBtn.innerText = "Select dates above";
            fillBtn.classList.remove('pulse');
            if (messageEl) messageEl.innerText = "Click on date chips to select which days to fill.";
            if (messageEl) messageEl.className = "normal";
        } else if (count === 1) {
            var date = Array.from(selectedDates)[0];
            fillBtn.disabled = false;
            fillBtn.innerText = "⚡ Auto-Fill " + date;
            fillBtn.classList.add('pulse');
            if (messageEl) messageEl.innerText = "";
        } else {
            fillBtn.disabled = false;
            fillBtn.innerText = "⚡ Auto-Fill " + count + " Days";
            fillBtn.classList.add('pulse');
            if (messageEl) messageEl.innerText = "";
        }
    }

    // ============================================================
    // CAPTURE ACTION
    // ============================================================

    if (captureBtn) {
        captureBtn.addEventListener('click', async function () {
            captureBtn.disabled = true;
            showMessage("Reading captured Tempo network data…", "normal");

            try {
                // ── PRIMARY: complete API-interception capture ──────────────
                // background.js buffers every worklog response Tempo loads
                // (including cards never painted in the DOM) and resolves Jira
                // keys/summaries. This is what fixes "some tasks not filled".
                var built = await sendMessage({ type: "build-tempo-data" });

                if (built && built.ok && built.taskCount > 0) {
                    showMessage(
                        "✅ Captured " + built.dayCount + " days, " +
                        built.taskCount + " tasks (network capture). Saved.",
                        "success"
                    );
                    setTimeout(function () { window.close(); }, 1600);
                    return;
                }

                // ── FALLBACK: legacy DOM scrape ─────────────────────────────
                // Used when the network hook captured nothing yet — usually
                // because the Tempo tab wasn't reloaded after install/update.
                showMessage("No network data yet — scanning visible cards…", "normal");

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

                var validResult = null;
                for (var i = 0; i < results.length; i++) {
                    var r = results[i];
                    if (r.result !== null && typeof r.result === 'object' && Object.keys(r.result).length > 0) {
                        validResult = r;
                        break;
                    }
                }

                if (validResult) {
                    var data = validResult.result;
                    var dayCount = Object.keys(data).length;
                    var totalTasks = 0;
                    var days = Object.keys(data);
                    for (var j = 0; j < days.length; j++) {
                        totalTasks += data[days[j]].length;
                    }

                    await chrome.storage.local.set({ tempoData: data });
                    showMessage(
                        "✅ Found " + dayCount + " days, " + totalTasks +
                        " tasks (visible cards). Tip: reload the Tempo tab so the " +
                        "network capture can grab the full week.",
                        "success"
                    );
                    setTimeout(function () { window.close(); }, 2200);
                } else {
                    showMessage(
                        "Failed: no Tempo data found. Reload the Tempo tab once " +
                        "(the capture hook installs on load), navigate the weeks, then retry.",
                        "error"
                    );
                    captureBtn.disabled = false;
                }
            } catch (e) {
                showMessage("Error: " + e.message, "error");
                captureBtn.disabled = false;
            }
        });
    }

    // Promise wrapper around chrome.runtime.sendMessage.
    function sendMessage(payload) {
        return new Promise(function (resolve) {
            try {
                chrome.runtime.sendMessage(payload, function (resp) {
                    if (chrome.runtime.lastError) { resolve(null); return; }
                    resolve(resp);
                });
            } catch (e) { resolve(null); }
        });
    }

    // ── Export captured data as JSON (diagnostic) ───────────────────────────
    var exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async function () {
            exportBtn.disabled = true;
            showMessage("Building export…", "normal");

            var resp = await sendMessage({ type: "tempo-export" });
            if (!resp || !resp.ok || !resp.export) {
                showMessage("Export failed — reload the Tempo tab, then retry.", "error");
                exportBtn.disabled = false;
                return;
            }

            var data = resp.export;
            var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            var json = JSON.stringify(data, null, 2);

            // Download via a blob URL + anchor (no "downloads" permission needed).
            var blob = new Blob([json], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'tempo-capture-' + stamp + '.json';
            document.body.appendChild(a);
            a.click();
            setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);

            var s = data.summary || {};
            showMessage(
                "✅ Exported " + (s.tasks || 0) + " tasks / " + (s.days || 0) +
                " days. Endpoints seen: " + (s.jsonEndpointsSeen || 0) +
                " (" + (s.matchedEndpoints || 0) + " matched).",
                "success"
            );
            exportBtn.disabled = false;
        });
    }

    // ============================================================
    // FILL ACTION
    // ============================================================

    if (fillBtn) {
        fillBtn.addEventListener('click', async function () {
            if (selectedDates.size === 0) {
                showMessage("Please select at least one date.", "error");
                return;
            }

            var startTime = startTimeInput ? startTimeInput.value : "09:30";
            var projectName = projectSelect ? projectSelect.value : "eXp-JoinFast";

            // Save preferences
            chrome.storage.local.set({ startTime: startTime, selectedProject: projectName });

            var freshStorage = await chrome.storage.local.get('tempoData');
            var tempoData = freshStorage.tempoData;

            if (!tempoData) {
                showMessage("No captured data found. Capture from Jira first.", "error");
                return;
            }

            // Process ONLY the selected dates
            if (typeof SmartMapper !== 'undefined') {
                SmartMapper.config.startTime = startTime || "09:00";
            }

            var processedData = {};
            var selectedArr = Array.from(selectedDates);
            for (var i = 0; i < selectedArr.length; i++) {
                var date = selectedArr[i];
                if (tempoData[date]) {
                    if (typeof SmartMapper !== 'undefined') {
                        processedData[date] = SmartMapper.processDay(tempoData[date]);
                    } else {
                        processedData[date] = tempoData[date];
                    }
                }
            }

            if (Object.keys(processedData).length === 0) {
                showMessage("No data for selected dates.", "error");
                return;
            }

            fillBtn.disabled = true;
            fillBtn.innerText = "🚀 Filling...";

            try {
                await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    files: ['scripts/orgAutofill.js']
                });

                chrome.tabs.sendMessage(tab.id, {
                    action: "fillOrgTimesheet",
                    tempoData: processedData,
                    projectName: projectName
                }, function () {
                    if (chrome.runtime.lastError) {
                        // Ignore "receiving end does not exist" for non-listening frames
                    }
                });

                var dateList = Array.from(selectedDates).sort().join(', ');
                showMessage("🚀 Filling " + selectedDates.size + " day(s): " + dateList, "success");
                setTimeout(function () { window.close(); }, 1200);

            } catch (e) {
                showMessage("Error: " + e.message, "error");
                fillBtn.disabled = false;
                updateFillButton();
            }
        });
    }

    function showMessage(msg, type) {
        if (!messageEl) return;
        messageEl.innerText = msg;
        messageEl.className = type || "normal";
    }
});
