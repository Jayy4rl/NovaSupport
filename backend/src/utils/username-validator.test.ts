import assert from "node:assert/strict";
import test from "node:test";
import { generateSuggestions } from "./username-validator.js";

test("generated username suggestions stay within the 32-character limit", () => {
  const suggestions = generateSuggestions("a".repeat(32));
  assert.ok(suggestions.length > 0);
  assert.ok(
    suggestions.every((suggestion) => suggestion.length <= 32),
    suggestions.join(", "),
  );
  assert.match(suggestions[0], /^a+-\d{1,4}$/);
});
