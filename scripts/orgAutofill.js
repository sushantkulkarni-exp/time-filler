/**
 * orgAutofill.js — TalentFlow Edition
 * V3.1: Precise selectors from real modal HTML inspection
 *
 * MODAL STRUCTURE (confirmed from real HTML):
 *   div.absolute.z-30[style="top:Xpx; left:2px; right:2px"]   ← positioned in day column
 *     div.rounded-xl.border                                     ← the modal box (getModal target)
 *       header: "Log Time HH:MM" + X close button
 *       body:
 *         Task type buttons (plain <button>, no span.truncate):
 *           [Free Task] [Board Task] [OKR Task] [Lunch]
 *           Active = has class "bg-cyan-500"
 *
 *         Project:  button[type="button"] > span.truncate  (ORDER 0 among dropdown triggers)
 *         Title:    input[type="text"][placeholder="What did you work on? *"]
 *         Activity: button[type="button"] > span.truncate  (ORDER 1)
 *         Start:    button[type="button"] > span.truncate  (ORDER 2)  — shows "HH:MM"
 *         Hours:    input[type="number"][max="23"]
 *         Minutes:  button[type="button"] > span.truncate  (ORDER 3)  — shows "0","15","30","45"
 *         Desc:     textarea[placeholder="Description (optional)"]
 *         Cancel / Save Entry (disabled until title filled)
 *
 * WEEK NAVIGATION:
 *   Header text: "Week: May 25 - May 31, 2026"
 *   Prev/Next: <button> containing lucide-chevron-left/right SVG paths
 *
 * CALENDAR GRID:
 *   1344px = 24 hours, 28px = 30 minutes
 *   Slot top = (H*60+M)/30 * 28  (round time to nearest 30 min)
 *   Clickable cell: div.flex-1.cursor-pointer inside each absolute row
 */

