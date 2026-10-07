import { useQuery, useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import type { Contact } from "@/lib/api-types";

/**
 * Trusted-recipient management for the wallet permission allowlist.
 *
 * Product decision (2026-09-10, wallet-profile scope): the payment-permission
 * allowlist is exactly the user's saved contacts (Q3), so adding a trusted
 * recipient here means creating a contact. The form lives INSIDE
 * "Administrar billetera" (WP-012): it never loads just by opening /mi-plata,
 * and the balance section is unaffected by its errors. The activation flow in
 * WalletLifecycle consumes the refreshed contacts automatically.
 */

export function AddTrustedRecipient({
  userId,
  onContactsChanged,
}: {
  userId: string | undefined;
  /** Called after a successful save so the parent can refresh its allowlist query. */
  onContactsChanged?: () => void;
}) {
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [network, setNetwork] = useState<"evm" | "solana-devnet">("evm");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const contactsQuery = useQuery({
    queryKey: queryKeys.contacts(userId),
    queryFn: api.getContacts,
    enabled: Boolean(userId),
  });

  function resetForm() {
    setName("");
    setAddress("");
    setNetwork("evm");
    setError(null);
  }

  async function saveRecipient(event: FormEvent) {
    event.preventDefault();
    const cleanName = name.trim();
    const cleanAddress = address.trim();
    if (!cleanName) {
      setError("Poné el nombre de la persona de confianza.");
      return;
    }
    if (!cleanAddress) {
      setError("Poné la dirección o el CBU.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      await api.createContact({
        name: cleanName,
        description: "",
        address: cleanAddress,
        ...(network === "solana-devnet" ? { network: "solana-devnet" } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.contacts(userId) });
      onContactsChanged?.();
      resetForm();
      setIsFormOpen(false);
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }

  async function removeRecipient(contact: Contact) {
    setError(null);
    try {
      await api.deleteContact(contact.id);
      await queryClient.invalidateQueries({ queryKey: queryKeys.contacts(userId) });
      onContactsChanged?.();
    } catch (deleteError) {
      setError(getErrorMessage(deleteError));
    }
  }

  const contacts = contactsQuery.data ?? [];

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
          onClick={() => {
            resetForm();
            setIsFormOpen(true);
          }}
          data-testid="add-recipient"
        >
          <UserPlus className="size-5" aria-hidden="true" />
          Agregar
        </Button>
      </div>

      {isFormOpen ? (
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
            placeholder="Dirección o CBU"
            aria-label="Dirección"
          />
          <label className="block space-y-1 text-sm font-bold" htmlFor="trusted-recipient-network">
            Red de la dirección
            <select
              id="trusted-recipient-network"
              value={network}
              onChange={(event) => setNetwork(event.target.value as "evm" | "solana-devnet")}
              className="min-h-12 w-full rounded-xl border border-input bg-background px-3 text-base"
            >
              <option value="evm">EVM (red configurada)</option>
              <option value="solana-devnet">Solana devnet</option>
            </select>
          </label>
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
              onClick={() => {
                resetForm();
                setIsFormOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button type="submit" className="press min-h-10 font-extrabold" disabled={isSaving}>
              {isSaving ? "Guardando" : "Guardar"}
            </Button>
          </div>
        </form>
      ) : null}

      {contacts.length === 0 ? (
        <p className="mt-3 text-base text-muted-foreground">
          Todavía no agregaste personas de confianza. Sin destinatarios no se puede activar el
          permiso de pagos.
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
                {contact.network === "solana-devnet" ? (
                  <span className="block text-xs font-bold text-brand-ink">Solana devnet</span>
                ) : null}
                <span className="block truncate text-xs text-muted-foreground">
                  {contact.address}
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                className="press min-h-9 shrink-0 text-sm font-bold text-destructive"
                onClick={() => void removeRecipient(contact)}
              >
                Quitar
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
