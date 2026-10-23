# 00 — Intake: Migración al SDK oficial de Privy

## Outcome

Reemplazar la integración Privy escrita a mano por el SDK oficial, de modo que el
agente (worker de LiveKit) pueda operar sobre la wallet embebida del usuario —EVM y
Solana— con límites aplicados por política de Privy, **sin que el worker tenga
acceso a ninguna clave privada de firma**.

## Acceptance evidence

- El worker firma/enviá usando `client.wallets` del SDK, no HTTP propio.
- Ningún proceso del backend lee `PRIVY_AUTHORIZATION_PRIVATE_KEY` directamente:
  la firma pasa por una función de firmado delegada (KMS/sidecar).
- La política de Privy limita efectivamente: tope por transferencia **y** tope
  acumulado por ventana (verificado empíricamente, no supuesto).
- Solana tiene signer y política configurados (hoy: vacío).
- Preview + confirmación explícita + idempotencia + verificación del payload
  siguen intactos.
- Suites: front (`lint`/`typecheck`/`test`) y raíz (`lint`/`typecheck`/`test`/`eval`).

## Granted authority

- Exploración e investigación: granted (hecha).
- Escritura de artefactos de planificación: granted.
- Mutación de código fuente: **pendiente** (requiere aprobar el outline).
- Cambios en el dashboard de Privy: **requieren al humano** (no hay API de escritura).

## Non-goals

- No habilitar `WDK_TOOLS_SOURCE=live` ni la wallet singleton.
- No migrar a otro proveedor de wallets.
- No cambiar el contrato de preview/confirmación que ve el usuario.
- No tocar mainnet.

## Riesgos conocidos

1. **La política puede no estar limitando al signer.** Sin verificar, habilitar la
   firma sería exponer fondos sin tope efectivo. Es la primera pregunta a cerrar.
2. **Solana está sin configurar**: `additional_signers: []` y sin políticas.
3. **Nuestro backend no chequea revocación**: acepta tokens que Privy considera
   inválidos (verificado). Afecta a todos los requests autenticados.

## Selected route

RPI (`$humanlayer-rpi-workflow`). Hay estado actual que documentar (hecho), una
decisión de arquitectura pendiente (modelo de firma) y un outline con slices.
