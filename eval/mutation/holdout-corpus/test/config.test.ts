import { describe, expect, it } from "vitest";

import { firstName, portOf } from "../src/config.ts";

describe("config", () => {
  it("reads the port", () => {
    expect(portOf('{"port":3000,"host":"a"}')).toBe(3000);
    expect(portOf('{"host":"a"}')).toBe(8080);
  });

  it("finds the first name", () => {
    expect(firstName(["", " ann "])).toBe("ann");
  });
});
