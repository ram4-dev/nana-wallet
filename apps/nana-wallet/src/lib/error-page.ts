export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="es-AR">
  <head>
    <meta charset="utf-8" />
    <title>Esta parte no cargó</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 18px/1.5 system-ui, sans-serif; background: #fafafa; color: #111; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 2rem; margin: 0 0 1rem; }
      p { color: #4b5563; margin: 0 0 1.5rem; }
      a { min-height: 4rem; padding: 0.5rem 1rem; border-radius: 0.75rem; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; border: 1px solid transparent; display: inline-flex; align-items: center; justify-content: center; }
      .primary { background: #111; color: #fff; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Esta parte no cargó</h1>
      <p>No es culpa tuya. Algo falló de este lado y tu plata sigue segura.</p>
      <a class="primary" href="/">Volver al inicio</a>
    </div>
  </body>
</html>`;
}
