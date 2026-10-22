# Design discussion

Status: approved by Ramiro on 2026-10-22.

## Current state
The selected project `nana_wallet_landing` is the Nana Landing waitlist database, so sharing it would couple both apps' migration histories. Nana Wallet's repo has been unlinked from that ref. The CLI session remains authenticated. The Vault service is unreachable, so no new database password can be securely supplied to the create command.

## Desired state
An isolated Supabase project for Nana Wallet, with its own migration ledger, in the same organization and region. Preserve Nana Landing and its waitlist as a separate project.

## Decision
Create a project named `nana-wallet-primary` in organization `qaodimxknesgkicsqtoo`, region `us-east-1`. Link this Nana Wallet repo only after creation returns the new ref. Do not touch `nana_wallet_landing` again.

## Approval record

Gate ID: NEW-NANA-WALLET-SUPABASE-PROJECT
Decision / allowed mutation: create and link an isolated Supabase project for Nana Wallet; apply only Nana Wallet's migrations and roles there.
Explicit exclusions: no changes to `nana_wallet_landing` or its waitlist; no secret exposure; no remote reset.
Owning artifact / revision: `03-design-discussion.md`, revision 1.
Decision owner: Ramiro.
Approved by / trusted identity: Ramiro (user message: "creemos y linkeemos un poryecto nuevo").
Approved at: 2026-10-22.
Status: approved.
Invalidated by: a different project name, organization, region, or target.

## Remaining operational prerequisite
Vault must be reachable so a unique project database password can be passed to `supabase projects create` and then reused for the runtime connection through `vault-env`. Do not create the project with a temporary or untracked password.

## Final decision amendment — revision 2 (2026-10-22)
Ramiro directed inline execution and supplied the Supabase credentials through Vault. A separate active healthy project `nana_app` (`jnhemqouecznsziytzhm`) already existed, so adopt it rather than create another project. Link Nana Wallet there, apply only Nana Wallet migrations and role bootstrap, and leave Nana Landing's waitlist alone. The prior review gate for project name `nana-wallet-primary` is superseded only as to project identity by this user-directed evidence; scope boundaries remain. Runtime app secret-store provisioning and deployed health proof remain follow-up work.
