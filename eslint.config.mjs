import js from "@eslint/js";
import globals from "globals";

const commonRules = {
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }]
};

export default [
  {
    ignores: [
      "node_modules/**",
      "packages/desktop/dist/**",
      "packages/desktop/public/config.json",
      "packages/desktop/src-tauri/gen/**",
      "packages/desktop/src-tauri/target/**"
    ]
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: commonRules
  },
  {
    files: ["packages/backend/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: globals.node
    }
  }
];
