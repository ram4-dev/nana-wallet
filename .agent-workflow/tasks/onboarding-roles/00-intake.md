# Onboarding de persona usuaria y responsable

Estado: PRD, TDD y outline aprobados; implementación autorizada por Ramiro el 2026-10-10. Ejecución por SDD en el worktree aislado.

## Resultado buscado

Al entrar a Nana Wallet, una persona elige si viene a usar su propia billetera o a acompañar a otra persona. La persona usuaria conserva el ingreso actual con Privy. El responsable tiene su propio ingreso y puede consultar contactos, transacciones y límites, y gestionar las políticas que se le autoricen, una vez vinculadas ambas identidades.

## Autoridad y límites

- Pedido directo de Ramiro del 2026-10-10: diseñar el onboarding, en una rama y worktree totalmente aislados, trayendo los cambios de `feat/solana-operational`.
- Ramiro aprobó el PRD completo, el diseño de sistema, el diseño de programa y el outline; después indicó «sí confirmo, seguí hasta terminar», autorizando implementar y verificar la feature dentro de este worktree.
- Base: `feat/solana-operational` en `337122b1641876b0a8ff4054c78f3000ace33cc2`.
- Rama: `feat/onboarding-roles`; worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-onboarding-roles`.
- El archivo local y no versionado `compose.privy-local.ports.yaml` queda en el worktree de origen: no es código de producto ni hace falta para diseñar.
- Respetar la separación backend/frontend, una sola configuración Solana devnet, Privy y el preview/confirmación antes de mover dinero.

## Ruta y puerta actual

Ruta HumanLayer: PRD/TDD, porque hay decisiones de identidad, delegación y alcance de permisos que no se deducen del código. Puertas PRD, diseño de sistema, diseño de programa y outline aprobadas. Puerta actual: verificar las capacidades de Privy y LiveKit del Slice 0; si una condición de seguridad falla, bloquear esa capacidad y reabrir el diseño pertinente. Implementación por SDD en `openspec/changes/onboarding-roles/`.

## Fuera de alcance de esta etapa

- Cambiar políticas reales de Privy o fondos sin revisar la mutación exacta y su impacto.
- Transferir fondos, crear billeteras reales o ampliar permisos de firma durante el Slice 0.
- Integrar esta rama con `main` o con la rama de sincronización.
