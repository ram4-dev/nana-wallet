import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkContactAlias: vi.fn(),
  createContact: vi.fn(),
  updateContact: vi.fn(),
  deleteContact: vi.fn(),
  getContactRemovalPreview: vi.fn(),
  retryRecipientPolicy: vi.fn(),
  getContacts: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    checkContactAlias: (...args: unknown[]) => mocks.checkContactAlias(...args),
    createContact: (...args: unknown[]) => mocks.createContact(...args),
    updateContact: (...args: unknown[]) => mocks.updateContact(...args),
    deleteContact: (...args: unknown[]) => mocks.deleteContact(...args),
    getContactRemovalPreview: (...args: unknown[]) => mocks.getContactRemovalPreview(...args),
    retryRecipientPolicy: (...args: unknown[]) => mocks.retryRecipientPolicy(...args),
    getContacts: () => mocks.getContacts(),
  },
  queryKeys: {
    contacts: (userId: string | undefined) => ["contacts", userId],
  },
  getErrorMessage: (error: unknown) => String(error),
}));

import type { Contact, ContactAliasCheckResponse } from "@/lib/api-types";

import { AddTrustedRecipient } from "./AddTrustedRecipient";
import { ContactAliasDrift } from "./ContactAliasDrift";
import { driftReport } from "./contact-alias-drift";

const STORED = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OBSERVED = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";

const ALIAS_CONTACT: Contact = {
  id: "c-alias",
  name: "Nieta",
  description: "Mi nieta",
  network: "solana-devnet",
  address: STORED,
  version: 3,
  status: "active",
  createdAt: "2026-09-10T00:00:00.000Z",
  updatedAt: "2026-09-10T00:00:00.000Z",
  permission: { state: "applied", desiredRevision: 3, appliedRevision: 3, retryable: false },
  alias: { name: "juan.sns", resolvedAt: "2026-10-10T18:04:11.482Z" },
};

/** The paste path's row: no alias, so the drift surface has nothing to check. */
const PASTED_CONTACT: Contact = {
  ...ALIAS_CONTACT,
  id: "c-pasted",
  name: "Vecina",
  alias: null,
};

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mockCheck(result: ContactAliasCheckResponse) {
  mocks.checkContactAlias.mockResolvedValue(result);
}

const MOVED: ContactAliasCheckResponse = {
  state: "changed",
  storedAddress: STORED,
  observedAddress: OBSERVED,
  reason: "destination_moved",
};

function renderNotice(contact: Contact = ALIAS_CONTACT) {
  const onReplace = vi.fn();
  const onRemove = vi.fn();
  render(<ContactAliasDrift contact={contact} onReplace={onReplace} onRemove={onRemove} />);
  return { onReplace, onRemove };
}

function renderSurface() {
  render(
    <Wrapper>
      <AddTrustedRecipient userId="u1" />
    </Wrapper>,
  );
}

/** Drives the list row's check and waits for the notice to appear. */
async function openNotice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByTestId("alias-drift-check-c-alias"));
  return screen.findByTestId("alias-drift-notice-c-alias");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getContacts.mockResolvedValue([ALIAS_CONTACT]);
  mocks.getContactRemovalPreview.mockResolvedValue({
    contactId: "c-alias",
    revokedGrantIds: [],
    revokedGrants: [],
  });
  mocks.updateContact.mockResolvedValue(ALIAS_CONTACT);
  mocks.deleteContact.mockResolvedValue(undefined);
});

