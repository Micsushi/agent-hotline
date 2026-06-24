const fs = require("fs");
const path = require("path");

const { defaultDataDir } = require("./speech-queue-store");

function defaultSpoolFile() {
  return path.join(defaultDataDir(), "spool.json");
}

function readItems(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function writeItems(filePath, items) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify({ items }, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

function createSpoolStore(options = {}) {
  const filePath = options.filePath || path.join(options.dataDir || defaultDataDir(), "spool.json");
  const now = options.now || (() => new Date().toISOString());

  return {
    filePath,
    read() {
      return readItems(filePath);
    },
    append(item) {
      const items = readItems(filePath);
      items.push({
        rawSource: item.rawSource,
        speakableText: item.speakableText,
        sourceApp: item.sourceApp,
        threadId: item.threadId,
        threadLabel: item.threadLabel,
        sessionName: item.sessionName,
        spooledAt: now()
      });
      writeItems(filePath, items);
      return items.length;
    },
    clear() {
      writeItems(filePath, []);
    },
    drain(enqueue) {
      const items = readItems(filePath);
      if (items.length === 0) return { flushed: 0, remaining: 0 };

      let flushed = 0;
      for (const item of items) {
        try {
          enqueue({
            rawSource: item.rawSource,
            speakableText: item.speakableText,
            sourceApp: item.sourceApp,
            threadId: item.threadId,
            threadLabel: item.threadLabel,
            sessionName: item.sessionName
          });
          flushed += 1;
        } catch {
          break;
        }
      }

      const remaining = items.slice(flushed);
      writeItems(filePath, remaining);
      return { flushed, remaining: remaining.length };
    }
  };
}

module.exports = { createSpoolStore, defaultSpoolFile };