// ── Guard against double-injection ──────────────────────────────────────────
if (typeof window.__tfAutofillRegistered === 'undefined') {
    window.__tfAutofillRegistered = true;

    chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
        if (request.action !== "fillOrgTimesheet") return;

        window.__tfProjectName = request.projectName || "JoinFast";
        console.log("🚀 TalentFlow AutoFill V3.1 — Project: " + window.__tfProjectName);

        smartFill(request.tempoData)
            .then(function () {
                try { sendResponse({ success: true }); } catch (e) { /* popup closed */ }
            })
            .catch(function (err) {
                console.error("AutoFill crashed:", err);
                try { sendResponse({ success: false, error: err.message }); } catch (e) { /* popup closed */ }
                showToast("❌ " + err.message, true);
            });

        return true; // keep async channel open
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATION
// ══════════════════════════════════════════════════════════════════════════════

async function smartFill(tempoData) {
    if (!tempoData || typeof tempoData !== 'object') throw new Error("No data provided!");

    var dates = Object.keys(tempoData).sort();
    var total = dates.reduce(function (s, d) { return s + (tempoData[d] ? tempoData[d].length : 0); }, 0);

    showToast("🚀 Starting: " + dates.length + " day(s), " + total + " task(s)");

    var filled = 0, skipped = 0;

    for (var di = 0; di < dates.length; di++) {
        var date = dates[di];
        var tasks = tempoData[date];
        if (!tasks || !tasks.length) continue;

        console.log("📅 " + date + " — " + tasks.length + " task(s)");
        showToast("Processing " + date + " (" + tasks.length + ")");

        var navOk = await navigateToWeek(date);
        if (!navOk) { showToast("❌ Nav failed: " + date, true); continue; }
        await wait(1500);

        for (var ti = 0; ti < tasks.length; ti++) {
            var task = tasks[ti];
            var label = ((task.issueKey || "") + " " + (task.summary || "")).trim();
            console.log("  [" + (ti + 1) + "/" + tasks.length + "] " + label);

            if (isDuplicateTask(date, task, tasks, ti)) {
                console.log("  ✅ Duplicate already on calendar, skipping.");
                skipped++;
                continue;
            }

            var ok = await fillSingleTask(date, task);
            if (!ok) {
                console.warn("  ⚠️ Retry…");
                await closeModalIfOpen();
                await wait(2000);
                ok = await fillSingleTask(date, task);
            }

            if (ok) {
                filled++;
                console.log("  🎉 Saved.");
                await waitForModalGone();
                await wait(1500); // let calendar re-render
            } else {
                console.error("  ❌ Failed: " + label);
                await closeModalIfOpen();
                await wait(800);
            }
        }
    }

    var msg = "🎉 Done! " + filled + " filled" + (skipped ? ", " + skipped + " skipped." : ".");
    showToast(msg);
    setTimeout(function () { alert(msg); }, 300);
}

// ══════════════════════════════════════════════════════════════════════════════
// WEEK NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════

async function navigateToWeek(targetDate) {
    for (var i = 0; i < 52; i++) {
        var range = getWeekRange();
        if (!range) { await wait(600); continue; }
        if (isInRange(targetDate, range.start, range.end)) return true;

        var chevrons = getChevrons();
        if (!chevrons.prev || !chevrons.next) { console.error("No chevrons found."); return false; }

        var goForward = new Date(targetDate) > new Date(range.start);
        (goForward ? chevrons.next : chevrons.prev).click();
        await wait(900);
    }
    return false;
}

function getWeekRange() {
    var MONTHS = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
    var re = /Week:\s*(\w+)\s+(\d+)\s*-\s*(\w+)\s+(\d+),\s*(\d{4})/;

    // Check all text nodes — the week label is inside a button's span
    var elements = document.querySelectorAll('button span, span, button');
    for (var i = 0; i < elements.length; i++) {
        var txt = (elements[i].innerText || elements[i].textContent || "").trim();
        var m = txt.match(re);
        if (!m) continue;
        var sm = MONTHS[m[1]], sd = +m[2], em = MONTHS[m[3]], ed = +m[4], yr = +m[5];
        if (sm === undefined || em === undefined) continue;
        var startYr = em < sm ? yr - 1 : yr;
        return {
            start: fmt(new Date(startYr, sm, sd)),
            end:   fmt(new Date(yr, em, ed))
        };
    }
    return null;
}

function getChevrons() {
    // lucide-chevron-left  path: "m15 18-6-6 6-6"
    // lucide-chevron-right path: "m9 18 6-6-6-6"
    var prev = null, next = null;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
        var path = buttons[i].querySelector('path');
        if (!path) continue;
        var d = path.getAttribute('d') || '';
        if (!prev && d.includes('15 18')) prev = buttons[i];   // chevron-left
        if (!next && d.includes('9 18'))  next = buttons[i];   // chevron-right
    }
    return { prev: prev, next: next };
}

function isInRange(date, start, end) {
    var d = +new Date(date), s = +new Date(start), e = +new Date(end);
    return d >= s && d <= e;
}

function fmt(d) {
    return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
}
function pad(n) { return String(n).padStart(2,'0'); }

// ══════════════════════════════════════════════════════════════════════════════
// FILL A SINGLE TASK
// ══════════════════════════════════════════════════════════════════════════════

