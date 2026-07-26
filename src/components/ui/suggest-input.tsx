"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SuggestInputProps
  extends Omit<React.ComponentProps<typeof Input>, "list"> {
  /** Full pool of suggestions; filtered locally as the user types. */
  suggestions: readonly string[];
  /**
   * Called when the user picks a suggestion (Enter on a highlighted item
   * or click). Distinct from `onChange` so callers can decide to treat a
   * pick as "commit immediately" (e.g. a tag input) vs. just populating
   * the input value.
   */
  onPick?: (value: string) => void;
  /** Maximum number of suggestions rendered at once. Defaults to 8. */
  max?: number;
  /**
   * Class on the relative wrapper that contains the input + dropdown
   * panel. Use this to pass layout classes (`flex-1`, `w-full`) that
   * would otherwise have lived on a bare `<Input>`.
   */
  wrapperClassName?: string;
  /** Class on the dropdown panel itself. */
  panelClassName?: string;
}

/**
 * Text input with an inline, locally-filtered suggestion dropdown.
 *
 * Built to replace `<input list>` + `<datalist>` pairs across the app:
 * the native datalist UI is browser-controlled and on some setups
 * renders the popup off to the side of the viewport rather than under
 * the input. This component owns its own popover so positioning is
 * always anchored to the input's bottom edge.
 *
 * UX notes:
 *   - Suggestions appear on focus (and on every keystroke) when at
 *     least one match exists.
 *   - ↓/↑ navigate, Enter picks the highlight, Escape closes.
 *   - Mouse click on a row picks immediately (`onMouseDown` so the
 *     input doesn't blur first and trigger the parent's `onBlur`
 *     handler).
 *   - Click outside the wrapper closes the panel.
 *
 * Composes cleanly with `react-hook-form` + `<FormControl>`: spread
 * `{...field}` onto it and set `onPick={(v) => field.onChange(v)}` for
 * "picking a suggestion fills the field" semantics.
 */
export const SuggestInput = React.forwardRef<HTMLInputElement, SuggestInputProps>(
  function SuggestInput(
    {
      suggestions,
      onPick,
      max = 8,
      value,
      onChange,
      onFocus,
      onBlur,
      onKeyDown,
      className,
      wrapperClassName,
      panelClassName,
      ...inputProps
    },
    ref,
  ) {
    const [open, setOpen] = React.useState(false);
    const [highlight, setHighlight] = React.useState(-1);
    const wrapperRef = React.useRef<HTMLDivElement>(null);

    const query =
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : "";

    const filtered = React.useMemo(() => {
      const q = query.trim().toLowerCase();
      const matches =
        q === ""
          ? suggestions.slice()
          : suggestions.filter((s) => s.toLowerCase().includes(q));
      return matches.slice(0, max);
    }, [suggestions, query, max]);

    const showList = open && filtered.length > 0;

    // Close on outside click. We listen on `mousedown` (not `click`) so
    // the close fires before any focus-related handlers in the parent
    // run — matches what the native datalist felt like.
    React.useEffect(() => {
      if (!open) return;
      const onDocMouseDown = (e: MouseEvent) => {
        if (
          wrapperRef.current &&
          !wrapperRef.current.contains(e.target as Node)
        ) {
          setOpen(false);
        }
      };
      document.addEventListener("mousedown", onDocMouseDown);
      return () => document.removeEventListener("mousedown", onDocMouseDown);
    }, [open]);

    // Reset the highlight whenever the visible suggestion set changes
    // out from under us (e.g. the user typed and the filter cut the
    // previously-highlighted row).
    React.useEffect(() => {
      if (highlight >= filtered.length) setHighlight(-1);
    }, [filtered.length, highlight]);

    const pick = (s: string) => {
      onPick?.(s);
      setOpen(false);
      setHighlight(-1);
    };

    return (
      <div ref={wrapperRef} className={cn("relative", wrapperClassName)}>
        <Input
          ref={ref}
          value={value}
          onChange={(e) => {
            onChange?.(e);
            setOpen(true);
            setHighlight(-1);
          }}
          onFocus={(e) => {
            setOpen(true);
            onFocus?.(e);
          }}
          onBlur={(e) => onBlur?.(e)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              if (!open) {
                setOpen(true);
                e.preventDefault();
                return;
              }
              if (filtered.length > 0) {
                e.preventDefault();
                setHighlight((h) => (h + 1) % filtered.length);
                return;
              }
            }
            if (e.key === "ArrowUp" && open && filtered.length > 0) {
              e.preventDefault();
              setHighlight((h) =>
                h <= 0 ? filtered.length - 1 : h - 1,
              );
              return;
            }
            if (
              e.key === "Enter" &&
              open &&
              highlight >= 0 &&
              filtered[highlight]
            ) {
              e.preventDefault();
              pick(filtered[highlight]);
              return;
            }
            if (e.key === "Escape" && open) {
              e.preventDefault();
              setOpen(false);
              setHighlight(-1);
              return;
            }
            onKeyDown?.(e);
          }}
          className={className}
          {...inputProps}
          autoComplete="off"
        />
        {showList && (
          <ul
            role="listbox"
            className={cn(
              "absolute left-0 right-0 top-full z-30 mt-1 max-h-60 min-w-[12rem] overflow-auto rounded-md border border-border bg-background py-1 text-sm shadow-md",
              panelClassName,
            )}
          >
            {filtered.map((s, i) => (
              <li key={s}>
                <button
                  type="button"
                  role="option"
                  aria-selected={highlight === i}
                  onMouseDown={(e) => {
                    // Fire before the input's blur so the click survives.
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    "block w-full px-3 py-1.5 text-left transition-colors",
                    highlight === i
                      ? "bg-muted text-foreground"
                      : "text-foreground hover:bg-muted",
                  )}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  },
);
