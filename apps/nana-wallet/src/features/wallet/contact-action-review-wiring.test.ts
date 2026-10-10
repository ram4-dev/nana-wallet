import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Reachability of the review card (task 4.7 review channel).
 *
 * The card existed and was tested, but nothing imported it at runtime, so the
 * production build tree-shook it out of the deployed bundle and the review
 * channel could never render. A component test cannot catch that: the failure
 * mode is absence from the graph, not wrong behaviour. These assertions fail by
 * name if the mounting chain `route → review surface → card` is ever broken
 * again, and the built-bundle assertion in the task evidence covers the same
 * property one level below the source.
 */
describe("contact action review wiring", () => {
  it("mounts the review surface on the live conversation screen", async () => {
    const source = await readFile(resolve(process.cwd(), "src/routes/index.tsx"), "utf8");

    expect(source).toContain('from "@/features/wallet/ContactActionProposalReview"');
    expect(source).toContain("<ContactActionProposalReview");

    // The surface must receive the conversation this browser is bound to: a card
    // belongs to that conversation and to no other.
    const mount = source.slice(source.indexOf("<ContactActionProposalReview"));
    const element = mount.slice(0, mount.indexOf("/>"));
    expect(element).toContain("conversationId={conversationId}");
    expect(element).toContain("userId={userId ?? null}");
  });

  it("renders the card from the review surface", async () => {
    const source = await readFile(
      resolve(process.cwd(), "src/features/wallet/ContactActionProposalReview.tsx"),
      "utf8",
    );

    expect(source).toContain('from "./ContactActionProposalCard"');
    expect(source).toContain("<ContactActionProposalCard");
    // The wakeup is not a data source: the surface hands the card an id only.
    expect(source).toContain("proposalId={proposalId}");
  });
});
