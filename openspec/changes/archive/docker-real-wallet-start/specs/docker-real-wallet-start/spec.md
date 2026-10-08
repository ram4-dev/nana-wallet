# Requisitos

- Seleccionar proveedor explícitamente; rechazar fixture y configuración inválida antes de mutar Docker.
- No imprimir secretos ni usar env files como shell.
- Iniciar DB, aplicar migraciones una vez, LiveKit, API, worker y frontend; WDK reutiliza un volumen externo existente.
- Servir frontend/API/WS por una URL Portless, con MSW desactivado.
- Verificar modo live y lectura del proveedor; errores devuelven código no cero y no declaran éxito.
- No transferir, crear/desbloquear wallets ni borrar datos durante el arranque.
- Skill local discoverable y comandos verificables.
