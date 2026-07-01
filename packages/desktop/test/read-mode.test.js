import assert from "node:assert/strict";
import test from "node:test";

import {
  canUserChoose,
  describeQueueArrivalNotice,
  describeActionHint,
  getStartupAutoReadAttemptIds,
  getNextPendingItem,
  normalizeReadBehavior,
  selectItemIdForQueueUpdate,
  shouldAutoReadPending
} from "../src/read-mode.js";

test("read mode normalizes invalid settings to manual behavior", () => {
  assert.equal(normalizeReadBehavior("auto"), "auto");
  assert.equal(normalizeReadBehavior("ask_every_time"), "manual");
  assert.equal(normalizeReadBehavior("surprise_me"), "manual");
  assert.equal(normalizeReadBehavior(undefined), "manual");
});

test("save-only mode exposes a user choice for pending items", () => {
  const queue = { pending: [{ id: "next-1", speakableText: "Ready to read." }] };

  assert.deepEqual(getNextPendingItem(queue), queue.pending[0]);
  assert.equal(canUserChoose({ readBehavior: "manual", mute: false }, queue), true);
  assert.equal(canUserChoose({ readBehavior: "ask_every_time", mute: false }, queue), true);
  assert.equal(canUserChoose({ readBehavior: "auto", mute: false }, queue), false);
  assert.equal(canUserChoose({ readBehavior: "manual", mute: true }, queue), false);
  assert.equal(canUserChoose({ readBehavior: "manual", mute: false }, { pending: [] }), false);
});

test("auto mode starts only for the next unattempted pending item", () => {
  const queue = { pending: [{ id: "item-1" }], current: null };

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue,
      playbackActive: false,
      attemptedItemIds: new Set()
    }),
    true
  );

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue,
      playbackActive: false,
      attemptedItemIds: new Set(["item-1"])
    }),
    false
  );

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: true },
      queue,
      playbackActive: false,
      attemptedItemIds: new Set()
    }),
    false
  );

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue: { ...queue, current: { id: "playing" } },
      playbackActive: false,
      attemptedItemIds: new Set()
    }),
    false
  );

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue,
      playbackActive: true,
      attemptedItemIds: new Set()
    }),
    false
  );
});

test("auto mode still starts the next eligible item while playback is idle", () => {
  const queue = {
    pending: [
      {
        id: "idle-next",
        projectKey: "project-a",
        sessionKey: "session-a"
      }
    ],
    current: null
  };

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue,
      playbackActive: false,
      attemptedItemIds: new Set()
    }),
    true
  );
});

test("startup auto-read seed includes existing pending and current items", () => {
  const queue = {
    pending: [{ id: "old-pending" }, { id: "another-old-pending" }, { id: "" }, {}],
    current: { id: "stale-playing" }
  };

  assert.deepEqual(getStartupAutoReadAttemptIds(queue), [
    "old-pending",
    "another-old-pending",
    "stale-playing"
  ]);
});

test("seeded startup pending items do not auto-read, but later items can", () => {
  const attempted = new Set(getStartupAutoReadAttemptIds({ pending: [{ id: "old" }] }));

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue: { pending: [{ id: "old" }], current: null },
      playbackActive: false,
      attemptedItemIds: attempted
    }),
    false
  );

  assert.equal(
    shouldAutoReadPending({
      settings: { readBehavior: "auto", mute: false },
      queue: { pending: [{ id: "new" }], current: null },
      playbackActive: false,
      attemptedItemIds: attempted
    }),
    true
  );
});

test("active playback selects a newly arrived item from another session", () => {
  const activeItem = {
    id: "playing",
    projectKey: "project-a",
    sessionKey: "session-a",
    sourceApp: "Codex"
  };
  const latestItem = {
    id: "new-other",
    projectKey: "project-b",
    sessionKey: "session-b",
    sourceApp: "Claude"
  };

  assert.equal(
    selectItemIdForQueueUpdate({
      currentSelectedId: activeItem.id,
      latestItem,
      activeItem,
      playbackActive: true
    }),
    latestItem.id
  );
});

test("active playback selects a newly arrived item from the same session", () => {
  const activeItem = {
    id: "playing",
    projectKey: "project-a",
    sessionKey: "session-a",
    sourceApp: "Codex"
  };
  const latestItem = {
    id: "new-same",
    projectKey: "project-a",
    sessionKey: "session-a",
    sourceApp: "Codex"
  };

  assert.equal(
    selectItemIdForQueueUpdate({
      currentSelectedId: activeItem.id,
      latestItem,
      activeItem,
      playbackActive: true
    }),
    latestItem.id
  );
});

test("idle playback selects a newly arrived item", () => {
  assert.equal(
    selectItemIdForQueueUpdate({
      currentSelectedId: "old",
      latestItem: { id: "new-id" },
      activeItem: null,
      playbackActive: false
    }),
    "new-id"
  );
});

test("arrival notices show only for other-session items without repeats", () => {
  const activeItem = {
    id: "playing",
    projectKey: "project-a",
    projectName: "agent-hotline",
    sessionKey: "session-a",
    sessionName: "Task 4",
    sourceApp: "Codex"
  };
  const otherItem = {
    id: "other",
    projectKey: "project-b",
    projectName: "side-project",
    sessionKey: "session-b",
    sessionName: "Review",
    sourceApp: "Claude"
  };
  const sameItem = {
    id: "same",
    projectKey: "project-a",
    projectName: "agent-hotline",
    sessionKey: "session-a",
    sessionName: "Task 4",
    sourceApp: "Codex"
  };

  assert.deepEqual(
    describeQueueArrivalNotice({
      item: otherItem,
      activeItem,
      playbackActive: true,
      noticedItemIds: new Set()
    }),
    {
      itemId: "other",
      kind: "other-session",
      prominence: "high",
      source: "Claude",
      project: "side-project",
      session: "Review"
    }
  );

  assert.equal(
    describeQueueArrivalNotice({
      item: sameItem,
      activeItem,
      playbackActive: true,
      noticedItemIds: new Set()
    }),
    null
  );

  assert.equal(
    describeQueueArrivalNotice({
      item: otherItem,
      activeItem,
      playbackActive: true,
      noticedItemIds: new Set(["other"])
    }),
    null
  );
});

test("action hints reflect mute, empty queue, and read behavior decisions", () => {
  const queue = { pending: [{ id: "item-1" }] };

  assert.match(describeActionHint({ mute: true, readBehavior: "auto" }, queue), /Muted/);
  assert.match(describeActionHint({ mute: false, readBehavior: "auto" }, queue), /Auto-play/);
  assert.match(describeActionHint({ mute: false, readBehavior: "manual" }, queue), /Save only/);
  assert.match(
    describeActionHint({ mute: false, readBehavior: "manual" }, { pending: [] }),
    /No pending item/
  );
});
