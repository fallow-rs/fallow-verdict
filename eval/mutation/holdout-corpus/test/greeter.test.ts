import { describe, expect, it } from "vitest";

import { fire, greeter } from "../src/greeter.ts";

describe("greeter", () => {
  it("greets by name", () => {
    expect(greeter.greet()).toBe("Hello, guest");
  });

  it("fires bound handlers", () => {
    expect(fire([() => greeter.greet()])).toEqual(["Hello, guest"]);
  });
});
