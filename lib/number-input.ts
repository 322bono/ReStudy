export type NumberInputState = { text: string; value: number | undefined };
export type NumberInputOptions = {
  min?: number;
  max?: number;
  integer?: boolean;
  allowEmpty?: boolean;
  normalizeValue?: (value: number) => number;
};
export function numberInputState(value: number | undefined): NumberInputState {
  const valid = Number.isFinite(value) ? value : undefined;
  return { text: valid === undefined ? "" : String(valid), value: valid };
}
export function editNumberInput(state: NumberInputState, text: string) {
  return { ...state, text };
}
export function commitNumberInput(
  state: NumberInputState,
  options: NumberInputOptions = {},
) {
  const text = state.text.trim();
  if (!text && options.allowEmpty) return numberInputState(undefined);
  const parsed = text ? Number(text) : NaN;
  let value = Number.isFinite(parsed) ? parsed : state.value;
  if (value === undefined) return numberInputState(undefined);
  if (options.integer !== false) value = Math.round(value);
  if (options.min !== undefined) value = Math.max(options.min, value);
  if (options.max !== undefined) value = Math.min(options.max, value);
  if (options.normalizeValue) {
    const normalized = options.normalizeValue(value);
    if (Number.isFinite(normalized)) value = normalized;
  }
  return numberInputState(value);
}
