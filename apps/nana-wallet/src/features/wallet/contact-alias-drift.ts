import type { ContactAliasCheckResponse } from "@/lib/api-types";

/**
 * Task 7.2 (design §5.4). The pure half of the drift surface, kept out of the
 * component module so each sentence is assertable without rendering and so the
 * component file exports components only — the same split the reverse-domain
 * sentence uses (`contact-action-proposal-alias.ts`).
 *
 * WHY THE STATES ARE DIFFERENT SENTENCES
 * --------------------------------------
 * "A destination that moved", "a name that no longer exists" and "the check did
 * not run" ask the person for three different things, so they may never be
 * collapsed into "something went wrong". The failure mode this shape exists to
 * prevent is the one written into the spec: reporting "no drift" for a check
 * that never reached the registry. `unchanged` is therefore reachable only from
 * the server saying `unchanged`; every other outcome is phrased as what the
 * check actually established.
 *
 * The report is emitted, never followed (design §5.4): nothing here mutates the
 * contact, the alias provenance or the composed policy. The only writes the
 * surface can produce go through the two existing, disclosed user paths
 * (address replacement and removal), reached from the parent.
 */
export type AliasDriftKind = "unchanged" | "moved" | "gone" | "changed_unknown" | "unavailable";

export type AliasDriftReport = {
  kind: AliasDriftKind;
  /** The sentence the notice leads with, alias and person named. */
  sentence: string;
  /** What is still true of the frozen destination, or the honest "we don't know". */
  consequence: string;
  /** The freshly observed destination, only when the check established one. */
  observedAddress: string | null;
  /** True only for the states that report a destination other than the stored one. */
  isDrift: boolean;
  /** True only when a fresh destination exists to replace the stored one with. */
  canReplace: boolean;
};

export function driftReport(
  check: ContactAliasCheckResponse,
  aliasName: string,
  contactName: string,
): AliasDriftReport {
  const name = `${aliasName} de ${contactName}`;
  if (check.state === "unchanged") {
    return {
      kind: "unchanged",
      sentence: `El nombre ${name} sigue apuntando a la misma dirección.`,
      consequence: "Tu destinatario de confianza está igual que siempre.",
      observedAddress: null,
      isDrift: false,
      canReplace: false,
    };
  }
  if (check.state === "unavailable") {
    return {
      kind: "unavailable",
      sentence: `No pudimos chequear ${name} en este momento.`,
      // Never "sigue bien": the check did not run, so its result is unknown.
      consequence: `Esto no quiere decir que el nombre haya cambiado: no sabemos cómo está ahora. Tu destinatario sigue siendo ${check.storedAddress} y no lo cambié.`,
      observedAddress: null,
      isDrift: false,
      canReplace: false,
    };
  }
  // `changed`: the server compared, and the stored address is no longer what the
  // name resolves to.
  const observedAddress = check.observedAddress ?? null;
  if (observedAddress) {
    return {
      kind: "moved",
      sentence: `El nombre ${name} ahora apunta a otra dirección.`,
      consequence: `Tu destinatario de confianza sigue siendo ${check.storedAddress} y no lo cambié.`,
      observedAddress,
      isDrift: true,
      canReplace: true,
    };
  }
  if (check.reason === "name_no_longer_exists") {
    return {
      kind: "gone",
      sentence: `El nombre ${name} ya no existe.`,
      consequence: `Tu destinatario de confianza sigue siendo ${check.storedAddress} y no lo cambié.`,
      observedAddress: null,
      isDrift: true,
      canReplace: false,
    };
  }
  // A `changed` shape this client does not recognize: it must not borrow the
  // wording of either known case, and it must not name a destination nobody
  // reported.
  return {
    kind: "changed_unknown",
    sentence: `El nombre ${name} ya no apunta a la dirección que guardaste.`,
    consequence: `No sabemos a qué dirección apunta ahora. Tu destinatario de confianza sigue siendo ${check.storedAddress} y no lo cambié.`,
    observedAddress: null,
    isDrift: true,
    canReplace: false,
  };
}
