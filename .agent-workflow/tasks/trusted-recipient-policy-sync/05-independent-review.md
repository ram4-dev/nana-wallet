# Independent outline review

Reviewer: native general_review subagent /root/recipient_outline_review. Pi/Herdr explicitly superseded by Ramiro: "Hacelo todo inline o con subagentes nativos". No external sessions/tabs created.

## Revision 1
SHA256: e52c14086779f4b952c33bfbbea182cc51899819753dbb114231a86a90eed7ad.
Verdict: not implementation-ready. Read-only source review; no tests or mutations by reviewer.

| ID | Severity | Finding | Revision 2 disposition |
| --- | --- | --- | --- |
| R1 | controlling | Contact/archive and delegated revocation not explicitly atomic; existing claim/revoke locks and lock order can race. | Slice 1 mandates one ledger transaction for contact + grant revocation/audits + intent, shared documented lock order, concurrent claim/removal and deadlock tests. |
| R2 | controlling | Ambiguous composed-policy PATCH can leave sibling grants executable via policy-ID-only readiness. | Slice 2 mandates wallet-level verified policy revision/hash or atomic all-binding invalidation, enforced in delegated coverage/claim, sibling failure tests. |
| R3 | controlling | Voice exact-address visual review had no selected transport. | Slice 4 specifies persisted server-owned proposal card published to bound authenticated UI, exact immutable address, verified pasted/scanned source, refusal if absent. |
| R4 | controlling | Two parallel confirmation listeners could authorize contact and transfer from the same utterance. | Slice 4 mandates one per-session typed action arbiter, fail-closed collision, matching tool one-use consume, both-order collision tests. |
| R5 | major | Bootstrap consent provenance and stale enrollment pending-policy reuse insufficiently explicit. | Slice 1 derives baseline from enrollment consent snapshot and Test1 from active confirmed contact; remote GET never supplies consent; replaces stale pending policy reuse with revision verification. |

Revision 2 re-review completed by the same independent native reviewer: READY FOR OUTLINE APPROVAL; no controlling findings remain. SHA256: e19dae240950cdfd53fa3c9945e3d98df1ee3e056afcdd99c1c82c67a19fc169. R1–R5 dispositions verified against exact revision 2. Schema/locking algorithm, signer deployment and provider-supported empty policy are explicitly assigned SDD verification/stop conditions, not hidden assumptions. Human outline approval remains pending. Native agent stays available for follow-up; no cleanup of user tabs/worktrees performed.
