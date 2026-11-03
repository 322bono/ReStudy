import { describe, expect, test } from "vitest";
import { pageNavigation } from "../lib/page-navigation";

describe("analyzed PDF page navigation", () => {
  test("opens the first analyzed source page when page one was not analyzed", () => {
    const pages = Array.from({ length: 28 }, (_, index) => ({
      number: index + 73,
    }));
    expect(pageNavigation(pages, 1)).toMatchObject({
      page: 73,
      index: 0,
      count: 28,
      previous: undefined,
      next: 74,
      first: 73,
      last: 100,
    });
  });

  test("moves across gaps using sorted source page numbers without renumbering", () => {
    const pages = [{ number: 100 }, { number: 73 }, { number: 81 }];
    expect(pageNavigation(pages, 81)).toMatchObject({
      page: 81,
      index: 1,
      count: 3,
      previous: 73,
      next: 100,
    });
    expect(pageNavigation(pages, 100)).toMatchObject({
      page: 100,
      index: 2,
      previous: 81,
      next: undefined,
    });
    expect(pages.map((page) => page.number)).toEqual([100, 73, 81]);
  });

  test("resolves missing typed page numbers to the nearest analyzed source page", () => {
    const pages = [{ number: 73 }, { number: 81 }, { number: 100 }];
    expect(pageNavigation(pages, 80).page).toBe(81);
    expect(pageNavigation(pages, 77).page).toBe(73);
    expect(pageNavigation(pages, 999).page).toBe(100);
  });

  test("has no available navigation while analyzed pages are absent", () => {
    expect(pageNavigation([], 73)).toMatchObject({
      page: undefined,
      index: -1,
      count: 0,
      previous: undefined,
      next: undefined,
    });
  });
});
