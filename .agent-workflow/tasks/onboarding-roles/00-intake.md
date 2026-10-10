# Onboarding de persona usuaria y responsable

Estado: investigación y PRD en borrador. No hay aprobación de implementación.

## Resultado buscado

Al entrar a Nana Wallet, una persona elige si viene a usar su propia billetera o a acompañar a otra persona. La persona usuaria conserva el ingreso actual con Privy. El responsable tiene su propio ingreso y puede consultar contactos, transacciones y límites, y gestionar las políticas que se le autoricen, una vez vinculadas ambas identidades.

## Autoridad y límites

- Pedido directo de Ramiro del 2026-10-10: diseñar el onboarding, en una rama y worktree totalmente aislados, trayendo los cambios de `feat/solana-operational`.
- Se autoriza investigar y escribir artefactos de diseño. No se pidió implementar el onboarding en esta etapa.
- Base: `feat/solana-operational` en `337122b1641876b0a8ff4054c78f3000ace33cc2`.
- Rama: `feat/onboarding-roles`; worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-onboarding-roles`.
- El archivo local y no versionado `compose.privy-local.ports.yaml` queda en el worktree de origen: no es código de producto ni hace falta para diseñar.
- Respetar la separación backend/frontend, una sola configuración Solana devnet, Privy y el preview/confirmación antes de mover dinero.

## Ruta y puerta actual

Ruta HumanLayer: PRD/TDD, porque hay decisiones de identidad, delegación y alcance de permisos que no se deducen del código. Puerta actual: aprobar el PRD completo después de resolver quién es titular de la cuenta y cómo se vincula al responsable. Luego se diseñan sistema y programa en puertas separadas. SDD queda para una eventual implementación aprobada.

## Fuera de alcance de esta etapa

- Cambiar autenticación, permisos o políticas en producción.
- Crear billeteras, transferir fondos o ampliar permisos de firma durante la investigación.
- Integrar esta rama con `main` o con la rama de sincronización.
