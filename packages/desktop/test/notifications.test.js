import test from "node:test";
import assert from "node:assert/strict";
import { buildNotificationEntries, latestUnreadItemId } from "../src/notifications.js";

function item(id, createdAt, extra = {}) {
  return {
    id,
    sourceApp: extra.sourceApp || "Codex",
    projectKey: extra.projectKey || "project-a",
    projectName: extra.projectName || "agent-hotline",
    sessionKey: extra.sessionKey || "session-a",
    sessionName: extra.sessionName || "Task",
    speakableText: extra.speakableText || `Message ${id}`,
    timestamps: { createdAt }
  };
}

test("notification entries are ordered by arrival time", () => {
  const entries = buildNotificationEntries([
    item("new", "2026-06-30T10:02:00.000Z"),
    item("old", "2026-06-30T10:00:00.000Z"),
    item("middle", "2026-06-30T10:01:00.000Z")
  ]);

  assert.deepEqual(
    entries.map((entry) => entry.id),
    ["old", "middle", "new"]
  );
});

test("notification entries include unread and display metadata", () => {
  const entries = buildNotificationEntries(
    [
      item("a", "2026-06-30T10:00:00.000Z", {
        sourceApp: "Claude",
        projectName: "side-project",
        sessionName: "Review",
        speakableText: "Line one\n\nLine two"
      })
    ],
    { isUnread: (entry) => entry.id === "a" }
  );

  assert.equal(entries[0].unread, true);
  assert.equal(entries[0].source, "Claude");
  assert.equal(entries[0].project, "side-project");
  assert.equal(entries[0].session, "Review");
  assert.equal(entries[0].preview, "Line one Line two");
});

test("latest unread item picks newest requested unread arrival", () => {
  const items = [
    item("old", "2026-06-30T10:00:00.000Z"),
    item("new", "2026-06-30T10:05:00.000Z"),
    item("ignored", "2026-06-30T10:06:00.000Z")
  ];

  assert.equal(latestUnreadItemId(items, { unreadIds: new Set(["old", "new"]) }), "new");
  assert.equal(latestUnreadItemId(items, { unreadIds: new Set() }), null);
});
