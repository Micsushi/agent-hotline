import assert from "node:assert/strict";
import test from "node:test";

import {
  canUserChoose,
  describeActionHint,
  getNextPendingItem,
  normalizeReadBehavior,
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
