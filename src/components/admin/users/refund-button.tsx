"use client";

import { useState, useTransition } from "react";

import { recordRefundIntentAction } from "@/lib/admin/actions";

interface RefundButtonProps {
  purchaseId: string;
  txnRef: string | null;
  txnId: string;
}

/**
 * Per-payment "Refund" affordance for the user detail page.
 *
 * Records the operator's intent to reverse credits for this purchase
 * via `recordRefundIntentAction` (audit row).
 */
export function RefundButton({
  purchaseId,
}: RefundButtonProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending || done}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await recordRefundIntentAction({ purchaseId });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setDone(true);
          });
        }}
        className="rounded-md border px-2 py-0.5 text-xs disabled:opacity-40"
        style={{
          borderColor: "var(--color-border-secondary)",
          color: "var(--color-danger-text)",
          background: "var(--color-danger-bg)",
        }}
        title="Records refund intent and reverses credits"
      >
        {pending ? "…" : done ? "Refunded" : "Refund"}
      </button>
      {error && (
        <span
          className="text-xs"
          style={{ color: "var(--color-danger-text)" }}
        >
          {error}
        </span>
      )}
    </span>
  );
}
