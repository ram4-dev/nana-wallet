# Crear y habilitar la wallet WDK del agente

Esta guía crea una wallet **dedicada exclusivamente al demo en Sepolia**. El agente nunca recibe la seed, private key ni passphrase: una persona crea y desbloquea la wallet, y `wdk-mcp` usa temporalmente la sesión local del WDK daemon.

> Ejecutá los comandos en una terminal privada. `wallet create` muestra la seed; nunca copies esa salida en Git, `.env`, logs, CI, capturas, chats o agentes de IA.

## Flujo rápido

1. Crear la wallet con una passphrase fuerte.
2. Respaldar la seed offline y guardar la passphrase por separado.
3. Seleccionarla como wallet predeterminada.
4. Desbloquearla con un TTL corto.
5. Obtener la dirección pública de Sepolia.
6. Fondearla únicamente con test USD₮ y el ETH de prueba necesario para gas.
7. Bloquearla inmediatamente después del demo.

## 1. Verificar la instalación

Desde la raíz del repositorio:

```bash
node --version
./node_modules/.bin/wdk --version
./node_modules/.bin/wdk --help
```

Requisitos del proyecto:

- Node.js `>=22.18.0`.
- `@tetherto/wdk-cli@1.0.0-beta.2`.
- Wallet separada de cualquier wallet personal o con fondos reales.

## 2. Crear la wallet

```bash
./node_modules/.bin/wdk wallet create --name agent-dev --words 12
```

WDK pedirá una passphrase y mostrará la seed una sola vez.

- Usá una passphrase fuerte y no vacía.
- Guardá la seed mediante un procedimiento offline aprobado.
- Guardá la passphrase separada de la seed.
- No uses `--json`: incluiría la seed en una salida estructurada fácil de registrar accidentalmente.

## 3. Seleccionar y comprobar la wallet

```bash
./node_modules/.bin/wdk wallet default --name agent-dev
./node_modules/.bin/wdk wallet list
```

`wallet list` debe mostrar `agent-dev` como predeterminada y bloqueada.

## 4. Desbloquear con TTL corto

```bash
./node_modules/.bin/wdk wallet unlock --name agent-dev --ttl 5
```

La passphrase se ingresa en el prompt oculto. El TTL es absoluto: usar la wallet no lo renueva. No uses `--ttl 0` para el demo.

Mientras la wallet está desbloqueada, cualquier proceso ejecutado por el mismo usuario del sistema operativo que pueda acceder al socket del daemon puede solicitar operaciones. Cerrá software no confiable antes del unlock.

## 5. Obtener la dirección pública

```bash
./node_modules/.bin/wdk get address --network sepolia --wallet agent-dev
```

La dirección pública sí puede compartirse con el equipo y utilizarse para fondeo y configuración. No revela la seed ni la private key.

## 6. Preparar fondos de prueba

La wallet necesita:

- Test USD₮ en Sepolia para el balance, preview y transferencia del demo.
- Una cantidad pequeña de Sepolia ETH exclusivamente para pagar gas.

Antes de continuar, verificá que el token registrado sea `usdt`:

```bash
./node_modules/.bin/wdk token info --network sepolia --token usdt
./node_modules/.bin/wdk get balance --network sepolia --token usdt --wallet agent-dev
```

Nunca sustituyas USD₮ por ETH como activo del producto. ETH es sólo gas.

## 7. Cómo accede el agente

El agente inicia el servidor MCP incluido en la CLI:

```text
Agente → wdk-mcp → socket local → WDK daemon → Sepolia
```

No existe una API key entre el agente y `wdk-mcp`. La autorización efectiva es la sesión local creada por `wallet unlock`:

- El agente no conoce la passphrase.
- El agente no puede crear, importar, exportar, desbloquear o borrar wallets mediante MCP.
- Con la wallet desbloqueada, puede llamar `get_address`, `get_balance`, `get_history` y `send_token`.
- `send_token` debe ejecutarse primero con `dryRun: true`.
- `dryRun: false` requiere confirmación humana de red, token, receptor, monto y fee.

La confirmación es un control de nuestra aplicación; el daemon no exige una segunda passphrase antes de firmar.

## 8. Cerrar la sesión

Después del demo o ante cualquier error:

```bash
./node_modules/.bin/wdk wallet lock --name agent-dev
./node_modules/.bin/wdk wallet list
```

Confirmá que `agent-dev` figure bloqueada. También podés bloquear todas las wallets:

```bash
./node_modules/.bin/wdk wallet lock --all
```

## Checklist antes de un broadcast

- [ ] Wallet `agent-dev` dedicada y con fondos limitados.
- [ ] Seed respaldada offline; passphrase guardada por separado.
- [ ] TTL corto y procesos no confiables cerrados.
- [ ] Red exacta: `sepolia`.
- [ ] Token exacto: `usdt`.
- [ ] ETH utilizado sólo para gas.
- [ ] Dirección receptora controlada y verificada.
- [ ] Monto pequeño de test USD₮.
- [ ] Preview `dryRun: true` revisado.
- [ ] Confirmación humana explícita antes de `dryRun: false`.
- [ ] Wallet bloqueada y estado verificado al terminar.

## Qué se puede compartir

| Dato | ¿Compartir? |
|---|---|
| Dirección pública | Sí |
| Nombre de wallet (`agent-dev`) | Sí |
| Network, token, monto, fee y hash público | Sí |
| Seed o mnemonic | Nunca |
| Private key | Nunca |
| Passphrase | Nunca |
| `seed.enc` | No; contiene material cifrado sensible |

## Referencias oficiales

- [WDK CLI — Get started](https://docs.wdk.tether.io/cli/guides/get-started/)
- [WDK CLI — Use the MCP server](https://docs.wdk.tether.io/cli/guides/use-mcp-server/)
- [WDK CLI — API reference](https://docs.wdk.tether.io/cli/api-reference/)
- [WDK CLI — Security model](https://docs.wdk.tether.io/cli/reference/security-model/)
