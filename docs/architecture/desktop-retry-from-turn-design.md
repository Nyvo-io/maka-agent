---
doc_id: architecture.desktop-retry-from-turn
title: "Retry From a Turn: Regenerate and Edit Semantics"
language: en
source_language: en
implementation_status: planned
document_status: draft
translation_status: source-only
last_verified: 2026-09-14
owners:
  - maka-desktop
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Retry From a Turn: Regenerate and Edit Semantics

> **Status:** proposed; maintainer approval required before implementation.
>
> This revision replaces assumptions in the initial draft with named current
> behavior and explicitly identifies the changes required for retry recovery,
> first-admission idempotency, and provider-input exclusion.

## Context

Regenerate currently appends a new turn to the same Session. Edit-and-resend creates a revision copy containing the conversation strictly before the edited turn. Both actions mean “retry from turn `T`”; only the submitted user content differs. Branch is different: it copies through `T` and continues with the retained answer.

This proposal concerns conversation history only. It does not roll back files, Git state, external side effects, Side Conversations, or Agent Graph revisions.

## Proposed contract

```text
retry(T, original input)    = Regenerate
retry(T, replacement input) = Edit-and-resend
branch(T)                   = copy through T, then continue
```

Retry uses the existing Host-owned `session.revision.create` path with a `before` slice and creates a new physical Session in the existing revision family. The source Session and its Runtime Events remain immutable. The target contains only the source prefix before `T`, followed by one normal admitted user turn.

`regenerateTurn` may remain as a client name, but it must route through this
contract rather than a same-Session append.

## Lineage: revision provenance, not a second cross-Session field

`regeneratedFromTurnId` is a same-Session edge. Its Desktop consumer,
`deriveTurnLineageBadges`, renders it only when the referenced Turn is present
in the materialized view of the displayed Session. A retry target deliberately
does not contain `T`; new cross-Session retries must therefore not write that
field.

New retries use the existing revision provenance:

- `revisionRootSessionId`: the family root;
- `revisionParentSessionId`: the copied Session;
- `revisionOfTurnId`: the Turn `T` the copy excludes; and
- `revisionIndex`: the family position.

Existing `regeneratedFromTurnId` records remain readable and are not rewritten.
Retrying from a revision child preserves the family root and uses that child as
`revisionParentSessionId`. A cross-Session "retried from `T`" badge would be a
separate consumer change that resolves `T` against the parent Session, not a
reason to overload the existing field.

## Host responsibilities and eligibility

The Host is authoritative for eligibility and admission. It evaluates one
contract and exposes its outcome before the click where possible:

| Rejection | Reason |
|---|---|
| Source Session is active or busy | `session_busy` |
| `T` missing or not settled | `invalid_request` / `operation_unavailable` |
| Revision family archived | `operation_conflict` |
| Unsupported structured content or attachments | `invalid_request` / `operation_unavailable` |
| Target identity owned by another request | `operation_conflict` |
| Source moved past `expectedSourceRevision` | `source_revision_conflict` |

These reuse `SESSION_COPY_ERRORS`; retry-specific error codes are unnecessary.
Copy preparation continues to use the runtime ledger, archived-tool-result,
linked-child, and Session-owned artifact copy logic. The structured-content
guards from #5109/#5118 are prerequisites, not duplicated work.

## Invariants

- The source Session and its Runtime Events are not rewritten by retry; the
  source remains available for independent later operations.
- The target contains the source prefix strictly before `T`, plus the explicitly
  selected canonical user input for the replacement Turn. It contains no old
  execution output, Runtime Event, archived tool result, or compaction projection
  derived from `T` or later.
- The superseded assistant answer, all later-turn content, and any projection
  containing either are excluded from the actual provider request. This is proven
  by capturing provider input with a fixed provider double; transcript assertions
  are insufficient.
- A committed target admits exactly one first post-copy Turn. A failed send does
  not create another target or leave it open to a second replacement.
- Regenerate and Edit share eligibility, copy, and recovery semantics; only input
  content differs.
- Branch remains inclusive and is not converted into retry or a revision-family
  operation.
- Conversation retry does not imply rollback of external side effects.

## Copy and admission binding

A copy fingerprint and a first admission answer different questions. The design
binds them without an independent retry ledger.

The existing `conversationCopyFingerprint` identifies source Session, target
Session, source Turn, and copy kind. It answers whether a target exists, but it
does not identify the replacement content or first admitted Turn.

`admitRootTurn` already provides durable admission records and returns
`admitted | existing | conflict` for the stable `(sessionId, turnId)` identity.
Its source-message proof prevents a source message identity from belonging to a
different admitted Turn; exact admission replays reject changed canonical
content, placement, or intent. What is missing is a retry-owned stable identity:
Desktop currently generates a fresh message UUID for each submit.

The retry contract is therefore:

- The Host derives a stable first-message and first-Turn identity from the retry
  request, its copy fingerprint, and canonical replacement content, and returns
  that identity with the copy result.
- The first root-turn admission persists that identity, canonical-content digest,
  target Session, and replacement Turn through the existing admission authority.
- A replay with the same derived identities resolves to `existing`. A different
  identity or canonical content for the same retry plan is a conflict and cannot
  append a second replacement.

Per-message idempotency alone is insufficient: a normal later message in the
target has a different identity and is valid. The retry operation must enforce
the one-replacement guard until its first replacement admission is committed;
after that the target is an ordinary Session.

