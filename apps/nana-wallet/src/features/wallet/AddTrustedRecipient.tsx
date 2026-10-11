import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, RotateCw, UserPlus } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, getErrorMessage, queryKeys } from "@/lib/api";
import type {
  Contact,
  ContactPermission,
  ContactRemovalPreview,
  RecipientAliasResolveResponse,
  ReverseDomainState,
} from "@/lib/api-types";

type EditorState = { contact?: Contact } | null;
type PendingRemoval = { contact: Contact; preview: ContactRemovalPreview } | null;
type PendingAddressChange = {
  contact: Contact;
  name: string;
  address: string;
  preview: ContactRemovalPreview;
} | null;

/**
 * Pre-chequeo del lado del cliente, y nada más: una dirección con forma de base58
 * pasa por acá, pero quien decide es el servidor. Un valor con un punto es un
 * CANDIDATO A NOMBRE (design §2.1): el camino de pegado sigue existiendo y nunca se
 * fuerza a nadie a usar la fuente más débil.
 */
const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isPlausibleSolanaAddress(address: string): boolean {
  return solanaAddressPattern.test(address);
}

function isNameCandidate(value: string): boolean {
  return value.trim().includes(".");
}

/**
 * Los tres estados del nombre principal, en su propia oración (design §2.4).
 *
 * `unknown` NUNCA se muestra como `none`: "no pudimos verificar si tiene un
 * nombre" no es "no tiene un nombre". Y `none` SÍ se muestra, aunque sea el estado
 * esperado en devnet: es un hecho de la cadena, no un fallo.
 */
function reverseDomainLine(state: ReverseDomainState, domain: string | null): string {
  switch (state) {
    case "present":
      return domain
        ? `El nombre principal de esta dirección es ${domain}.`
        : "El nombre principal de esta dirección es el que muestra la pantalla.";
    case "none":
      return "Esta dirección no tiene un nombre principal registrado.";
    case "unknown":
      return "No pudimos verificar si esta dirección tiene un nombre principal.";
  }
}

/**
 * La frescura se deriva de `resolvedAt` y es una ayuda de transparencia, nunca el
 * guard: lo que autoriza es la igualdad que el servidor vuelve a chequear.
 */