describe("ContactAliasDrift — the three states read differently", () => {
  it("offers the check for an alias-sourced contact and nothing at all without an alias", () => {
    // POSITIVE CONTROL: the surface the rest of this file drives exists, so a
    // later failure is about behaviour and never about a missing button.
    renderNotice();
    expect(screen.getByTestId("alias-drift-check-c-alias")).toBeTruthy();

    renderNotice(PASTED_CONTACT);
    expect(screen.queryByTestId("alias-drift-check-c-pasted")).toBeNull();
    expect(screen.queryByTestId("alias-drift-notice-c-pasted")).toBeNull();
  });

  it("reports a destination that MOVED, with both addresses and both names, untruncated", async () => {
    const user = userEvent.setup();
    mockCheck(MOVED);
    renderNotice();

    // Nothing happens by looking: the check is user-initiated by construction.
    expect(mocks.checkContactAlias).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    const notice = await screen.findByTestId("alias-drift-notice-c-alias");

    // Both names, in the sentence: the alias and the person.
    expect(within(notice).getByTestId("alias-drift-sentence-c-alias").textContent).toBe(
      "The name juan.sns for Nieta now points to a different address.",
    );
    // Both addresses, each at full length: a truncated destination cannot be
    // compared by the person who is being asked to decide.
    expect(within(notice).getByTestId("alias-drift-observed-c-alias").textContent).toBe(OBSERVED);
    expect(within(notice).getByTestId("alias-drift-stored-c-alias").textContent).toBe(STORED);
    expect(mocks.checkContactAlias).toHaveBeenCalledWith("c-alias");
  });

  it("reports a name that NO LONGER EXISTS as its own sentence, not as a moved one", async () => {
    const user = userEvent.setup();
    mockCheck({
      state: "changed",
      storedAddress: STORED,
      reason: "name_no_longer_exists",
    });
    renderNotice();
    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    const notice = await screen.findByTestId("alias-drift-notice-c-alias");

    expect(within(notice).getByTestId("alias-drift-sentence-c-alias").textContent).toBe(
      "The name juan.sns for Nieta no longer exists.",
    );
    // No destination was observed, so no destination may be shown.
    expect(within(notice).queryByTestId("alias-drift-observed-c-alias")).toBeNull();
    // And nothing to replace with: the choice is not offered.
    expect(within(notice).queryByRole("button", { name: "Switch to the new address" })).toBeNull();
    expect(within(notice).getByRole("button", { name: "Keep as it is" })).toBeTruthy();
  });

  it("reports an UNAVAILABLE check as its own sentence and never as 'still fine'", async () => {
    const user = userEvent.setup();
    mockCheck({ state: "unavailable", storedAddress: STORED, reason: "unreachable" });
    renderNotice();
    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    const notice = await screen.findByTestId("alias-drift-notice-c-alias");

    const sentence = within(notice).getByTestId("alias-drift-sentence-c-alias").textContent ?? "";
    expect(sentence).toBe("We could not check juan.sns for Nieta right now.");
    // The failure mode this sentence exists to prevent: an unreachable resolver
    // reported as a fact about the chain.
    expect(sentence).not.toMatch(/same address/);
    expect(within(notice).getByTestId("alias-drift-consequence-c-alias").textContent).toMatch(
      /we do not know/i,
    );
    // No decision to make, so no drift choices are offered.
    expect(within(notice).queryByRole("button", { name: "Switch to the new address" })).toBeNull();
  });

  it("reports an UNCHANGED name, and still writes nothing", async () => {
    const user = userEvent.setup();
    mockCheck({ state: "unchanged", storedAddress: STORED });
    renderNotice();
    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    const notice = await screen.findByTestId("alias-drift-notice-c-alias");

    expect(within(notice).getByTestId("alias-drift-sentence-c-alias").textContent).toBe(
      "The name juan.sns for Nieta still points to the same address.",
    );
    expect(within(notice).queryByRole("button", { name: "Keep as it is" })).toBeNull();
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.deleteContact).not.toHaveBeenCalled();
  });

  it("keeps the three states three different sentences at the pure seam", () => {
    const moved = driftReport(MOVED, "juan.sns", "Nieta");
    const gone = driftReport(
      { state: "changed", storedAddress: STORED, reason: "name_no_longer_exists" },
      "juan.sns",
      "Nieta",
    );
    const unavailable = driftReport(
      { state: "unavailable", storedAddress: STORED, reason: "unreachable" },
      "juan.sns",
      "Nieta",
    );
    const unchanged = driftReport(
      { state: "unchanged", storedAddress: STORED },
      "juan.sns",
      "Nieta",
    );

    expect([moved.sentence, gone.sentence, unavailable.sentence, unchanged.sentence]).toEqual([
      "The name juan.sns for Nieta now points to a different address.",
      "The name juan.sns for Nieta no longer exists.",
      "We could not check juan.sns for Nieta right now.",
      "The name juan.sns for Nieta still points to the same address.",
    ]);
    expect(new Set([moved.sentence, gone.sentence, unavailable.sentence]).size).toBe(3);
    expect(moved.observedAddress).toBe(OBSERVED);
    // The unchanged sentence is reachable ONLY from an `unchanged` state: the
    // other three can never be phrased as "no drift".
    for (const report of [moved, gone, unavailable]) {
      expect(report.sentence).not.toMatch(/same address/);
      expect(report.isDrift || report.kind === "unavailable").toBe(true);
    }
  });

  it("never invents a destination the server did not report", () => {
    const report = driftReport(
      { state: "changed", storedAddress: STORED, reason: "algún_motivo_nuevo" },
      "juan.sns",
      "Nieta",
    );
    expect(report.kind).toBe("changed_unknown");
    expect(report.observedAddress).toBeNull();
    expect(report.sentence).not.toMatch(new RegExp(OBSERVED));
    expect(report.sentence).not.toMatch(/same address/);
  });
});