async function fillSingleTask(dateStr, task) {
    var project    = window.__tfProjectName || "JoinFast";
    var startTime  = task.startTime || "09:00";
    var durationM  = task.durationMinutes || 60;
    var title      = buildTitle(task);
    var activity   = mapActivity(task.category || "Development");
    var hours      = Math.floor(durationM / 60);
    var mins       = Math.round((durationM % 60) / 15) * 15; // round to 0,15,30,45
    if (mins >= 60) { hours++; mins = 0; }
    var startLabel = roundToHalfHour(startTime); // "HH:MM" rounded to nearest :00 or :30

    console.log('  → "' + title + '" | ' + project + ' | ' + activity +
                ' | ' + startLabel + ' | ' + hours + 'h ' + mins + 'm');

    // 1. Click the time slot to open the Log Time modal
    var clicked = await clickTimeSlot(dateStr, startTime);
    if (!clicked) {
        console.error("  ❌ Could not click time slot.");
        return false;
    }

    // 2. Wait for the modal to appear (wait for the title input to exist)
    var modal = await waitForElement(getModal, 6000);
    if (!modal) {
        console.error("  ❌ Modal did not open.");
        return false;
    }
    await wait(300); // let modal fully render

    // 3. Ensure "Free Task" is selected (it should be by default, but verify)
    var freeTaskBtn = getTaskTypeButton(modal, "Free Task");
    if (freeTaskBtn && !freeTaskBtn.classList.contains('bg-cyan-500')) {
        freeTaskBtn.click();
        await wait(200);
    }

    // 4. Get the 4 custom dropdown triggers in DOM order:
    //    [0]=Project  [1]=ActivityType  [2]=StartTime  [3]=Minutes
    var triggers = getDropdownTriggers(modal);
    if (triggers.length < 2) {
        console.error("  ❌ Could not find dropdown triggers (found " + triggers.length + ").");
        return false;
    }

    // 5. Select Project (trigger[0])
    if (triggers[0]) {
        var projOk = await openAndSelect(triggers[0], project);
        if (!projOk) console.warn("  ⚠️ Project not found: " + project);
        modal = getModal(); // re-acquire after DOM changes
        if (!modal) return false;
        triggers = getDropdownTriggers(modal);
    }

    // 6. Fill title (this enables the Save button)
    var titleInput = modal.querySelector('input[placeholder="What did you work on? *"]');
    if (!titleInput) {
        console.error("  ❌ Title input not found.");
        return false;
    }
    reactSet(titleInput, title);
    await wait(400); // let React process + enable Save button

    // 7. Select Activity Type (trigger[1])
    if (triggers[1]) {
        var actOk = await openAndSelect(triggers[1], activity);
        if (!actOk) console.warn("  ⚠️ Activity not found: " + activity);
        modal = getModal();
        if (!modal) return false;
        triggers = getDropdownTriggers(modal);
    }

    // 8. Select Start Time (trigger[2])
    if (triggers[2]) {
        await openAndSelect(triggers[2], startLabel);
        modal = getModal();
        if (!modal) return false;
        triggers = getDropdownTriggers(modal);
    }

    // 9. Set Hours (input[type="number"][max="23"])
    var hoursInput = modal.querySelector('input[type="number"][max="23"]');
    if (hoursInput) {
        reactSet(hoursInput, String(hours));
        await wait(200);
    }

    // 10. Select Minutes (trigger[3])
    if (triggers[3]) {
        await openAndSelect(triggers[3], String(mins));
        modal = getModal();
        if (!modal) return false;
    }

    // 11. Description (optional — use Jira comment if available)
    if (task.comment && task.comment.trim()) {
        var descArea = modal.querySelector('textarea[placeholder="Description (optional)"]');
        if (descArea) {
            reactSet(descArea, task.comment.trim());
            await wait(200);
        }
    }

    // 12. Wait a moment for React to enable Save Entry
    await wait(500);

    // 13. Find and click Save Entry
    modal = getModal(); // always re-acquire before submit
    if (!modal) return false;

    var saveBtn = null;
    var btns = modal.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].innerText.trim().includes('Save Entry')) {
            saveBtn = btns[i];
            break;
        }
    }

    if (!saveBtn) {
        console.error("  ❌ Save Entry button not found.");
        return false;
    }

    if (saveBtn.disabled) {
        // Force-enable if still disabled after filling (React might not have updated yet)
        console.warn("  ⚠️ Save Entry still disabled — force enabling.");
        saveBtn.removeAttribute('disabled');
        await wait(200);
    }

    console.log("  🖱️ Clicking Save Entry…");
    saveBtn.click();
    await wait(300);
    return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// MODAL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * The Log Time modal is a div.rounded-xl.border inside div.absolute.z-30.
 * It is positioned WITHIN the day column (not a full-page overlay).
 */
