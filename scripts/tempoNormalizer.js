/**
 * tempoNormalizer.js
 * Turns raw Tempo API captures (buffered by background.js) into the exact
 * tempoData shape the rest of this extension expects:
 *
 *   { "YYYY-MM-DD": [ { date, issueKey, summary, duration, comment,
 *                       category, originalId, startTime, issueId } ] }
 *
 * Pipeline:
 *   1. Walk every captured JSON body and pull out objects that look like a
 *      worklog (has a date + a duration in seconds).
 *   2. Group them by calendar date, sorted by real start time, de-duped.
 *   3. Resolve numeric Jira issue ids -> issue key + summary via Jira's REST
 *      API (using the user's atlassian.net session cookie). Cached in storage.
 *
 * Environment-agnostic: attaches `TempoNormalizer` to the global object so it
 * works both inside the service worker (importScripts) and the popup (<script>).
 *
 * Ported / adapted from the standalone "Tempo Worklog Extractor" (logger).
 */

(function (global) {
    var ISSUE_CACHE_KEY = "issueCache";

    // ---- worklog extraction -------------------------------------------------

    function walk(node, visit, depth) {
        depth = depth || 0;
        if (!node || depth > 8) return;
        if (Array.isArray(node)) {
            for (var i = 0; i < node.length; i++) walk(node[i], visit, depth + 1);
            return;
        }
        if (typeof node === "object") {
            visit(node);
            for (var k in node) {
                if (node.hasOwnProperty(k)) walk(node[k], visit, depth + 1);
            }
        }
    }

    function nz(v) { return v === undefined ? null : v; }

    // Heuristic: a worklog has a date AND a numeric duration in seconds.
    function asWorklog(obj) {
        if (!obj || typeof obj !== "object") return null;

        var date = nz(obj.startDate) || nz(obj.date) || nz(obj.day) ||
            nz(obj.dateStarted) || nz(obj.started) || nz(obj.start);

        var tss = obj.timeSpentSeconds;
        if (tss == null) tss = obj.billableSeconds;
        if (tss == null) tss = obj.durationSeconds;
        if (tss == null) tss = obj.duration;

        if (!date || tss == null || typeof tss !== "number") return null;

        var issueKey =
            (obj.issue && (obj.issue.key || obj.issue.issueKey)) ||
            obj.issueKey || obj.key || null;

        var comment =
            obj.description || obj.comment ||
            (obj.issue && obj.issue.summary) || obj.summary || "";

        var startTime =
            obj.startTime || obj.timeStarted || obj.startedTime ||
            obj.timeFrom || obj.started || null;

        // Tempo returns a numeric issue id, not the human key.
        var issueId =
            obj.originTaskId || obj.issueId ||
            (obj.issue && (obj.issue.id || obj.issue.issueId)) || null;

        return {
            date: normaliseDate(date),
            startTime: normaliseTime(startTime),
            timeSpentSeconds: tss,
            issueId: issueId,
            issueKey: issueKey,
            comment: String(comment).trim()
        };
    }

    function normaliseDate(d) {
        if (!d) return "";
        if (typeof d === "string") return d.slice(0, 10);
        if (typeof d === "number") return new Date(d).toISOString().slice(0, 10);
        return String(d).slice(0, 10);
    }

    function normaliseTime(t) {
        if (!t) return "";
        var s = String(t);
        var m = s.match(/[T ](\d{2}:\d{2}:\d{2})/);
        if (m) return m[1];
        if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 8);
        return "";
    }

    function secondsToDuration(sec) {
        if (!sec || sec < 0) return "0m";
        var totalMin = Math.round(sec / 60);
        var h = Math.floor(totalMin / 60);
        var m = totalMin % 60;
        if (h && m) return h + "h " + m + "m";
        if (h) return h + "h";
        return m + "m";
    }

    // Flatten all captures into a unique list of worklogs.
    function extractWorklogs(captures) {
        var out = [];
        var seen = {};
        (captures || []).forEach(function (c) {
            walk(c && c.body, function (node) {
                var wl = asWorklog(node);
                if (!wl) return;
                var key = wl.date + "|" + wl.startTime + "|" +
                    (wl.issueId || wl.issueKey || "") + "|" +
                    wl.timeSpentSeconds + "|" + wl.comment;
                if (seen[key]) return;
                seen[key] = true;
                out.push(wl);
            });
        });
        return out;
    }

    // Group flat worklogs into the per-date tempoData shape.
    function groupByDate(worklogs) {
        var byDate = {};
        worklogs.forEach(function (wl) {
            if (!wl.date) return;
            if (!byDate[wl.date]) byDate[wl.date] = [];
            byDate[wl.date].push({
                date: wl.date,
                issueKey: wl.issueKey || "",
                summary: wl.comment || "",      // filled in by resolveIssues if a Jira summary exists
                duration: secondsToDuration(wl.timeSpentSeconds),
                comment: wl.comment || "",
                category: "",
                originalId: wl.issueId != null ? String(wl.issueId) : "",
                startTime: wl.startTime || "",
                issueId: wl.issueId
            });
        });
        // Sort each day chronologically by real start time so sequential
        // start-time assignment downstream mirrors reality.
        Object.keys(byDate).forEach(function (d) {
            byDate[d].sort(function (a, b) {
                return (a.startTime || "").localeCompare(b.startTime || "");
            });
        });
        return byDate;
    }

    // ---- Jira issue resolution ---------------------------------------------

    function getIssueCache() {
        return new Promise(function (resolve) {
            try {
                chrome.storage.local.get(ISSUE_CACHE_KEY, function (r) {
                    resolve((r && r[ISSUE_CACHE_KEY]) || {});
                });
            } catch (e) { resolve({}); }
        });
    }

    function setIssueCache(cache) {
        return new Promise(function (resolve) {
            try {
                var obj = {}; obj[ISSUE_CACHE_KEY] = cache;
                chrome.storage.local.set(obj, function () { resolve(); });
            } catch (e) { resolve(); }
        });
    }

    /**
     * Resolve numeric issue ids -> { key, summary, url }, using a same-session
     * fetch against the given atlassian origin. Returns the (updated) cache.
     */
    async function resolveIssues(tempoData, origin, onProgress) {
        var idSet = {};
        Object.keys(tempoData).forEach(function (d) {
            tempoData[d].forEach(function (t) {
                if (t.issueId != null) idSet[t.issueId] = true;
            });
        });
        var ids = Object.keys(idSet);
        var cache = await getIssueCache();
        var missing = ids.filter(function (id) { return !cache[id]; });

        if (!missing.length || !origin) return cache;

        var queue = missing.slice();
        var done = 0, failures = 0;

        async function worker() {
            while (queue.length) {
                var id = queue.shift();
                try {
                    var r = await fetch(
                        origin + "/rest/api/3/issue/" + encodeURIComponent(id) + "?fields=summary",
                        { credentials: "include", headers: { Accept: "application/json" } }
                    );
                    if (r.ok) {
                        var data = await r.json();
                        cache[id] = {
                            key: data.key || null,
                            summary: (data.fields && data.fields.summary) || "",
                            url: data.key ? (origin + "/browse/" + data.key) : null
                        };
                    } else {
                        failures++;
                        cache[id] = { key: null, summary: "", url: null, status: r.status };
                    }
                } catch (e) {
                    failures++;
                }
                done++;
                if (onProgress) onProgress(done, missing.length, failures);
            }
        }

        // Light concurrency to be polite to Jira.
        await Promise.all([worker(), worker(), worker(), worker()]);
        await setIssueCache(cache);
        return cache;
    }

    // Apply resolved keys/summaries back onto the grouped tempoData (in place).
    function applyIssueCache(tempoData, cache) {
        Object.keys(tempoData).forEach(function (d) {
            tempoData[d].forEach(function (t) {
                var hit = t.issueId != null ? cache[t.issueId] : null;
                if (hit) {
                    if (hit.key) t.issueKey = hit.key;
                    if (hit.summary) t.summary = hit.summary;
                }
                // Guarantee a usable title: prefer issue summary, else comment.
                if (!t.summary) t.summary = t.comment || "";
            });
        });
        return tempoData;
    }

    /**
     * Full pipeline: captures -> grouped, Jira-resolved tempoData.
     * @param {Array}  captures  buffered API captures
     * @param {Object} opts      { origin, onProgress }
     */
    async function buildTempoData(captures, opts) {
        opts = opts || {};
        var worklogs = extractWorklogs(captures);
        var grouped = groupByDate(worklogs);
        if (opts.origin) {
            var cache = await resolveIssues(grouped, opts.origin, opts.onProgress);
            applyIssueCache(grouped, cache);
        } else {
            // No origin to resolve against — still guarantee a title.
            applyIssueCache(grouped, {});
        }
        return grouped;
    }

    global.TempoNormalizer = {
        extractWorklogs: extractWorklogs,
        groupByDate: groupByDate,
        secondsToDuration: secondsToDuration,
        resolveIssues: resolveIssues,
        applyIssueCache: applyIssueCache,
        buildTempoData: buildTempoData
    };
})(typeof self !== "undefined" ? self : this);
