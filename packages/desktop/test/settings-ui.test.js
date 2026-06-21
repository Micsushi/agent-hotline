import assert from "node:assert/strict";
import test from "node:test";

import { formatSettingsError } from "../src/settings-ui.js";

test("settings formatter includes structured validation details", () => {
  const message = formatSettingsError(
    {
      error: {
        code: "invalid_settings",
        message: "Settings update is invalid",
        details: ["rate must be a number from 0.1 to 10", "skipRules.tables must be boolean"]
      }
    },
    400
  );

  assert.equal(
    message,
    "Settings update is invalid rate must be a number from 0.1 to 10 skipRules.tables must be boolean"
  );
});

test("settings formatter falls back to string errors and HTTP status", () => {
  assert.equal(formatSettingsError({ error: "Backend unavailable" }, 503), "Backend unavailable");
  assert.equal(formatSettingsError({}, 418), "HTTP 418");
});