function getModal() {
    // Primary: find by the unique title input placeholder
    var inp = document.querySelector('input[placeholder="What did you work on? *"]');
    if (!inp) return null;
    // Walk up to find the rounded-xl container
    var el = inp.parentElement;
    while (el) {
        if (el.classList.contains('rounded-xl')) return el;
        el = el.parentElement;
    }
    // Fallback: return the closest ancestor
    return inp.closest('.absolute') || inp.parentElement;
}

/**
 * Find a task-type button (Free Task / Board Task / OKR Task / Lunch) by exact text.
 */
function getTaskTypeButton(modal, text) {
    var btns = modal.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].innerText.trim() === text) return btns[i];
    }
    return null;
}

/**
 * Get the 4 custom dropdown trigger buttons in DOM order:
 * [0]=Project  [1]=ActivityType  [2]=StartTime  [3]=Minutes
 *
 * Identified by: button[type="button"] that has a child span.truncate
 * (distinguishes them from task-type buttons which have no span.truncate)
 */
function getDropdownTriggers(modal) {
    var results = [];
    var btns = modal.querySelectorAll('button[type="button"]');
    for (var i = 0; i < btns.length; i++) {
        if (btns[i].querySelector('span.truncate')) {
            results.push(btns[i]);
        }
    }
    return results;
}

/**
 * Simulate full mouse click sequence.
 */
function simulateClick(el) {
    if (!el) return;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    el.click();
}

/**
 * Open a custom dropdown and click the option matching value.
 * Strategy: snapshot ALL DOM elements before clicking trigger, then after,
 * look for any new element whose text matches the target value.
 * This works regardless of whether options are <button>, <div>, <li>, or <span>.
 */
