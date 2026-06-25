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

// Collapse a filesystem path to a stable identity. Windows hooks have shipped the
// cwd in inconsistent shapes (mixed slash style, and some with separators stripped
// entirely, e.g. "C:Users..."), so two records for the same folder could key apart
// and split one project into duplicates. Stripping all separators + lowercasing
// makes "C:\\Users\\me\\proj", "c:/users/me/proj" and "C:Usersmeproj" all collapse
// to one key. Must stay byte-identical to projectKeyForItem() in the backend so
// Storage delete-by-project still matches.
export function canonicalProjectKey(projectPath) {
  return String(projectPath).replace(/[\\/]/g, "").toLowerCase();
}

export function projectKeyOf(rec) {
  if (rec.projectKey) return rec.projectKey;
  if (rec.projectPath) return canonicalProjectKey(rec.projectPath);
  return `direct:${rec.sourceApp}`;
}

// The label MUST branch on the same condition as projectKeyOf(): a record is a
// real project only when it carries a project identity (projectKey or
// projectPath). A "direct" record (neither) is keyed as `direct:<sourceApp>`, so
// it must label as the harness too -- it must never borrow projectName, or it
// spawns a phantom project box that mirrors a real same-named project. Key and
// label can never disagree because they read the same flag here.
// With a real project, the folder name is the label. projectName is normally the
// basename already, but guard against records that leaked a full path into it
// (some hooks have): take the last path segment so the label is always the folder
// name, never "C:\\Users\\...".
export function projectLabelOf(rec) {
  if (!rec.projectKey && !rec.projectPath) {
    return rec.sourceApp || "Direct";
  }
  const raw = rec.projectName || rec.projectPath || "";
  const base = String(raw)
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return base || rec.sourceApp || "Direct";
}

export function sessionKeyOf(rec) {
  return rec.sessionKey || rec.threadId || `app:${rec.sourceApp}`;
}

export function sessionPartsOf(rec) {
  const hasThread = Boolean(rec.threadId);
  const id = hasThread ? rec.threadId.slice(0, 8) : "direct";
  const title = rec.sessionName || (hasThread ? "" : rec.sourceApp || "Direct");
  return { title, id };
}

// A session is shown as its chat name followed by the short thread id, so two
// chats with the same name stay distinguishable.
export function sessionLabelOf(rec) {
  const id = rec.threadId ? rec.threadId.slice(0, 8) : "";
  const title = rec.sessionName || "";
  if (title && id) return `${title} · ${id}`;
  if (title) return title;
  if (id) return id;
  return `${rec.sourceApp} · direct`;
}

export function latestCreatedAt(items) {
  return items[items.length - 1]?.timestamps?.createdAt || "";
}

// Which harness owns a group of records. One harness -> that harness; more than
// one -> "Mixed". Used to badge projects/sessions/messages with their owner.
export function ownerOf(records) {
  let owner = null;
  for (const rec of records) {
    if (!rec.sourceApp) continue;
    if (owner === null) owner = rec.sourceApp;
    else if (owner !== rec.sourceApp) return "Mixed";
  }
  return owner || "Unknown";
}

// A session is "unnamed" when it is a real thread (has a threadId) but no record
// ever carried a human name, so its label would be nothing but the raw id.
// Direct sessions (no threadId) keep their "Harness · direct" label.
function isUnnamedSession(records) {
  const named = records.some((rec) => rec.sessionName);
  const hasThread = records.some((rec) => rec.threadId);
  return hasThread && !named;
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
export function groupByProjectSession(records, { sortBy = "recent", dropUnnamed = false } = {}) {
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
      project.sessions.set(sessionKey, {
        key: sessionKey,
        label: sessionLabelOf(rec),
        parts: sessionPartsOf(rec),
        items: []
      });
    }
    const session = project.sessions.get(sessionKey);
    session.label = sessionLabelOf(rec);
    session.parts = sessionPartsOf(rec);
    session.items.push(rec);
  }

  return [...projects.values()]
    .map((project) => {
      let sessions = [...project.sessions.values()];
      if (dropUnnamed) sessions = sessions.filter((session) => !isUnnamedSession(session.items));
      return {
        ...project,
        owner: ownerOf(project.items),
        bytes: sumBytes(project.items),
        sessions: sessions
          .map((session) => ({
            ...session,
            owner: ownerOf(session.items),
            bytes: sumBytes(session.items)
          }))
          .sort(sorter)
      };
    })
    .filter((project) => project.sessions.length > 0)
    .sort(sorter);
}