## Lifecycle

These are conceptual states, mapped to existing durable facts rather than a new
persisted state machine:

| State | Durable facts |
|---|---|
| `absent` | no target Session |
| `preparing` | `conversationCopy.state = 'preparing'` |
| `copied` | committed `conversationCopy`, `revisionState = 'preparing'`, no root-turn admission |
| `admitted` | root-turn admission exists for the target |
| `committed` | `revisionState = 'committed'` |

```text
absent -> preparing -> copied -> admitted -> committed
             |            |         |
             +-> abandon  +-> retry  +-> recover same admission
```

Preparing and copied-but-unadmitted targets are excluded from ordinary catalog
listings. A target becomes visible only after its first post-copy Turn passes
Host admission.

## Recovery and retention

Current `SessionRevisionCoordinator.recover()` retains a committed revision
target only when it is already committed or holds a root-turn admission. A crash
after copy commit but before first admission therefore discards the target. That
does not satisfy this contract.

The retry plan must persist with the copy: family root, parent Session, `T`, and
the derived first-message identity and canonical-content digest. Recovery then
has three explicit boundaries:

1. Before copy commit, it may discard the preparing target; no plan exists.
2. After copy commit and before first admission, it retains a readable retry
   plan and may admit only that bound first message.
3. After admission and before acknowledgement or publication, the admission is
   the proof; recovery republishes or resumes that same Turn and never starts a
   new model execution.

The `recover()` retention rule must retain a committed revision copy with a
valid retry plan even without an admission. A malformed plan or missing source
is abandoned. No state is considered admitted merely because an acknowledgement
was lost.

## Provider-input verification

The target provider request is materialized from the copied Runtime Event ledger,
not renderer state. A checkpoint or archived result whose covered source prefix
reaches `T` is invalid for the target and must be rebuilt from the copied prefix.
Contract tests capture the actual provider request for compacted prefixes,
archived tool results, linked child references, and structured messages and
attachments (preserved or explicitly rejected). The captured request contains
neither the superseded assistant message nor a derived projection containing it.

## Trade-offs and measurements

The revision-copy path is the preferred direction because it reuses existing Host
boundaries for history, compaction, artifacts, and recovery. A hidden same-Session
sibling would reduce copying but require new model-history, catalog, export, and
recovery rules.

This preference remains conditional on measurements of copy latency, SQLite write
amplification, physical artifact copying, cold-restart recovery time,
provider-input size, and catalog query cost as a revision family grows. Discussion
#4704 is directly relevant: conversation copy physically copies artifact payloads
and clones model-call events, so a retry copying a long prefix inherits those
costs. Measurements may justify an optimization, but must not change retry
semantics.

## Delivery plan

Runtime implementation does not begin until the public process and baseline below
are satisfied.

**Prerequisites:**

1. Maintainer agreement on the model through the public `dev@maka.apache.org`
   process required by `CONTRIBUTING` for material product decisions.
2. A long-history copy baseline: latency, copied bytes, SQLite write
   amplification, and cold-restart time for a representative Session.
3. A decision on retaining a planned-but-unadmitted target and on its
   user-visible abandonment behavior.

**Implementation order:**

1. Persist the retry plan with the copy and return derived first-message and
   first-Turn identities from the copy operation.
2. Add or adapt one Host retry operation that composes revision copy and normal
   send, with a first-replacement guard on the target copy.
3. Retain and recover planned-but-unadmitted targets in `recover()`.
4. Route Desktop Regenerate through the operation and remove the unchanged-Edit
   redirect.
5. Add provider-input, lineage, idempotency, disconnect, and copy/admission
   failure tests.

## Open questions

- Does Desktop need a cross-Session "retried from `T`" badge, or is
  version-family navigation sufficient?
- Should the retry plan extend the existing `conversationCopy` record or live in
  a separate revision-plan row?
- Should `session.revision.abandon` distinguish a planned-but-unadmitted target
  from its current `abandoned | retained` outcomes?

## Implementation anchors

Existing copy authority:
`packages/runtime-host/src/server/session-revision-coordinator.ts`,
`packages/runtime-host/src/protocol/session-revision.ts`.

Recovery retention rule: `SessionRevisionCoordinator.recover()` and
`#hasAdmittedRevisionTurn` in the same file; `commitRevisionVersion` in
`packages/runtime/src/session-manager.ts`.

Message and root-turn admission:
`packages/runtime-host/src/server/message-coordinator.ts`,
`packages/storage/src/agent-run-store.ts` (`RootTurnAdmission`,
`readRootTurnSourceMessageReceipt`, `listRootTurnAdmissionsForRecovery`).

Lineage consumer: `apps/desktop/src/renderer/derive-turn-lineage-badges.ts`,
`apps/desktop/src/renderer/app-shell-turn-view-model.ts`.

Client message identity: `apps/desktop/src/renderer/app-shell-chat-actions.ts`.

Desktop Edit orchestration:
`apps/desktop/src/renderer/app-shell-revision-actions.ts`.

Current Regenerate adapters:
`apps/desktop/src/main/runtime-host-session-execution-ipc-main.ts`,
`apps/desktop/src/main/runtime-host-client.ts`,
`packages/runtime/src/session-manager.ts`.

This document records a planned contract; these anchors do not imply that the new
behavior is implemented.
