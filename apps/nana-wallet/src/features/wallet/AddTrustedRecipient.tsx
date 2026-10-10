import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, RotateCw, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import type { Contact, ContactPermission, ContactRemovalPreview } from "@/lib/api-types";

type EditorState = { contact?: Contact } | null;
type PendingRemoval = { contact: Contact; preview: ContactRemovalPreview } | null;
type PendingAddressChange = {
  contact: Contact;
  name: string;
  address: string;
  preview: ContactRemovalPreview;
} | null;

const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isPlausibleSolanaAddress(address: string): boolean {
  return solanaAddressPattern.test(address);
}

/**
 * Deliberately duplicated across the front/back boundary (`AGENTS.md`): the
 * backend names this status reason in `src/config/recipient-policy.ts`, and the
 * frontend may not import from the root `src/`.
 */
const POLICY_WRITER_FROZEN_REASON = "policy_writer_frozen";

function permissionLabel(permission: ContactPermission): string {
  // Design §13: a frozen writer still persists the recipient as saved-not-enabled
  // and "every surface reports the frozen state". The state alone cannot say it —
  // a frozen deployment records `pending` with this reason — so the reason is
  // read here and the wording never claims the recipient is on.
  if (permission.reason === POLICY_WRITER_FROZEN_REASON) {
    return "Guardado, con los pagos automáticos pausados";
  }
  switch (permission.state) {
    case "saved_not_configured":
      return "Guardado, sin permiso configurado";
    case "pending":
      return "Guardado, esperando verificación";
    case "syncing":
      return "Verificando el permiso";
    case "applied":
      return "Habilitado tras la verificación";
    case "retryable_failure":
      return "No pudimos verificar el permiso todavía";
    case "blocked_conflict":
      return "El permiso necesita revisión";
    case "blocked_configuration":
      return "El permiso no está configurado";
  }
}

