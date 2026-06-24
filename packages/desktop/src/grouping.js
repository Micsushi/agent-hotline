// Shared Project -> Session grouping for both the History list (spoken queue
// items) and the Storage tab (saved audio cache entries). Keeping one builder
// means the two trees always group and label the same way; change it here and
// both views move together.
//
// Records only need a few loosely-typed fields:
//   projectKey?  projectPath?  projectName?  sourceApp
//   sessionKey?  threadId?     sessionName?
//   timestamps.createdAt?  (for "recent" sort)
//   bytes?                 (for "bytes" sort / size meta)

export function projectKeyOf(rec) {
  return rec.projectKey || rec.projectPath || `direct:${rec.sourceApp}`;
}

// With a real project, the folder name is the label. Without one, fall back to
// the harness we were talking to (Codex / Claude).
export function projectLabelOf(rec) {
  return rec.projectName || rec.sourceApp || "Direct";
}

export function sessionKeyOf(rec) {
  return rec.sessionKey || rec.threadId || `app:${rec.sourceApp}`;
}

// A session is shown as its chat name followed by the short thread id, so two
// chats with the same name stay distinguishable.
export function sessionLabelOf(rec) {
  const id = rec.threadId ? rec.threadId.slice(0, 8) : "";
  const name = rec.sessionName || "";
  if (name && id) return `${name} · ${id}`;
  if (name) return name;
  if (id) return id;
  return `${rec.sourceApp} · direct`;
}

export function latestCreatedAt(items) {
  return items[items.length - 1]?.timestamps?.createdAt || "";
}

function sumBytes(items) {
  let total = 0;
  for (const item of items) total += Number(item.bytes) || 0;
  return total;
}

const SORTERS = {
  recent: (a, b) => latestCreatedAt(b.items).localeCompare(latestCreatedAt(a.items)),
  bytes: (a, b) => b.bytes - a.bytes
};

// Group flat records into Project -> Session -> items. Newest-first by default
// (History); pass { sortBy: "bytes" } for the largest-first Storage view.
export function groupByProjectSession(records, { sortBy = "recent" } = {}) {
  const sorter = SORTERS[sortBy] || SORTERS.recent;
  const projects = new Map();

  for (const rec of records) {
    const projectKey = projectKeyOf(rec);
    if (!projects.has(projectKey)) {
      projects.set(projectKey, {
        key: projectKey,
        label: projectLabelOf(rec),
        direct: !rec.projectPath,
        sessions: new Map(),
        items: []
      });
    }
    const project = projects.get(projectKey);
    project.label = projectLabelOf(rec);
    project.items.push(rec);

    const sessionKey = sessionKeyOf(rec);
    if (!project.sessions.has(sessionKey)) {
      project.sessions.set(sessionKey, { key: sessionKey, label: sessionLabelOf(rec), items: [] });
    }
    const session = project.sessions.get(sessionKey);
    session.label = sessionLabelOf(rec);
    session.items.push(rec);
  }

  return [...projects.values()]
    .map((project) => ({
      ...project,
      bytes: sumBytes(project.items),
      sessions: [...project.sessions.values()]
        .map((session) => ({ ...session, bytes: sumBytes(session.items) }))
        .sort(sorter)
    }))
    .sort(sorter);
}
