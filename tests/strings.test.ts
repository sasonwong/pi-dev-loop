import { describe, it, expect } from "bun:test";
import { upper } from "../src/strings";

describe("strings", () => {
  it("uppers", () => expect(upper("hello")).toBe("HELLO"));
});