/** Solana-only contact management with an honest, readback-backed permission state. */
export function AddTrustedRecipient({
  userId,
  onContactsChanged,
}: {
  userId: string | undefined;
  onContactsChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<EditorState>(null);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval>(null);
  const [pendingAddressChange, setPendingAddressChange] = useState<PendingAddressChange>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(userId),
    queryFn: api.getContacts,
    enabled: Boolean(userId),
  });

  function resetEditor() {
    setEditor(null);
    setName("");
    setAddress("");
    setError(null);
  }
  function openCreate() {
    setEditor({});
    setName("");
    setAddress("");
    setError(null);
  }
  function openEdit(contact: Contact) {
    setEditor({ contact });
    setName(contact.name);
    setAddress(contact.address);
    setError(null);
  }
  async function refreshContacts() {
    await queryClient.invalidateQueries({ queryKey: queryKeys.contacts(userId) });
    onContactsChanged?.();
  }

  async function saveRecipient(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanAddress = address.trim();
    if (!cleanName) return setError("Poné el nombre de la persona de confianza.");
    if (!isPlausibleSolanaAddress(cleanAddress))
      return setError("Pegá una dirección válida de Solana.");
    setIsSaving(true);
    setError(null);
    try {
      if (editor?.contact) {
        if (cleanAddress !== editor.contact.address) {
          const preview = await api.getContactRemovalPreview(
            editor.contact.id,
            editor.contact.version,
            "address_change",
          );
          setPendingAddressChange({
            contact: editor.contact,
            name: cleanName,
            address: cleanAddress,
            preview,
          });
          return;
        }
        await updateContact(editor.contact, cleanName, cleanAddress, []);
      } else {
        await api.createContact({
          name: cleanName,
          description: "",
          address: cleanAddress,
          network: "solana-devnet",
        });
      }
      await refreshContacts();
      resetEditor();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function updateContact(
    contact: Contact,
    nextName: string,
    nextAddress: string,
    expectedRevokedGrantIds: string[],
  ) {
    await api.updateContact(contact.id, {
      name: nextName,
      address: nextAddress,
      network: "solana-devnet",
      expectedVersion: contact.version,
      expectedPolicyRevision: contact.permission.desiredRevision,
      ...(nextAddress !== contact.address ? { expectedRevokedGrantIds } : {}),
    });
  }

  async function confirmAddressChange() {
    if (!pendingAddressChange) return;
    setIsSaving(true);
    setError(null);
    try {
      await updateContact(
        pendingAddressChange.contact,
        pendingAddressChange.name,
        pendingAddressChange.address,
        pendingAddressChange.preview.revokedGrantIds,
      );
      setPendingAddressChange(null);
      await refreshContacts();
      resetEditor();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function requestRemoval(contact: Contact) {
    setError(null);
    try {
      setPendingRemoval({
        contact,
        preview: await api.getContactRemovalPreview(contact.id, contact.version),
      });
    } catch (removeError) {
      setError(getErrorMessage(removeError));
    }
  }
  async function confirmRemoval() {
    if (!pendingRemoval) return;
    setIsRemoving(true);
    setError(null);
    try {
      await api.deleteContact(pendingRemoval.contact.id, {
        expectedVersion: pendingRemoval.contact.version,
        expectedRevokedGrantIds: pendingRemoval.preview.revokedGrantIds,
      });
      setPendingRemoval(null);
      await refreshContacts();
    } catch (removeError) {
      setError(getErrorMessage(removeError));
    } finally {
      setIsRemoving(false);
    }
  }
  async function retryPermission() {
    setIsRetrying(true);
    setError(null);
    try {
      await api.retryRecipientPolicy();
      await refreshContacts();
    } catch (retryError) {
      setError(getErrorMessage(retryError));
    } finally {
      setIsRetrying(false);
    }
  }

  const contacts = contactsQuery.data ?? [];
  const retryable = contacts.some((contact) => contact.permission.retryable);
  return (
    <section aria-label="Destinatarios de confianza">
      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-bold text-muted-foreground">
          Destinatarios de confianza ({contacts.length})
        </p>
        <Button
          type="button"
          variant="outline"
          className="press min-h-10 shrink-0 text-sm font-extrabold"
          onClick={openCreate}
          data-testid="add-recipient"
        >
          <UserPlus className="size-5" aria-hidden="true" />
          Agregar
        </Button>
      </div>
      {editor ? (
        <form
          onSubmit={saveRecipient}
          className="mt-3 space-y-3 rounded-2xl border border-border bg-card p-4"
        >
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nombre"
            aria-label="Nombre"
          />
          <Input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Dirección de Solana"
            aria-label="Dirección"
          />
          <p className="text-sm text-muted-foreground">
            Solo podés agregar direcciones de Solana devnet.
          </p>
          {error ? (
            <p className="text-base font-bold text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="press min-h-10 font-extrabold"
              onClick={resetEditor}
            >
              Cancelar
            </Button>
            <Button type="submit" className="press min-h-10 font-extrabold" disabled={isSaving}>
              {isSaving ? "Guardando" : editor.contact ? "Guardar cambios" : "Guardar"}
            </Button>
          </div>
        </form>
      ) : null}
      {error && !editor ? (
        <p className="mt-3 text-base font-bold text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {pendingRemoval ? (
        <div
          className="mt-3 rounded-2xl border border-destructive/40 bg-destructive-surface p-4"
          role="alertdialog"
          aria-label="Confirmar eliminación de destinatario"
        >
          <p className="text-base font-extrabold">
            ¿Querés quitar a {pendingRemoval.contact.name}?
          </p>
          {pendingRemoval.preview.revokedGrantIds.length > 0 ? (
            <p className="mt-2 text-sm">
              También se revocarán {pendingRemoval.preview.revokedGrantIds.length} pago
              {pendingRemoval.preview.revokedGrantIds.length === 1
                ? " automático"
                : "s automáticos"}{" "}
              asociado{pendingRemoval.preview.revokedGrantIds.length === 1 ? "" : "s"}. La
              revocación queda pendiente hasta que Privy la verifique.
            </p>
          ) : (
            <p className="mt-2 text-sm">No hay pagos automáticos que revocar.</p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={() => setPendingRemoval(null)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmRemoval()}
              disabled={isRemoving}
            >
              {isRemoving ? "Quitando" : "Quitar"}
            </Button>
          </div>
        </div>
      ) : null}
      {pendingAddressChange ? (
        <div
          className="mt-3 rounded-2xl border border-destructive/40 bg-destructive-surface p-4"
          role="alertdialog"
          aria-label="Confirmar cambio de dirección"
        >
          <p className="text-base font-extrabold">
            ¿Querés cambiar la dirección de {pendingAddressChange.contact.name}?
          </p>
          {pendingAddressChange.preview.revokedGrantIds.length > 0 ? (
            <p className="mt-2 text-sm">
              Este cambio revocará {pendingAddressChange.preview.revokedGrantIds.length} pago
              {pendingAddressChange.preview.revokedGrantIds.length === 1
                ? " automático"
                : "s automáticos"}{" "}
              asociado{pendingAddressChange.preview.revokedGrantIds.length === 1 ? "" : "s"}. La
              revocación queda pendiente hasta que Privy la verifique.
            </p>
          ) : (
            <p className="mt-2 text-sm">No hay pagos automáticos que revocar.</p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" onClick={() => setPendingAddressChange(null)}>
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmAddressChange()}
              disabled={isSaving}
            >
              {isSaving ? "Guardando" : "Confirmar cambio"}
            </Button>
          </div>
        </div>
      ) : null}
      {contacts.length === 0 ? (
        <p className="mt-3 text-base text-muted-foreground">
          Todavía no agregaste personas de confianza.
        </p>
      ) : (
        <ul className="lg-row-list mt-3">
          {contacts.map((contact) => (
            <li key={contact.id} className="lg-row">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-sm font-extrabold text-brand-ink"
                aria-hidden="true"
              >
                {contact.name.charAt(0).toLocaleUpperCase("es-AR")}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-bold">{contact.name}</span>
                <span className="block text-xs font-bold text-brand-ink">Solana devnet</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {contact.address}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {permissionLabel(contact.permission)}
                </span>
              </span>
              <span className="flex shrink-0 flex-col gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  className="press min-h-9 text-sm font-bold"
                  onClick={() => openEdit(contact)}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="press min-h-9 text-sm font-bold text-destructive"
                  onClick={() => void requestRemoval(contact)}
                >
                  Quitar
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {retryable ? (
        <Button
          type="button"
          variant="outline"
          className="press mt-3 min-h-10 font-extrabold"
          onClick={() => void retryPermission()}
          disabled={isRetrying}
        >
          {isRetrying ? (
            <Loader2 className="size-5 animate-spin" aria-hidden="true" />
          ) : (
            <RotateCw className="size-5" aria-hidden="true" />
          )}
          Reintentar verificación
        </Button>
      ) : null}
    </section>
  );
}
