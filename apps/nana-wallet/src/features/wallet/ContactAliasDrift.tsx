import { useState } from "react";

import { Button } from "@/components/ui/button";
import { api, getErrorMessage } from "@/lib/api";
import type { Contact } from "@/lib/api-types";

import { driftReport, type AliasDriftReport } from "./contact-alias-drift";

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "report"; report: AliasDriftReport; storedAddress: string }
  | { kind: "failed"; message: string };

/**
 * The drift notice for one alias-sourced contact (task 7.2, design §5.4).
 *
 * The check is EXPLICIT and user-initiated: rendering this component issues no
 * request at all, because the check is the one call in this flow that can leave
 * a record on the server (`provenance.drift`). A notice that checked by itself
 * would be a write behind the user's back.
 *
 * Nothing here changes the destination. The frozen address stays frozen, the
 * alias provenance stays as it was, and a payment to this recipient is never
 * refused because of what the notice says: "keep" is a local dismissal that
 * sends nothing, and "replace" and "remove" only OPEN the existing, disclosed,
 * confirmed paths in the parent — the same ones the edit form and the row's
 * "Quitar" button open.
 */
export function ContactAliasDrift({
  contact,
  onReplace,
  onRemove,
}: {
  contact: Contact;
  /** Opens the existing, disclosed address-replacement path in the parent. */
  onReplace: (contact: Contact, observedAddress: string) => void;
  /** Opens the existing, confirmed removal path in the parent. */
  onRemove: (contact: Contact) => void;
}) {
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [kept, setKept] = useState(false);

  const aliasName = contact.alias?.name;
  if (!aliasName) return null;

  async function runCheck() {
    setKept(false);
    setCheck({ kind: "checking" });
    try {
      const result = await api.checkContactAlias(contact.id);
      setCheck({
        kind: "report",
        report: driftReport(result, aliasName as string, contact.name),
        storedAddress: result.storedAddress,
      });
    } catch (error) {
      // A refusal is its own outcome and never an empty notice.
      setCheck({ kind: "failed", message: getErrorMessage(error) });
    }
  }

  const report = check.kind === "report" ? check.report : null;
  return (
    <div className="mt-1 space-y-1">
      <Button
        type="button"
        variant="ghost"
        className="press min-h-9 px-0 text-xs font-bold"
        onClick={() => void runCheck()}
        disabled={check.kind === "checking"}
        data-testid={`alias-drift-check-${contact.id}`}
      >
        {check.kind === "checking"
          ? "Chequeando"
          : report
            ? "Chequear otra vez"
            : "Chequear el nombre"}
      </Button>
      {check.kind === "failed" ? (
        <p className="text-sm font-bold text-destructive" role="alert">
          {check.message}
        </p>
      ) : null}
      {report && check.kind === "report" ? (
        <div
          className="space-y-1 rounded-xl border border-border bg-muted/40 p-3"
          data-testid={`alias-drift-notice-${contact.id}`}
        >
          <p className="text-sm font-bold" data-testid={`alias-drift-sentence-${contact.id}`}>
            {report.sentence}
          </p>
          {report.observedAddress ? (
            <p className="text-xs font-bold" data-testid={`alias-drift-observed-${contact.id}`}>
              {report.observedAddress}
            </p>
          ) : null}
          <p
            className="text-xs text-muted-foreground"
            data-testid={`alias-drift-consequence-${contact.id}`}
          >
            {report.consequence}
          </p>
          {/*
            The stored address is always on screen, whole: the person deciding
            has to be able to read the destination they are keeping, not compare
            two strings by eye.
          */}
          <p
            className="break-all text-xs text-muted-foreground"
            data-testid={`alias-drift-stored-${contact.id}`}
          >
            {check.storedAddress}
          </p>
          {kept ? (
            <p className="text-xs font-bold">Listo: no cambié nada.</p>
          ) : report.isDrift ? (
            <div className="flex flex-col gap-1 pt-1">
              <Button
                type="button"
                variant="outline"
                className="press min-h-9 text-xs font-bold"
                onClick={() => setKept(true)}
              >
                Dejar como está
              </Button>
              {report.canReplace && report.observedAddress ? (
                <Button
                  type="button"
                  variant="outline"
                  className="press min-h-9 text-xs font-bold"
                  onClick={() => onReplace(contact, report.observedAddress as string)}
                >
                  Cambiar a la nueva dirección
                </Button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="press min-h-9 text-xs font-bold text-destructive"
                onClick={() => onRemove(contact)}
              >
                Quitar a {contact.name}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
