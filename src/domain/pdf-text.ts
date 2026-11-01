/** PostgreSQL jsonb rejects NUL and unpaired UTF-16 surrogates from PDF fonts. */
export function repairPdfText(text: string): string {
  // With the Unicode flag, a valid surrogate pair is one astral code point and
  // does not match the surrogate range. Korean, math and emoji stay unchanged.
  return text.replace(/[\u0000\uD800-\uDFFF]/gu, "�");
}

export function storagePageText<T extends {
  text: string;
  items: { text: string }[];
  warnings: string[];
}>(page: T): T {
  const text = repairPdfText(page.text);
  const items = page.items.map((item) => ({ ...item, text: repairPdfText(item.text) }));
  const repaired = text !== page.text || items.some((item, index) => item.text !== page.items[index].text);
  const warnings = page.warnings.map(repairPdfText);
  if (repaired) warnings.push("추출 텍스트의 깨진 문자를 대체했습니다. 해당 글자는 원본 이미지에서 확인하세요.");
  return { ...page, text, items, warnings: [...new Set(warnings)] };
}
