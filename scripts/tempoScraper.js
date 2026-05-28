/**
 * tempoScraper.js
 * Scrapes Tempo Weekly View.
 * V2: Improved summary extraction, cross-browser compatible.
 */

// We attach to window so we can call it via executeScript({func: ...})
window.scrapeTempoData = function () {
    console.log("Tempo Scraper: Scanning frame...");
    var rawData = {};

    // Selector based on Tempo's HTML structure
    var cards = document.querySelectorAll('div[name="tempoWorklogCard"]');

    if (cards.length === 0) {
        console.log("Tempo Scraper: No cards found in this frame.");
        return null;
    }

    console.log("Tempo Scraper: Found " + cards.length + " cards!");

    cards.forEach(function (card) {
        try {
            // 1. Get Date
            var dateAttr = card.getAttribute("data-date"); // "2026-01-12 09:30:00.000"
            if (!dateAttr) return;
            var date = dateAttr.split(" ")[0];

            // 2. Get Duration
            var durationEl = card.querySelector('[name="tempoCardDuration"]');
            var duration = durationEl ? durationEl.innerText.trim() : "0h";

            // 3. Get Issue Key
            var issueKey = "";
            var issueKeyLink = card.querySelector('[name="tempoCardIssueKey"] a');
            if (issueKeyLink) {
                issueKey = issueKeyLink.innerText.trim();
            } else {
                var issueKeyDiv = card.querySelector('[name="tempoCardIssueKey"]');
                if (issueKeyDiv) {
                    issueKey = issueKeyDiv.innerText.trim();
                }
            }

            // 4. Get Summary — careful to not grab duration/issueKey text
            var summary = "Unknown Task";
            // Try title attribute first (most reliable)
            var allTitledElements = card.querySelectorAll('[title]');
            for (var i = 0; i < allTitledElements.length; i++) {
                var el = allTitledElements[i];
                // Skip elements that are the comment or duration
                if (el.getAttribute('name') === 'tempoCardComment') continue;
                if (el.getAttribute('name') === 'tempoCardDuration') continue;
                if (el.getAttribute('name') === 'tempoCardIssueKey') continue;
                var titleVal = el.getAttribute('title');
                if (titleVal && titleVal.length > 2) {
                    summary = titleVal.trim();
                    break;
                }
            }

            // 5. Get Comment
            var commentDiv = card.querySelector('[name="tempoCardComment"]');
            var comment = commentDiv ? commentDiv.innerText.trim() : "";

            if (!rawData[date]) {
                rawData[date] = [];
            }

            rawData[date].push({
                date: date,
                issueKey: issueKey,
                summary: summary,
                duration: duration,
                comment: comment,
                category: "",
                originalId: card.id || ""
            });
        } catch (e) {
            console.error("Error parsing card:", e);
        }
    });

    return rawData;
};

// Also listen for message (legacy support / direct message from background)
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (request.action === "scrapeTempo") {
            var data = window.scrapeTempoData();
            if (data) {
                sendResponse({ success: true, count: Object.keys(data).length, data: data });
            } else {
                sendResponse({ success: false, error: "No cards found in this frame" });
            }
        }
    });
}
