import { projectLabelOf, sessionLabelOf } from "./grouping.js";

function createdAtOf(item) {
  return item?.timestamps?.createdAt || "";
}

export function buildNotificationEntries(items, { isUnread = () => false } = {}) {
  return [...items]
    .sort((a, b) => createdAtOf(a).localeCompare(createdAtOf(b)))
    .map((item) => ({
      id: item.id,
      item,
      unread: isUnread(item),
      source: item.sourceApp || "Unknown",
      project: projectLabelOf(item),
      session: sessionLabelOf(item),
      createdAt: createdAtOf(item),
      preview: String(item.speakableText || "")
        .replace(/\s+/g, " ")
        .trim()
    }));
}

export function latestUnreadItemId(items, { unreadIds } = {}) {
  const wanted = unreadIds instanceof Set ? unreadIds : null;
  const unread = [...items]
    .filter((item) => item?.id && (!wanted || wanted.has(item.id)))
    .sort((a, b) => createdAtOf(b).localeCompare(createdAtOf(a)));
  return unread[0]?.id || null;
}
