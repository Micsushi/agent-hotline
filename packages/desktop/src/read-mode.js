const READ_BEHAVIORS = new Set(["manual", "auto"]);

export function normalizeReadBehavior(value) {
  return READ_BEHAVIORS.has(value) ? value : "manual";
}

export function getNextPendingItem(queue) {
  return Array.isArray(queue?.pending) && queue.pending.length > 0 ? queue.pending[0] : null;
}

export function canUserChoose(settings, queue) {
  const mode = normalizeReadBehavior(settings?.readBehavior);
  return Boolean(getNextPendingItem(queue) && !settings?.mute && mode === "manual");
}

export function shouldAutoReadPending({ settings, queue, playbackActive, attemptedItemIds }) {
  const item = getNextPendingItem(queue);
  if (!item) return false;
  if (normalizeReadBehavior(settings?.readBehavior) !== "auto") return false;
  if (settings?.mute || playbackActive || queue?.current) return false;
  return !attemptedItemIds?.has(item.id);
}

export function describeActionHint(settings, queue) {
  const mode = normalizeReadBehavior(settings?.readBehavior);
  const item = getNextPendingItem(queue);

  if (settings?.mute) {
    return "Muted. The speakable preview stays visible for typed/visual fallback.";
  }

  if (!item) {
    return "No pending item needs a choice.";
  }

  if (mode === "auto") {
    return "Auto-play is on. New replies read aloud when playback is idle.";
  }

  return "Save only is on. New replies wait in the queue until you press Read.";
}
