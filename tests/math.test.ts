import { describe, it, expect } from "bun:test";
import { add, multiply } from "../src/math";

describe("math", () => {
  it("adds", () => expect(add(1, 2)).toBe(3));
  it("multiplies", () => expect(multiply(3, 4)).toBe(12));
});
