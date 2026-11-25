import { describe, expect, it } from "vitest";

import { loadSettings, themeOf } from "../src/settings.ts";

describe("settings", () => {
  it("parses settings", () => {
    expect(loadSettings('{"theme":"dark","size":2}')).toEqual({ theme: "dark", size: 2 });
  });

  it("reads the theme", () => {
    expect(themeOf('{"theme":"light","size":1}')).toBe("light");
  });
});