async function openAndSelect(triggerBtn, value) {
    if (!triggerBtn) return false;
    var lv = value.toLowerCase().trim();

    // Snapshot every element with visible text
    var beforeSet = new Set(Array.from(document.querySelectorAll('*')));

    simulateClick(triggerBtn);

    // Wait up to 1.5s for the dropdown to animate and render
    for (var attempt = 0; attempt < 10; attempt++) {
        await wait(150);
        
        // --- Strategy 1: Scan ALL newly added elements ---
        var allAfter = Array.from(document.querySelectorAll('button, li, [role="option"], div, span'));
        for (var i = 0; i < allAfter.length; i++) {
            var el = allAfter[i];
            if (beforeSet.has(el)) continue; // existed before click
            // Only look at leaf-level or near-leaf elements (avoid huge containers)
            if (el.children.length > 3) continue;
            var txt = (el.innerText || el.textContent || '').trim();
            if (!txt || txt.length > 60) continue;
            if (txt.toLowerCase() === lv || (lv.length >= 3 && txt.toLowerCase().includes(lv))) {
                simulateClick(el);
                await wait(300);
                return true;
            }
        }

        // --- Strategy 2: Any element whose text exactly matches, newly visible ---
        var allVisible = document.querySelectorAll('button, li, [role="option"]');
        for (var j = 0; j < allVisible.length; j++) {
            var vtxt = (allVisible[j].innerText || '').trim();
            if (vtxt.toLowerCase() === lv || (lv.length >= 3 && vtxt.toLowerCase().includes(lv))) {
                // Skip the trigger button itself and task type buttons
                if (allVisible[j] === triggerBtn) continue;
                var cls = allVisible[j].className || '';
                if (cls.includes('bg-cyan-500')) continue; // active task-type button
                simulateClick(allVisible[j]);
                await wait(300);
                return true;
            }
        }
    }

    // Close the dropdown gracefully if not found
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(300);
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// CALENDAR SLOT CLICKING
// ══════════════════════════════════════════════════════════════════════════════

async function clickTimeSlot(dateStr, timeStr) {
    var parts = dateStr.split('-');
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var headerText = MONTHS[parseInt(parts[1])-1] + ' ' + parseInt(parts[2]);

    var col = findDayColumn(headerText);
    if (!col) {
        console.error("  ❌ Column not found for: " + headerText);
        return false;
    }

    var tp = timeStr.split(':');
    var h = parseInt(tp[0]), m = parseInt(tp[1]);
    var rm = m < 15 ? 0 : (m < 45 ? 30 : 0);
    var rh = m >= 45 ? h + 1 : h;
    if (rh >= 24) { rh = 23; rm = 30; }
    var slotTop = (rh * 60 + rm) / 30 * 28;

    console.log("  🖱️ Targeting " + headerText + " at " + pad(rh) + ":" + pad(rm) + " (grid top=" + slotTop + "px)");

    // STEP 1: Scroll the calendar so the target slot is in the viewport
    await scrollToSlot(col, slotTop);
    await wait(400);

    // STEP 2: Find the best clickable cell
    var cell = findBestCell(col, slotTop);
    if (!cell) {
        console.error("  ❌ No cell found near top=" + slotTop);
        return false;
    }

    // STEP 3: Try up to 3 click strategies, checking for modal after each

    // Strategy A: Simple direct click
    cell.click();
    await wait(1000);
    if (getModal()) return true;

    // Strategy B: Full mouse event sequence with real screen coordinates
    var rect = cell.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var evtOpts = {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy,
            screenX: cx + (window.screenX || 0),
            screenY: cy + (window.screenY || 0),
            button: 0, buttons: 1
        };
        cell.dispatchEvent(new MouseEvent('mouseover',  evtOpts));
        cell.dispatchEvent(new MouseEvent('mouseenter', evtOpts));
        cell.dispatchEvent(new MouseEvent('mousemove',  evtOpts));
        cell.dispatchEvent(new MouseEvent('mousedown',  evtOpts));
        cell.dispatchEvent(new MouseEvent('mouseup',    evtOpts));
        cell.dispatchEvent(new MouseEvent('click',      evtOpts));
        await wait(1000);
        if (getModal()) return true;
    }

    // Strategy C: Click the parent row div (React may have handler on outer element)
    var row = cell.parentElement;
    if (row) {
        row.click();
        await wait(800);
        if (getModal()) return true;

        var rowRect = row.getBoundingClientRect();
        if (rowRect.width > 0) {
            var rx = rowRect.left + 80; // skip the time label area (42px wide)
            var ry = rowRect.top + rowRect.height / 2;
            row.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, view: window,
                clientX: rx, clientY: ry, button: 0, buttons: 1
            }));
            await wait(800);
            if (getModal()) return true;
        }
    }

    console.error("  ❌ All click strategies failed for " + headerText);
    return false;
}

/**
 * Scroll the calendar's overflow-y-auto container so the slot at `topPx`
 * is visible in the viewport (not behind the sticky header).
 */
async function scrollToSlot(colEl, topPx) {
    // Walk up from the column to find the scrollable container
    var el = colEl.parentElement;
    while (el && el !== document.body) {
        var style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
            var HEADER_HEIGHT = 74; // sticky column header
            var PADDING = 80;       // show some context above the slot
            var target = Math.max(0, topPx - HEADER_HEIGHT - PADDING);
            el.scrollTop = target;
            return;
        }
        el = el.parentElement;
    }
}

/**
 * Find a day column by matching the date text ("May 25") in the sticky header.
 * Uses multiple strategies to be robust.
 */
