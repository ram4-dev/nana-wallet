# 05 — Requisitos preservados del código borrado

Estas garantías estaban especificadas por los tests de
`src/wallet/transfer-pipeline.ts` (y su transporte `privy-transaction-transport.ts`),
que se **borraron por ser inalcanzables**: ningún módulo de producción los
importaba y la transferencia EVM está hoy fail-closed en
`PrivyUserWalletProvider`.

Se preservan acá como **requisitos**, para que la futura migración del camino de
transferencia EVM al SDK de Privy no tenga que redescubrirlos. El historial de
git conserva los tests originales si hace falta recuperar el detalle.

## R1 — Nunca exponer los bytes firmados

La transacción firmada **nunca** se surfacea al llamador ni a la UI. El usuario
ve el preview (monto, destino, red, fee estimado) y, tras confirmar, el hash y el
link al explorer. Los bytes firmados no salen del proceso que firma.

## R2 — Idempotencia por clave

Reenviar la **misma** clave de idempotencia devuelve **la misma operación** y
**no produce un segundo dispatch**. La clave es única por intento.

## R3 — Un solo ganador

Dos confirmaciones **concurrentes** del mismo preview: gana **exactamente una**.
La otra no dispatcha. (Se resolvía con un claim sobre la fila y estado
`broadcasting`.)

## R4 — Respuesta de FIRMA perdida: re-firmar el MISMO intent

Si se pierde la respuesta al firmar (no hubo dispatch), se reconcilia
**re-firmando el intent idéntico**. Es seguro porque no se envió nada.

## R5 — Respuesta de BROADCAST perdida: NUNCA re-broadcastear

Si se pierde la respuesta después de poder haber dispatchado, se reconcilia
**por el hash registrado**, y **jamás** se re-broadcastea ni se usa un nonce
nuevo. Sin hash conocido, la operación queda **incierta** y así se reporta.
Regla dura del repo: *un broadcast ambiguo no se reintenta a ciegas*.

## R6 — Rechazo ANTES de firmar

Se rechazan **antes de firmar**: cadena incorrecta, token incorrecto,
**destinatario fuera del allowlist**, y **monto por encima del tope** por
transferencia. La política de Privy es la segunda barrera; esta es la primera.

## R7 — Frontera de transporte live (solo para el camino fixture)

Con un cliente **live** no se permite avanzar: se rechaza **antes** de cualquier
claim en la base o firma del proveedor. El camino fixture nunca escala a live por
accidente.

## R8 — Aislamiento entre usuarios

Un usuario **nunca** puede leer ni reconciliar datos de operación, grant o wallet
de **otro** usuario (RLS por transacción con `userId`).

## Nota sobre el alcance de la migración EVM

Al migrar EVM al SDK, estos requisitos se re-implementan sobre
`privy.wallets()` / `privy.intents` — no se reviven como código propio. En
particular:

- R4/R5 se mapean al manejo de ambigüedad ya verificado en el camino Solana
  (`reconcileBroadcast` deja la referencia incierta y **nunca** re-broadcastea).
- R2 mapea a la clave de idempotencia del SDK.
- R3 necesita el claim atómico en la base, que **no** lo da el SDK.

## Estado del schema (NO se toca en este slice)

El pipeline era el único consumidor de:

- la tabla `wallet_operations` (104 filas históricas; ningún código vivo la lee)
- la columna `user_wallets.nonce`

Borrarlas es una **migración de schema aparte**, con su propio riesgo. Acá solo
se documenta que quedan huérfanas.
