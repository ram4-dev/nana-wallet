# Outline de implementación: onboarding de persona usuaria y responsable

Estado: **propuesto para revisión**. Base: PRD revisión 3 aprobado y TDD de sistema/programa revisión 1 aprobados en `03-prd.md` y `04-tdd.md`. Worktree aislado `feat/onboarding-roles`. Este outline no autoriza ejecutar código, migraciones, políticas remotas ni mover fondos.

## Criterio de entrega

El resultado completo es observable con dos DIDs Privy distintos: un responsable invita por correo, la persona usuaria ve y escucha la invitación al entrar, acepta, el responsable ve sólo los perfiles vinculados y gestiona contactos y límite ordinario, y la persona usuaria ve cada cambio y puede revocar. El responsable no puede transferir ni por UI, HTTP, texto o voz. El valor `unlimited` no toca las reglas de grants y no se anuncia aplicado hasta un readback remoto verificable. La wallet y el flujo actual de transferencias de la persona usuaria siguen funcionando.

Cada slice se inicia desde el HEAD verificado del worktree aislado y termina en un commit de trabajo con evidencia en `90-verification.md`. Si cambia una decisión del PRD/TDD, se detiene el slice y se reabre la puerta correspondiente; no se corrige el desacuerdo sólo en código. La implementación futura sigue `openspec/changes/onboarding-roles/` (`proposal → spec → design → tasks → apply → verify → archive`) conforme a `AGENTS.md`.

## Slice 0 — pruebas de capacidad y presupuesto de riesgo

- **Resultado observable:** un informe reproducible establece qué ofrece realmente la versión instalada de Privy para leer correo vinculado verificado, obtener consentimiento nuevo del titular, conservar firmante y políticas al editar, y expresar una allowlist Solana sin `Transfer.lamports`. Otro ensayo identifica el camino TTS y la señal de fin/interrupción de reproducción de la versión instalada de LiveKit. No toca ninguna billetera real ni cambia reglas remotas.
- **Archivos previstos:** `02-research.md` y `90-verification.md`; tests/probes aislados en `tests/unit/` o `tests/integration/` sólo si el transporte simulado permite probar la composición. Referencias de implementación: `src/wallet/policy/probe.ts`, `src/wallet/policy/composer.ts`, `src/livekit/create-agent-session.ts`.
- **Checks automáticos:** prueba de transporte fake con respuesta aceptada/rechazada/ambigua; aserciones de que falta de prueba deja `contacts.write` y `limits.write` cerrados. Lint, typecheck y build si se añade código de probe.
- **E2E/real route y manual:** inspeccionar respuesta real de SDK sólo con identidad de prueba y sin PATCH de la política activa; confirmar audio de una frase de prueba aislada. Registrar versión, método y resultado, sin secretos.
- **Stop:** si Privy no demuestra consentimiento inicial que permita cambios posteriores del responsable sin aprobación por cambio, el alcance de escritura se bloquea en `accepted_pending_policy_authorization` y se vuelve al diseño. Si una allowlist sin cap no puede probarse, `unlimited` queda bloqueado. Si no hay señal fiable de playout, no se arma decisión por voz.

## Slice 1 — invitaciones, identidad y vínculo

- **Resultado observable:** responsable autenticado invita un correo sin descubrir si existe cuenta. El usuario que verifica ese correo ve la invitación y acepta o rechaza una sola vez. Aceptar crea un vínculo de lectura, todavía sin autoridad para cambiar políticas; revocar corta acceso futuro.
- **Archivos previstos:** migraciones espejo en `src/db/migrations/` y `supabase/migrations/`; servicio nuevo `src/guardians/` para invitación, identidad de correo, relación y capacidades; `src/api/` para rutas; `src/contracts/http.ts`, `src/server.ts`, `src/auth/privy-identity.ts` sólo si hace falta extender el acceso al DID verificado.
- **Checks automáticos:** migración desde esquema vacío y actual, paridad entre espejos, RLS; integración con dos DIDs, correo sin cuenta, correo no verificado, expiración, replay, idempotencia, varios responsables y varios beneficiarios, decisión/revocación concurrente. Lint, typecheck, build, unit e integración con Postgres.
- **E2E/real route y manual:** llamadas HTTP autenticadas de dos sesiones de prueba, con 401/403/404/409 correctos; inspeccionar que la respuesta pública no enumera correos.
- **Stop:** nunca crear relación por coincidencia de un correo enviado desde navegador; no avanzar si una relación pendiente permite datos ajenos o si un vínculo revocado sigue autorizando alguna ruta.

## Slice 2 — entrada y lectura administrada

- **Resultado observable:** dos caminos de ingreso, invitación visible al comienzo y panel de responsable con personas vinculadas. El responsable lee contactos, historial y límite del sujeto elegido; cambiar de sujeto no muestra datos anteriores. El perfil propio del usuario sigue intacto.
- **Archivos previstos:** `apps/nana-wallet/src/routes/login.tsx`, `__root.tsx`, `index.tsx`, `perfil.tsx`, tarjeta/panel nuevos en `apps/nana-wallet/src/features/`, `apps/nana-wallet/src/lib/api.ts` y `api-types.ts`; rutas estrechas en `src/api/managed-people.ts`; servicio de acceso en `src/guardians/`.
- **Checks automáticos:** matriz actor/sujeto/capacidad y RLS, caché aislada por actor/sujeto/versión, cancelación al cambiar perfil o cerrar sesión; lint, typecheck, build y tests de front/back.
- **E2E/real route y manual:** browser E2E con responsable, dos personas a cargo y un tercero sin vínculo; aceptar invitación, alternar perfiles, revocar con panel abierto y comprobar rechazo de la siguiente lectura. Revisar lectura en pantalla pequeña.
- **Stop:** ninguna ruta administrada devuelve firma, grants ejecutables, preview o token de room de una persona ajena. El acceso al perfil propio no puede sincronizar una wallet ajena.

