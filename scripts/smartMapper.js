/**
 * smartMapper.js
 * V2: Handles time allocation and category guessing.
 * Cross-browser compatible.
 */

var SmartMapper = {
  config: {
    startTime: "09:00",
    defaultCategory: "Development",
    taskDurationGap: 0,
    excludeWeekend: true,
    minDurationMinutes: 15, // Minimum task duration to avoid zero-length entries
    slotMinutes: 30         // Calendar grid resolution; durations snap up to this
  },

  /**
   * Round a duration UP to the next slot boundary (30 min).
   * This prevents time-slot collisions: when tasks are laid back-to-back,
   * snapping every duration to a multiple of 30 keeps each consecutive start
   * on a distinct 30-min grid slot, so a later task never clicks onto the
   * card of an earlier one. e.g. 15m -> 30m, 45m -> 1h, 1h15m -> 1h30m.
   * @param {number} mins
   * @returns {number} minutes rounded up to a multiple of slotMinutes
   */
  roundUpToSlot: function (mins) {
    var slot = SmartMapper.config.slotMinutes || 30;
    if (!mins || mins < slot) return slot; // also enforces a sane minimum
    return Math.ceil(mins / slot) * slot;
  },

  /**
   * Parse duration string to minutes
   * @param {string} durationStr - e.g. "1h 30m", "45m", "2h"
   * @returns {number} minutes
   */
  parseDuration: function (durationStr) {
    if (!durationStr) return 0;

    var totalMinutes = 0;
    var hoursMatch = durationStr.match(/(\d+(?:\.\d+)?)h/);
    var minutesMatch = durationStr.match(/(\d+)m/);

    if (hoursMatch) totalMinutes += parseFloat(hoursMatch[1]) * 60;
    if (minutesMatch) totalMinutes += parseInt(minutesMatch[1], 10);

    return Math.round(totalMinutes);
  },

  /**
   * Add minutes to a time string (HH:MM)
   * @param {string} timeStr - "09:00"
   * @param {number} minutesToAdd
   * @returns {string} New time "HH:MM"
   */
  addMinutes: function (timeStr, minutesToAdd) {
    var parts = timeStr.split(':');
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    var totalMins = h * 60 + m + minutesToAdd;

    // Clamp to 24-hour range (0 to 1439 minutes)
    if (totalMins < 0) totalMins = 0;
    if (totalMins >= 1440) totalMins = 1439;

    var newH = Math.floor(totalMins / 60);
    var newM = totalMins % 60;
    return String(newH).padStart(2, '0') + ':' + String(newM).padStart(2, '0');
  },

  normalizeTimeString: function (timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return "";
    var parts = timeStr.split(':');
    if (parts.length < 2) return "";
    var h = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m)) return "";
    if (h < 0) h = 0;
    if (h > 23) h = 23;
    if (m < 0) m = 0;
    if (m > 59) m = 59;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  },

  /**
   * Process a list of raw tasks for a single day to add start/end times
   * @param {Array} tasks - Array of task objects { summary, duration, ... }
   * @returns {Array} tasks with startTime and endTime added
   */
  processDay: function (tasks) {
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) return [];

    var currentTime = SmartMapper.normalizeTimeString(SmartMapper.config.startTime) || "09:00";

    return tasks.map(function (task) {
      var rawMins = SmartMapper.parseDuration(task.duration);

      // Snap duration up to the 30-min grid (15m -> 30m, 45m -> 1h). This both
      // enforces a sane minimum AND keeps back-to-back tasks on distinct grid
      // slots so they don't collide when clicked onto the calendar.
      var durationMins = SmartMapper.roundUpToSlot(rawMins);
      var requestedStart = SmartMapper.normalizeTimeString(task.startTime);
      var startTime = requestedStart || currentTime;
      var endTime = SmartMapper.addMinutes(startTime, durationMins);

      // Add gap between tasks when the task is laid out sequentially.
      currentTime = SmartMapper.addMinutes(endTime, SmartMapper.config.taskDurationGap);

      return {
        date: task.date || "",
        issueKey: task.issueKey || "",
        summary: task.summary || "",
        duration: task.duration || "",
        comment: task.comment || "",
        category: SmartMapper.guessCategory(task.summary || ""),
        originalId: task.originalId || "",
        startTime: startTime,
        endTime: endTime,
        durationMinutes: durationMins
      };
    });
  },

  /**
   * Guess category based on keywords
   * @param {string} summary
   * @returns {string} Category
   */
  guessCategory: function (summary) {
    var s = summary.toLowerCase();
    if (s.includes("standup") || s.includes("meet") || s.includes("sync") || s.includes("call") || s.includes("dsm") || s.includes("demo") || s.includes("interview")) {
      return "Meeting";
    }
    return SmartMapper.config.defaultCategory;
  }
};

// Export for testing or Node.js usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmartMapper;
}
