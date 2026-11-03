/** Source PDF page numbers are identifiers, not positions in the analyzed list. */
export function pageNavigation(
  pages: readonly { number: number }[],
  requested: number,
) {
  const numbers = [...new Set(pages.map((page) => page.number))]
    .filter((number) => Number.isInteger(number) && number > 0)
    .sort((a, b) => a - b);
  const page = numbers.reduce<number | undefined>(
    (nearest, number) =>
      nearest === undefined ||
      Math.abs(number - requested) < Math.abs(nearest - requested)
        ? number
        : nearest,
    undefined,
  );
  const index = page === undefined ? -1 : numbers.indexOf(page);
  return {
    page,
    index,
    count: numbers.length,
    first: numbers[0],
    last: numbers[numbers.length - 1],
    previous: index > 0 ? numbers[index - 1] : undefined,
    next: index >= 0 ? numbers[index + 1] : undefined,
  };
}
