"use client";

import { useEffect } from "react";

/**
 * Tiny client island that fires when the user lands on the outcome
 * page from the reminder email. External analytics removed.
 */
export function OutcomeReminderTracker({ sessionId }: { sessionId: string }) {
  useEffect(() => {
    // Analytics event placeholder (external tracking removed).
    void sessionId;
  }, [sessionId]);

  return null;
}
