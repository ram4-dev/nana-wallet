import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useSigners: vi.fn(),
}));

vi.mock("@privy-io/react-auth", () => ({
  useSigners: mocks.useSigners,
}));

import { PrivySignerEnrollment } from "./PrivySignerEnrollment";

describe("PrivySignerEnrollment (TEE-compatible addSigners)", () => {
  beforeEach(() => {
    mocks.useSigners.mockReset();
  });

  it("attaches the app key quorum as a server-side signer with the enrollment policy", async () => {
    const addSigners = vi.fn().mockResolvedValue({ user: { id: "did" } });
    mocks.useSigners.mockReturnValue({ addSigners });

    const onEnrolled = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const user = userEvent.setup();

    render(
      <PrivySignerEnrollment
        walletAddress="0x5770353D56e4a7cBAa078CD46248e75431c7514f"
        quorumId="np33q4k0i44p3g4kr2na0u9y"
        policyId="u94to62itemodu5kon7ubwmy"
        busy={false}
        onEnrolled={onEnrolled}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: /autorizar firmante/i }));

    await waitFor(() => expect(addSigners).toHaveBeenCalledTimes(1));
    // TEE path: the key quorum is the server-side signer, carrying the
    // enrollment policy. No on-device delegateWallet call.
    expect(addSigners).toHaveBeenCalledWith({
      address: "0x5770353D56e4a7cBAa078CD46248e75431c7514f",
      signers: [
        {
          signerId: "np33q4k0i44p3g4kr2na0u9y",
          policyIds: ["u94to62itemodu5kon7ubwmy"],
        },
      ],
    });
    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
    expect(onError).not.toHaveBeenCalled();
  });

  it("surfaces a consent failure through onError and does not report enrollment", async () => {
    const addSigners = vi.fn().mockRejectedValue(new Error("User rejected the request"));
    mocks.useSigners.mockReturnValue({ addSigners });

    const onEnrolled = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const user = userEvent.setup();

    render(
      <PrivySignerEnrollment
        walletAddress="0x5770353D56e4a7cBAa078CD46248e75431c7514f"
        quorumId="q-1"
        policyId="p-1"
        busy={false}
        onEnrolled={onEnrolled}
        onError={onError}
      />,
    );

    await user.click(screen.getByRole("button", { name: /autorizar firmante/i }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError).toHaveBeenCalledWith("User rejected the request");
    expect(onEnrolled).not.toHaveBeenCalled();
  });
});
