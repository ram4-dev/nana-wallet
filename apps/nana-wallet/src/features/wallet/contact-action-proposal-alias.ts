import type { ContactActionProposalAlias } from "@/lib/api-types";

/**
 * The alias lines' pure formatting (task 6.3, design §2.4). Kept out of the card
 * module so the component file exports components only, and so each sentence is
 * assertable without rendering.
 */
/** The absolute instant, in the same UTC shape the expiry line already uses. */
export function formatInstant(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // `en-US`: this card's copy is English, and a Spanish locale leaks Spanish
  // into a timestamp the user is meant to read (`12:05 a. m.`). The shape stays
  // the same — day/month, hour, minute, UTC.
  return date.toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** The instant a name was resolved, as the freshness line labels it. */
export const formatResolvedAt = formatInstant;

/**
 * How old the resolution is, labelled. This is a TRANSPARENCY AFFORDANCE and
 * never a guard (design §2.4/O3): the guard is the server's re-resolution before
 * the address is authorized, so an old card is still safe and still says so.
 * An unparseable value returns `null` rather than inventing an age.
 */
export function aliasAgeLabel(resolvedAt: string, now: Date): string | null {
  const date = new Date(resolvedAt);
  if (Number.isNaN(date.getTime())) return null;
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "a few seconds ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * The reverse-domain sentence, one per state, and never collapsed (design §2.4).
 * `unknown` says what could NOT be checked: rendering it as `none` would turn an
 * unrecognized error shape into a fact about the chain.
 */
export function reverseDomainSentence(alias: ContactActionProposalAlias): string {
  switch (alias.reverseDomainState) {
    case "present":
      return `The primary name of this address is ${alias.reverseDomain}.`;
    case "none":
      return "This address has no registered primary name.";
    case "unknown":
      return "I could not check whether this address has a primary name.";
  }
}
