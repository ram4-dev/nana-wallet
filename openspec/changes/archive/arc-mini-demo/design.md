# Design

Use the official Circle developer-controlled wallet SDK. Provisioning runs as
an explicit local CLI, never at server import or startup. Read the supplied
API key from hidden terminal input. Keep temporary key material in memory.
Store new entity secret and idempotency state in the ignored .local/arc-demo
directory, mode 0700, with files mode 0600. Keep recovery data separate from
code. Existing registration is a blocker, not permission to rotate it.

The same Circle SDK can later implement the existing WalletProvider boundary.
No frontend/backend cross imports, voice rewrite, or WDK live activation.

For today's accepted written demo, use an isolated localhost HTTP server and
guided commands rather than requiring missing LiveKit, OpenAI and database
credentials. UI and backend remain separated by JSON HTTP. Label it as guided,
not an LLM. Payment state is persisted before dispatch, with file permissions
0600 and an exclusive process lock. Bind to 127.0.0.1, validate Host and Origin,
require a per-process CSRF token, and never expose signing material to the UI.

Circle transfer requests use walletAddress + blockchain + tokenAddress together.
The first corrected attempt reuses the previous validation-rejected request key.
Later requests require a fresh preview and confirmation. Unknown dispatch never
creates another operation automatically. Verification reads the actual Arc
transaction and receipt and matches sender, destination and exact amount.
