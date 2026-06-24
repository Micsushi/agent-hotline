import assert from "node:assert/strict";
import test from "node:test";

import {
  groupByProjectSession,
  projectKeyOf,
  projectLabelOf,
  sessionKeyOf,
  sessionLabelOf
} from "../src/grouping.js";

function item(overrides) {
  return {
    sourceApp: "Claude",
    timestamps: { createdAt: "2026-06-01T00:00:00.000Z" },
    ...overrides
  };
}

test("labels and keys fall back through project/session fields", () => {
  assert.equal(projectKeyOf({ projectKey: "k" }), "k");
  assert.equal(projectKeyOf({ projectPath: "/p", sourceApp: "Claude" }), "/p");
  assert.equal(projectKeyOf({ sourceApp: "Codex" }), "direct:Codex");

  assert.equal(projectLabelOf({ projectName: "agent-hotline" }), "agent-hotline");
  assert.equal(projectLabelOf({ sourceApp: "Codex" }), "Codex");

  assert.equal(sessionKeyOf({ sessionKey: "s" }), "s");
  assert.equal(sessionKeyOf({ threadId: "abc123", sourceApp: "Claude" }), "abc123");
  assert.equal(sessionKeyOf({ sourceApp: "Claude" }), "app:Claude");

  assert.equal(
    sessionLabelOf({ sessionName: "Fix bug", threadId: "abcdef0123" }),
    "Fix bug · abcdef01"
  );
  assert.equal(sessionLabelOf({ threadId: "abcdef0123" }), "abcdef01");
  assert.equal(sessionLabelOf({ sourceApp: "Claude" }), "Claude · direct");
});

test("recent sort groups project -> session newest first", () => {
  const items = [
    item({
      projectName: "old",
      projectPath: "/old",
      threadId: "t1",
      timestamps: { createdAt: "2026-06-01T00:00:00.000Z" }
    }),
    item({
      projectName: "new",
      projectPath: "/new",
      threadId: "t2",
      timestamps: { createdAt: "2026-06-03T00:00:00.000Z" }
    }),
    item({
      projectName: "new",
      projectPath: "/new",
      threadId: "t2",
      timestamps: { createdAt: "2026-06-04T00:00:00.000Z" }
    })
  ];

  const groups = groupByProjectSession(items, { sortBy: "recent" });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, "new");
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[0].sessions.length, 1);
  assert.equal(groups[1].label, "old");
});

test("bytes sort orders largest first and sums project/session bytes", () => {
  const entries = [
    {
      sourceApp: "Claude",
      projectKey: "P",
      projectPath: "/P",
      projectName: "P",
      sessionKey: "s1",
      bytes: 100
    },
    {
      sourceApp: "Claude",
      projectKey: "P",
      projectPath: "/P",
      projectName: "P",
      sessionKey: "s1",
      bytes: 50
    },
    {
      sourceApp: "Codex",
      projectKey: "Q",
      projectPath: "/Q",
      projectName: "Q",
      sessionKey: "s2",
      bytes: 400
    }
  ];

  const groups = groupByProjectSession(entries, { sortBy: "bytes" });
  assert.equal(groups[0].label, "Q");
  assert.equal(groups[0].bytes, 400);
  assert.equal(groups[1].label, "P");
  assert.equal(groups[1].bytes, 150);
  assert.equal(groups[1].sessions[0].bytes, 150);
  assert.equal(groups[1].sessions[0].items.length, 2);
});

test("direct flag is set when no project path is present", () => {
  const [group] = groupByProjectSession([item({ sourceApp: "Codex" })]);
  assert.equal(group.direct, true);
  assert.equal(group.label, "Codex");
});