function findDayColumn(headerText) {
    // Strategy 1: Find sticky header containing the date text
    var stickies = document.querySelectorAll('[class*="sticky"]');
    for (var i = 0; i < stickies.length; i++) {
        if ((stickies[i].innerText || '').includes(headerText)) {
            // Walk UP to find a column-level div (has a time grid child)
            var el = stickies[i];
            while (el && el !== document.body) {
                // The column div has a child with style="height: 1344px"
                if (el.querySelector('[style*="height: 1344px"]')) return el;
                el = el.parentElement;
            }
        }
    }
    // Strategy 2: Find any span/div with exactly "May 25" text
    var allEls = document.querySelectorAll('span, div');
    for (var j = 0; j < allEls.length; j++) {
        var txt = (allEls[j].innerText || allEls[j].textContent || '').trim();
        if (txt === headerText) {
            var el2 = allEls[j];
            while (el2 && el2 !== document.body) {
                if (el2.querySelector('[style*="height: 1344px"]')) return el2;
                el2 = el2.parentElement;
            }
        }
    }
    return null;
}

/**
 * Find the best clickable cell near `topPx` within a day column.
 * Iterates the 1344px grid's direct children (the absolute 30-min rows).
 */
function findBestCell(colEl, topPx) {
    // Find the 1344px time grid container
    var grid = colEl.querySelector('[style*="height: 1344px"]');
    if (!grid) {
        console.warn("  ⚠️ 1344px grid not found inside column");
        return null;
    }

    var bestRow = null;
    var bestDist = 999;

    // Walk direct children of the grid
    for (var i = 0; i < grid.children.length; i++) {
        var child = grid.children[i];
        var styleHeight = parseInt(child.style.height) || 0;
        var styleTop    = parseFloat(child.style.top);
        if (styleHeight !== 28 || isNaN(styleTop)) continue;

        var dist = Math.abs(styleTop - topPx);
        if (dist < bestDist) {
            bestDist = dist;
            bestRow = child;
        }
    }

    if (!bestRow || bestDist > 56) {
        console.warn("  ⚠️ No row found within 56px of top=" + topPx + " (best dist=" + bestDist + ")");
        return null;
    }

    // Inside the row: first child is the time label (w-[42px]), second is the clickable cell
    var children = bestRow.children;
    for (var k = 0; k < children.length; k++) {
        var cls = children[k].className || '';
        if (cls.includes('flex-1') || cls.includes('cursor-pointer')) {
            return children[k];
        }
    }
    // Fallback: return the row itself
    return bestRow;
}

// ══════════════════════════════════════════════════════════════════════════════
// REACT INPUT HELPER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Set value on a React-controlled input/textarea.
 * React uses its own internal value tracker, so we must use the native
 * property setter to trigger React's onChange synthetic event.
 */
function reactSet(element, value) {
    element.focus();
    var lastValue = element.value;

    var tag = element.tagName.toUpperCase();
    var proto = tag === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) {
        setter.set.call(element, value);
    } else {
        element.value = value;
    }
    
    // React 16+ needs the tracker to be reset so it notices the native value change
    var tracker = element._valueTracker;
    if (tracker) {
        tracker.setValue(lastValue);
    }

    var inputEv = new Event('input', { bubbles: true, cancelable: true });
    inputEv.simulated = true;
    element.dispatchEvent(inputEv);
    
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
    element.blur();
}

// ══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ══════════════════════════════════════════════════════════════════════════════

function buildTitle(task) {
    var key  = (task.issueKey || "").trim();
    var summ = (task.summary  || "Development work").replace(/^Re:\s*/i, "").trim();
    return key ? key + ": " + summ : summ;
}

/**
 * Map SmartMapper category → TalentFlow activity options:
 * Development | Testing | Meeting | Design | Code Review | Other
 */
