import { describe, expect, it } from "vitest";

import { parseFiniteNumber, parseFiniteVector3, parseInteger } from "../../packages/cli/src/numeric.js";

describe("CLI numeric parsing", () => {
  it("accepts finite values within the declared range", () => {
    expect(parseFiniteNumber("0.35", "--strength", { min: 0, max: 1 })).toBe(0.35);
    expect(parseInteger("3", "--viewport-index", { min: 0, max: 3 })).toBe(3);
  });

  it.each(["NaN", "Infinity", "-Infinity", "1px", ""])(
    "rejects non-finite or partial numeric input %j",
    (source) => {
      expect(() => parseFiniteNumber(source, "--x")).toThrow("--x must be a finite number");
    },
  );

  it("rejects fractional integers and out-of-range values", () => {
    expect(() => parseInteger("1.5", "--frames", { min: 1, max: 120 })).toThrow("--frames must be an integer");
    expect(() => parseInteger("4", "--viewport-index", { min: 0, max: 3 })).toThrow(
      "--viewport-index must be an integer between 0 and 3",
    );
    expect(() => parseFiniteNumber("0", "--max-distance", { min: Number.MIN_VALUE, max: 100_000 })).toThrow(
      "--max-distance must be between",
    );
  });

  it("requires --position to contain exactly three finite numeric coordinates", () => {
    expect(parseFiniteVector3({ x: 1, y: 2.5, z: -3 }, "--position")).toEqual({ x: 1, y: 2.5, z: -3 });
    expect(() => parseFiniteVector3({ x: "1", y: 2, z: 3 }, "--position")).toThrow(
      "--position.x must be a finite number",
    );
    expect(() => parseFiniteVector3({ x: 1, y: 2 }, "--position")).toThrow("containing exactly x, y, and z");
    expect(() => parseFiniteVector3({ x: 1, y: 2, z: 3, w: 4 }, "--position")).toThrow(
      "containing exactly x, y, and z",
    );
  });
});