function freshnessLabel(resolvedAt: string, now: number = Date.now()): string {
  const age = now - new Date(resolvedAt).getTime();
  if (!Number.isFinite(age) || age < 60_000) return "Resuelto hace instantes";
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `Resuelto hace ${minutes} minuto${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `Resuelto hace ${hours} hora${hours === 1 ? "" : "s"}`;
}

/**
 * El servidor es dueño de estas oraciones (design §1.3): "no existe" y "no se pudo
 * consultar" llegan con mensajes distintos desde el contrato, así que la pantalla
 * las muestra tal cual en vez de inventar una segunda redacción que pueda
 * discrepar. El código se lee sólo para elegir el fallback cuando no hay mensaje.
 */
function aliasErrorMessage(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "RESOLVEDOR_NO_DISPONIBLE") {
    return (
      (error as Error).message || "No pudimos consultar el nombre en este momento. Probá de nuevo."
    );
  }
  return getErrorMessage(error);
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
  const [resolution, setResolution] = useState<RecipientAliasResolveResponse | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  /**
   * El aviso de duplicado sobrevive al guardado: es el RESULTADO del alta, no
   * parte del formulario, así que se muestra después de que el formulario se
   * cierra. Guarda la dirección con la que se guardó, porque la resolución del
   * formulario ya no está.
   */
  const [duplicateOf, setDuplicateOf] = useState<{ name: string; address: string } | null>(null);
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
    setResolution(null);
  }
  function openCreate() {
    setEditor({});
    setName("");
    setAddress("");
    setError(null);
    setResolution(null);
    setDuplicateOf(null);
  }
  function openEdit(contact: Contact) {
    setEditor({ contact });
    setDuplicateOf(null);
    setName(contact.name);
    setAddress(contact.address);
    setError(null);
    // La edición no resuelve nombres: cambia la dirección de un contacto que ya
    // existe, así que una resolución vieja no tiene nada que hacer acá.
    setResolution(null);
    setDuplicateOf(null);
  }

  /**
   * La búsqueda explícita del nombre (design §2.1). Sólo la pantalla pide esto:
   * es una LECTURA sin efectos, y una dirección resuelta todavía no es una
   * autorización — lo que autoriza es el `expectedAddress` que el usuario ve.
   */
  async function searchAlias() {
    const cleanAddress = address.trim();
    if (!isNameCandidate(cleanAddress)) return;
    setIsResolving(true);
    setError(null);
    try {
      setResolution(await api.resolveRecipientAlias({ name: cleanAddress }));
    } catch (resolveError) {
      // La última resolución NO se borra: si el resolver no responde, el usuario
      // sigue viendo qué dirección estaba confirmando y hace cuánto.
      setError(aliasErrorMessage(resolveError));
    } finally {
      setIsResolving(false);
    }
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
    const aliasArm = !editor?.contact && resolution !== null;
    if (!aliasArm && !isPlausibleSolanaAddress(cleanAddress))
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
      } else if (aliasArm && resolution) {
        // Variante alias: el servidor vuelve a resolver y compara. La dirección
        // guardada es la que resolvió ÉL; `expectedAddress` sólo puede vetar.
        const created = await api.createContact({
          name: cleanName,
          description: "",
          source: "sns",
          snsName: resolution.name,
          expectedAddress: resolution.address,
          network: "solana-devnet",
        });
        // Después de `resetEditor`: el aviso pertenece a la LISTA, no al
        // formulario que se acaba de cerrar.
        await refreshContacts();
        resetEditor();
        setDuplicateOf(
          created.duplicateOf
            ? { name: created.duplicateOf.name, address: resolution.address }
            : null,
        );
        return;
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
            onChange={(event) => {
              setAddress(event.target.value);
              // Cambiar el texto invalida la resolución anterior: lo que se
              // guarda tiene que ser lo que el usuario está viendo ahora.
              setResolution(null);
            }}
            placeholder="Dirección de Solana o nombre .sns"
            aria-label="Dirección"
          />
          {!editor.contact && isNameCandidate(address) ? (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                className="press min-h-10 w-full font-extrabold"
                onClick={() => void searchAlias()}
                disabled={isResolving}
              >
                {isResolving ? "Buscando" : resolution ? "Buscar otra vez" : "Buscar"}
              </Button>
              {resolution ? (
                <div className="space-y-1 rounded-xl border border-border bg-muted/40 p-3">
                  <p className="text-xs font-bold text-muted-foreground">
                    ¿La dirección que aparece acá es la correcta para {resolution.name}?
                  </p>
                  {/*
                    Entera y sin truncar: es la dirección que el usuario confirma,
                    así que no se abrevia ni se corta con puntos suspensivos.
                  */}
                  <p className="break-all font-mono text-sm font-bold" data-testid="alias-address">
                    {resolution.address}
                  </p>
                  <p className="text-xs text-muted-foreground" data-testid="alias-reverse-domain">
                    {reverseDomainLine(resolution.reverseDomainState, resolution.reverseDomain)}
                  </p>
                  <p className="text-xs text-muted-foreground" data-testid="alias-freshness">
                    {freshnessLabel(resolution.resolvedAt)}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">
            Pegá una dirección de Solana devnet, o buscá un nombre .sns y confirmá la dirección que
            resuelve.
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
            <Button
              type="submit"
              className="press min-h-10 font-extrabold"
              disabled={
                isSaving ||
                // Alta por nombre: hasta que el servidor no resuelva, no hay
                // dirección que confirmar, así que no hay nada que guardar.
                (!editor.contact && isNameCandidate(address) && resolution === null)
              }
            >
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
      {/* Fuera del formulario a propósito: el aviso es el RESULTADO del alta, y el
          formulario ya se cerró cuando se muestra. */}
      {duplicateOf ? (
        <p
          className="mt-3 rounded-xl border border-border bg-muted/40 p-3 text-sm"
          data-testid="duplicate-disclosure"
        >
          Esta dirección ya está en tu lista como {duplicateOf.name}: {duplicateOf.address} ya es de
          confianza, así que esto no cambia a quién le podés pagar.
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
                {/*
                  Sin `truncate` (task 5.4): la dirección es lo que la persona
                  tiene que poder leer y comparar entera. Una dirección cortada
                  con puntos suspensivos no se puede verificar mirándola.
                */}
                <span
                  className="block break-all text-xs text-muted-foreground"
                  data-testid={`contact-address-${contact.id}`}
                >
                  {contact.address}
                </span>
                {/*
                  Task 5.4 (design §3.2 C3): el alias es EVIDENCIA de dónde salió
                  la dirección, no la dirección. Sin alias no se dibuja nada: un
                  contacto pegado a mano no tiene origen que mostrar, y un
                  "sin alias" inventaría un hecho.
                */}
                {contact.alias ? (
                  <span
                    className="block break-all text-xs text-muted-foreground"
                    data-testid={`contact-alias-${contact.id}`}
                  >
                    Agregado por {contact.alias.name}
                  </span>
                ) : null}
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
