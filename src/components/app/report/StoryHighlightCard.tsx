import type { StoryHighlight, StoryHighlightCategory } from "@/lib/llm";

const CATEGORY_DISPLAY: Record<
  StoryHighlightCategory,
  {
    badgeLabel: string;
    badgeColor: string;
    badgeBg: string;
    borderLeft: string;
    borderWidth: string;
  }
> = {
  strongest_story: {
    badgeLabel: "Your strongest story",
    badgeColor: "var(--color-success, #1d9e75)",
    badgeBg: "rgba(29, 158, 117, 0.08)",
    borderLeft: "var(--color-success, #1d9e75)",
    borderWidth: "4px",
  },
  most_proud_of: {
    badgeLabel: "Most proud of",
    badgeColor: "var(--color-ir-gold)",
    badgeBg: "rgba(200, 137, 62, 0.08)",
    borderLeft: "var(--color-ir-gold)",
    borderWidth: "3px",
  },
  failure_or_difficult: {
    badgeLabel: "Failure or difficult",
    badgeColor: "#9B7B6E",
    badgeBg: "rgba(155, 123, 110, 0.08)",
    borderLeft: "#9B7B6E",
    borderWidth: "3px",
  },
  needs_landing: {
    badgeLabel: "Needs a clearer landing",
    badgeColor: "var(--color-warning, #ef9f27)",
    badgeBg: "rgba(239, 159, 39, 0.08)",
    borderLeft: "var(--color-warning, #ef9f27)",
    borderWidth: "3px",
  },
};

export function StoryHighlightCard({ story }: { story: StoryHighlight }) {
  const d = CATEGORY_DISPLAY[story.category];
  const isStrongest = story.category === "strongest_story";

  return (
    <div
      data-testid="story-highlight-card"
      data-category={story.category}
      className="rounded-xl border border-border bg-background p-5"
      style={{ borderLeft: `${d.borderWidth} solid ${d.borderLeft}` }}
    >
      <span
        className="mb-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
        style={{ background: d.badgeBg, color: d.badgeColor }}
        data-testid={`story-badge-${story.category}`}
      >
        {d.badgeLabel}
      </span>
      <h3
        className="font-semibold text-foreground"
        style={{ fontSize: isStrongest ? "16px" : "14px" }}
      >
        {story.title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-foreground/80">
        {story.body}
      </p>
      {isStrongest && (
        <p
          className="mt-3 text-xs italic"
          style={{ color: "var(--color-success, #1d9e75)" }}
        >
          Use this as your anchor story for future interviews.
        </p>
      )}
    </div>
  );
}
