import { describe, expect, test } from "vitest";
import {
  commitNumberInput,
  editNumberInput,
  numberInputState,
} from "../lib/number-input";

describe("number input draft editing", () => {
  test("keeps a cleared input blank without replacing the committed number with zero or one", () => {
    const cleared = editNumberInput(numberInputState(73), "");
    expect(cleared).toEqual({ text: "", value: 73 });
    expect(editNumberInput(cleared, "100")).toEqual({ text: "100", value: 73 });
    expect(
      commitNumberInput(editNumberInput(cleared, "100"), { min: 1, max: 120 }),
    ).toEqual({ text: "100", value: 100 });
  });

  test("clamps only at commit and restores a required blank to its last valid value", () => {
    const edited = editNumberInput(numberInputState(73), "999");
    expect(edited).toEqual({ text: "999", value: 73 });
    expect(commitNumberInput(edited, { min: 1, max: 100 })).toEqual({
      text: "100",
      value: 100,
    });
    expect(commitNumberInput(editNumberInput(edited, ""), { min: 1 })).toEqual({
      text: "73",
      value: 73,
    });
  });

  test("never commits nonfinite text and accepts zero when its minimum allows it", () => {
    for (const text of ["NaN", "Infinity", "-Infinity", "1e999", "invalid"]) {
      expect(
        commitNumberInput(editNumberInput(numberInputState(5), text), {
          min: 0,
        }),
      ).toEqual({ text: "5", value: 5 });
    }
    expect(
      commitNumberInput(editNumberInput(numberInputState(5), "0"), { min: 0 }),
    ).toEqual({ text: "0", value: 0 });
    expect(
      commitNumberInput(editNumberInput(numberInputState(5), "2.8"), { min: 0 })
        .value,
    ).toBe(3);
  });

  test("an optional empty value stays empty until a valid number is committed", () => {
    expect(
      commitNumberInput(editNumberInput(numberInputState(10), ""), {
        allowEmpty: true,
      }),
    ).toEqual({ text: "", value: undefined });
    expect(
      commitNumberInput(editNumberInput(numberInputState(undefined), "-3")),
    ).toEqual({ text: "-3", value: -3 });
  });

  test("the displayed committed number follows a resolved available page", () => {
    expect(
      commitNumberInput(editNumberInput(numberInputState(81), "80"), {
        min: 73,
        max: 100,
        normalizeValue: () => 81,
      }),
    ).toEqual({ text: "81", value: 81 });
  });
});
