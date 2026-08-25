// test/commands.test.ts — semantic `/mesh join` parsing (manual aliases removed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HELP_TEXT, parseJoinArgs } from "../src/extension/commands.js";

describe("parseJoinArgs", () => {
  it("plain room", () => {
    assert.deepEqual(parseJoinArgs(["ops"]), { room: "ops", observer: false });
  });

  it("room + observer", () => {
    assert.deepEqual(parseJoinArgs(["ops", "observer"]), { room: "ops", observer: true });
  });

  it("rejects room as alias syntax", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1"]), {
      room: undefined,
      observer: false,
    });
  });

  it("rejects room as alias observer syntax", () => {
    assert.deepEqual(parseJoinArgs(["ops", "as", "agent-1", "observer"]), {
      room: undefined,
      observer: true,
    });
  });

  it("rejects alias-only syntax", () => {
    assert.deepEqual(parseJoinArgs(["as", "agent-1"]), {
      room: undefined,
      observer: false,
    });
  });

  it("no args", () => {
    assert.deepEqual(parseJoinArgs([]), { room: undefined, observer: false });
  });
});


describe("mesh help", () => {
  it("does not expose removed alias-management commands", () => {
    assert.doesNotMatch(HELP_TEXT, /\/mesh (?:alias|reset|new)\b/);
    assert.match("/mesh alias", /\/mesh (?:alias|reset|new)\b/);
  });
});