## Slice 3 — invitación narrada por Nani

- **Resultado observable:** al entrar con voz, Nani pronuncia la invitación canónica antes del saludo y pregunta si vincular; un «sí» final, autenticado y posterior al audio decide sólo esa invitación. La tarjeta sigue disponible si la voz falla.
- **Archivos previstos:** `src/livekit/worker.ts`, `create-agent-session.ts`, `voice-decision-gate.ts` o módulo de invitación nuevo, `src/conversations/confirmation-arbiter.ts`, catálogo de herramientas de `src/agent/definition.ts`, tests LiveKit y evals del agente; `apps/nana-wallet/src/features/agent/` para estado de entrada.
- **Checks automáticos:** transcript anterior al playout, de otro participante, interrumpido, no final, repetido o referido a transferencia/contacto no consume la invitación; CAS persistido tras reinicio. Lint, typecheck, build, unit, integración y `npm run eval`.
- **E2E/real route y manual:** LiveKit E2E con audio, verificar texto escuchado, orden de playout, respuesta «sí» y rechazo de un «sí» de otra ventana; caída de TTS deja tarjeta accionable.
- **Stop:** no abrir la ventana por `generateReply` o por una frase que el modelo podría haber omitido; no permitir que una aceptación de invitación confirme una transferencia.

## Slice 4 — autoridad de políticas y límite ordinario

- **Resultado observable:** tras el consentimiento nuevo del titular y su readback, la relación pasa a `active`. El responsable puede gestionar contactos y fijar/quitar el límite ordinario. Cada acción muestra deseado vs aplicado, antes/después y notificación al titular. Rechazo o timeout remoto no se reporta como aplicado.
- **Archivos previstos:** migraciones espejo para consentimiento, límite tipado, intención y auditoría; `src/wallet/policy/{composer,service,reconciler,repository,readback}.ts`, `src/wallet/grants/solana-enrollment-rules.ts`, `src/wallet/embedded.ts`, `src/api/managed-people.ts`, contratos HTTP y tipos espejo, UI de límites/contactos y notificaciones. Los topes de grants en `src/conversations/service.ts`, `src/contracts/http.ts` y `src/wallet/grants/consumption.ts` se revisan para asegurar separación, sin ampliarlos.
- **Checks automáticos:** tests de compositor `capped/unlimited`, preservación de `Transfer.to`, grants, firmantes y restricciones no reconocidas; revisión deseada/aplicada, readback, retry GET-before-PATCH, rechazo definitivo, incertidumbre, cambio concurrente, revocación durante aplicación y auditoría por actor. Lint, typecheck, build, unit, integración con Postgres y tests front.
- **E2E/real route y manual:** transporte Privy controlado de extremo a extremo; browser E2E para cambio de contacto y límite, notificación y revocación. Una prueba sobre wallet real sólo se agenda tras revisar la mutación exacta y su impacto; el outline no la autoriza.
- **Stop:** no tocar la política remota si falta prueba de consentimiento o de allowlist sin cap; no borrar política ni desanclar firmante para simular `unlimited`; no informar éxito sin readback.

## Slice 5 — agente del responsable y cierre del recorrido

- **Resultado observable:** el responsable puede pedirle a Nani consultas y cambios permitidos del perfil elegido; ninguna herramienta de transferencia, confirmación, grants o firma está disponible en ese modo. La persona usuaria puede revocar y la siguiente acción del responsable queda denegada. El recorrido completo pasa de ingreso a notificación final.
- **Archivos previstos:** `src/agent/definition.ts`, `src/agent/wallet-agent.ts`, `src/livekit/realtime-tools/create-realtime-tools.ts`, `src/livekit/worker.ts`, rutas de voz/texto para perfil administrado con binding explícito; `apps/nana-wallet/src/features/agent/` y panel administrado; tests y evals.
- **Checks automáticos:** matriz completa de herramientas/endpoints para actor propio, responsable activo, pendiente y revocado; bypass manual de HTTP, texto y voz; regresión de preview/confirmación de la wallet propia; lint, typecheck, build, unit, integración, front y evals.
- **E2E/real route y manual:** browser + LiveKit E2E de dos DIDs: invitación, narración, aceptación, lectura, cambio de contacto/límite, notificación, intento de pago del responsable rechazado, transferencia propia normal y revocación. Comprobar visualmente el nombre del sujeto y los estados pendientes.
- **Stop:** no cerrar la feature si una herramienta del responsable prepara o envía dinero, si una respuesta de voz sirve para otro tipo de decisión, o si un cambio de política ambiguo aparece como aplicado.

## Verificación y siguiente puerta

La evidencia final irá a `90-verification.md`: comando, resultado, entorno, fallos preexistentes diferenciados, E2E manual y límites de prueba. El outline se presenta para revisión del contenido y de las paradas. Aun aprobado, según la regla de la skill, su feedback no autoriza implementación por sí solo; el trabajo de código necesitará una autorización de ejecución explícita y los artefactos SDD aprobados.

Gate ID: onboarding-roles-outline-r1
Decision / allowed mutation: aprobar secuencia, resultado observable y condiciones de parada de los slices.
Explicit exclusions: código, migraciones ejecutadas, políticas remotas, fondos, push o merge.
Owning artifact / revision or hash: este outline revisión 1.
Decision owner: Ramiro.
Approved by / trusted identity: —
Approved at: —
Status: proposed
Invalidated by: —