function mapActivity(category) {
    var c = (category || "").toLowerCase();
    if (c.includes("meeting") || c.includes("interview") || c.includes("call") || c.includes("sync") || c.includes("demo")) return "Meeting";
    if (c.includes("code review") || c.includes("review")) return "Code Review";
    if (c.includes("test")) return "Testing";
    if (c.includes("design")) return "Design";
    return "Development";
}

/**
 * Round a "HH:MM" string to the nearest :00 or :30 boundary.
 * Used for clicking time slots AND for the Start Time dropdown.
 */
function roundToHalfHour(timeStr) {
    var p = timeStr.split(':');
    var h = parseInt(p[0]);
    var m = parseInt(p[1]);
    var rm = m < 15 ? 0 : (m < 45 ? 30 : 0);
    var rh = m >= 45 ? h + 1 : h;
    if (rh >= 24) rh = 23;
    return pad(rh) + ':' + pad(rm);
}

/**
 * Check if this exact task is already on the calendar.
 * Compares against expected occurrences to allow legitimate duplicates
 * (e.g., two 1h "standup" tasks on the same day).
 */
function isDuplicateTask(dateStr, task, allTasksForDay, currentTaskIndex) {
    var p = dateStr.split('-');
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var headerText = MONTHS[parseInt(p[1])-1] + ' ' + parseInt(p[2]);
    var col = findDayColumn(headerText);
    if (!col) return false;

    var cards = col.querySelectorAll('[class*="rounded-md"]');
    var key  = (task.issueKey || "").toLowerCase();
    var summ = (task.summary  || "").substring(0, 15).toLowerCase();

    // Count how many times THIS exact task appears in Tempo up to now
    var expectedMatches = 1;
    for (var i = 0; i < currentTaskIndex; i++) {
        var t = allTasksForDay[i];
        var k2 = (t.issueKey || "").toLowerCase();
        var s2 = (t.summary || "").substring(0, 15).toLowerCase();
        if ((key && key.length > 2 && k2 === key) || (summ && summ.length > 5 && s2 === summ)) {
            expectedMatches++;
        }
    }

    // Count how many times it already exists on the calendar
    var foundMatches = 0;
    for (var j = 0; j < cards.length; j++) {
        var txt = (cards[j].innerText || "").toLowerCase();
        if (key && key.length > 2 && txt.includes(key)) {
            foundMatches++;
        } else if (summ && summ.length > 5 && txt.includes(summ)) {
            foundMatches++;
        }
    }

    return foundMatches >= expectedMatches;
}

async function closeModalIfOpen() {
    var modal = getModal();
    if (!modal) return;
    // Find Cancel button or X close button
    var btns = modal.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
        var t = btns[i].innerText.trim();
        if (t === 'Cancel') { btns[i].click(); await wait(500); return; }
    }
    // Fallback: Escape key
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(400);
}

async function waitForModalGone() {
    await waitForElement(function () {
        return getModal() ? null : true; // resolve when modal disappears
    }, 8000);
    await wait(300);
}

// ── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg, isError) {
    var old = document.getElementById('tf-toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.id = 'tf-toast';
    t.style.cssText = [
        "position:fixed", "bottom:24px", "right:24px", "z-index:2147483647",
        "background:" + (isError ? "#7f1d1d" : "#0f172a"),
        "color:#fff", "padding:11px 18px", "border-radius:10px",
        "font:500 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        "box-shadow:0 8px 30px rgba(0,0,0,0.45)", "max-width:320px",
        "transition:opacity .3s ease"
    ].join(';');
    t.innerText = msg;
    document.body.appendChild(t);
    setTimeout(function () {
        t.style.opacity = '0';
        setTimeout(function () { if (t.parentNode) t.remove(); }, 350);
    }, 4500);
}

// ── Async primitives ─────────────────────────────────────────────────────────

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function waitForElement(fn, timeout) {
    var end = Date.now() + (timeout || 5000);
    while (Date.now() < end) {
        var el = fn();
        if (el) return el;
        await wait(150);
    }
    return null;
}