describe("ContactAliasDrift — the three choices never bypass the authorization path", () => {
  it("KEEP leaves the row untouched and a second check re-reports the drift", async () => {
    const user = userEvent.setup();
    mockCheck(MOVED);
    renderNotice();
    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    const notice = await screen.findByTestId("alias-drift-notice-c-alias");

    await user.click(within(notice).getByRole("button", { name: "Keep as it is" }));

    // Nothing was written and nothing was sent to the server by the choice.
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.deleteContact).not.toHaveBeenCalled();
    expect(mocks.createContact).not.toHaveBeenCalled();
    // The frozen address is still the one on screen.
    expect(screen.getByTestId("alias-drift-stored-c-alias").textContent).toBe(STORED);

    // "Keep" silences nothing permanently (design §5.4): the check is explicit
    // and the drift is re-reported on each one.
    await user.click(screen.getByTestId("alias-drift-check-c-alias"));
    expect(await screen.findByTestId("alias-drift-sentence-c-alias")).toBeTruthy();
    expect(mocks.checkContactAlias).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("alias-drift-sentence-c-alias").textContent).toBe(
      "The name juan.sns for Nieta now points to a different address.",
    );
  });

  it("REPLACE goes through the existing disclosure, and only the confirmation calls the API", async () => {
    const user = userEvent.setup();
    renderSurface();
    await openNotice(user);

    await user.click(screen.getByRole("button", { name: "Switch to the new address" }));

    // The choice opened the existing address-change path: a preview request,
    // never a mutation.
    await waitFor(() =>
      expect(mocks.getContactRemovalPreview).toHaveBeenCalledWith("c-alias", 3, "address_change"),
    );
    expect(mocks.updateContact).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Confirm address change",
    });
    expect(mocks.updateContact).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirm change" }));

    await waitFor(() => expect(mocks.updateContact).toHaveBeenCalledTimes(1));
    const [contactId, body] = mocks.updateContact.mock.calls[0] ?? [];
    expect(contactId).toBe("c-alias");
    expect(body).toMatchObject({ address: OBSERVED, expectedVersion: 3 });
    // No alias key travels with the replacement: the server clears the stale
    // claim (task 2.2, correction C2) instead of keeping a name for an address
    // the contact no longer has.
    expect(Object.keys(body as Record<string, unknown>)).not.toContain("alias");
    expect(Object.keys(body as Record<string, unknown>)).not.toContain("provenance");
  });

  it("REMOVE follows the ordinary removal semantics and waits for its confirmation", async () => {
    const user = userEvent.setup();
    renderSurface();
    await openNotice(user);

    await user.click(screen.getByRole("button", { name: "Remove Nieta" }));

    await waitFor(() =>
      expect(mocks.getContactRemovalPreview.mock.calls[0]).toEqual(["c-alias", 3]),
    );
    expect(mocks.deleteContact).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog", {
      name: "Confirm recipient removal",
    });

    await user.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.deleteContact).toHaveBeenCalledTimes(1));
    expect(mocks.deleteContact.mock.calls[0]?.[1]).toMatchObject({ expectedVersion: 3 });
  });

  it("the drift report alone refuses no payment and leaves the contact's own row untouched", async () => {
    const user = userEvent.setup();
    renderSurface();
    await openNotice(user);

    // The only call the report made is the check itself. The contract's update,
    // delete and create paths were never touched, so no authority changed.
    expect(mocks.checkContactAlias).toHaveBeenCalledTimes(1);
    expect(mocks.updateContact).not.toHaveBeenCalled();
    expect(mocks.deleteContact).not.toHaveBeenCalled();
    expect(mocks.createContact).not.toHaveBeenCalled();
    // The trusted recipient is still there, with the frozen address and every
    // list action still available: a moved name is a notice, not a lock.
    expect(screen.getByTestId("contact-address-c-alias").textContent).toBe(STORED);
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("raises an unreachable check as its own refusal instead of an empty notice", async () => {
    const user = userEvent.setup();
    mocks.checkContactAlias.mockRejectedValue(
      Object.assign(new Error("No encontramos a esa persona."), {
        code: "NO_ENCONTRADO",
        status: 404,
      }),
    );
    renderSurface();

    await user.click(await screen.findByTestId("alias-drift-check-c-alias"));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("alias-drift-notice-c-alias")).toBeNull();
    expect(mocks.updateContact).not.toHaveBeenCalled();
  });
});
