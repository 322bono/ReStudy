import { useEffect, useState, type InputHTMLAttributes } from "react";
import {
  commitNumberInput,
  editNumberInput,
  numberInputState,
} from "../lib/number-input";

type NumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange" | "min" | "max"
> & {
  value: number | undefined;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  normalizeValue?: (value: number) => number;
  /** Optional fields clear only when the blank draft is committed. */
  onEmpty?: () => void;
};

/** Keeps typing local; publishes only a finite, bounded number on blur or Enter. */
export function NumberInput({
  value,
  onValueChange,
  onEmpty,
  min,
  max,
  integer = true,
  normalizeValue,
  onBlur,
  onKeyDown,
  ...props
}: NumberInputProps) {
  const [draft, setDraft] = useState(() => numberInputState(value));
  useEffect(() => setDraft(numberInputState(value)), [value]);
  const commit = () => {
    const next = commitNumberInput(draft, {
      min,
      max,
      integer,
      allowEmpty: !!onEmpty,
      normalizeValue,
    });
    setDraft(next);
    if (next.value === undefined) {
      if (value !== undefined) onEmpty?.();
    } else if (next.value !== value) onValueChange(next.value);
  };
  return (
    <input
      {...props}
      type="number"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={props.step ?? (integer ? 1 : "any")}
      value={draft.text}
      onChange={(event) =>
        setDraft((current) => editNumberInput(current, event.target.value))
      }
      onBlur={(event) => {
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        onKeyDown?.(event);
      }}
    />
  );
}
