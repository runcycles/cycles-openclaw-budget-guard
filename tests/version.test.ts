import { describe, it, expect } from "vitest";
import { PLUGIN_VERSION } from "../src/version.js";

describe("PLUGIN_VERSION", () => {
  it("is a non-empty string", () => {
    expect(typeof PLUGIN_VERSION).toBe("string");
    expect(PLUGIN_VERSION.length).toBeGreaterThan(0);
  });

  it("falls back to 'dev' when __PLUGIN_VERSION__ is not defined", () => {
    // In test environment, tsup doesn't inject the define, so it falls back
    expect(PLUGIN_VERSION).toBe("dev");
  });
});
