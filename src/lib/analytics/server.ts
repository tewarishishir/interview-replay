import "server-only";

import {
  type AnalyticsEventName,
  type AnalyticsProperties,
} from "./events";

/**
 * Server-side analytics stub. External analytics services have been
 * removed for open-source self-hosting. This module preserves the
 * `trackServerEvent` and `identifyServerUser` interfaces so call sites
 * don't need modification — they simply no-op.
 */

export function trackServerEvent(_args: {
  distinctId: string;
  event: AnalyticsEventName;
  properties?: AnalyticsProperties;
}): void {
  // No-op: external analytics removed for open-source.
}

export function identifyServerUser(_args: {
  distinctId: string;
  email: string;
}): void {
  // No-op: external analytics removed for open-source.
}

export async function flushAnalytics(): Promise<void> {
  // No-op: external analytics removed for open-source.
}
