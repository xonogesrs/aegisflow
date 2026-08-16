// src/memory/identity.mjs
//
// CBM-2 — Memory Contract v1: identity derivation.
//
//   recordId =
//     sha256(recursiveCanonical({
//       schema, recordType, identity, subject, scope, sourceIdentity
//     }))
//
//   logicalKey（conflict / supersession key）=
//     sha256(recursiveCanonical({ schema, recordType, identity, scope }))
//
// Rules:
//   - canonical JSON is the STRICT contract form（canonical.mjs）— never the
//     shallow replacer（CBM-1 collision defect）;
//   - identity / subject / scope / sourceIdentity changes ALWAYS change
//     recordId; metadata / lifecycle / evidence / timestamps / security
//     changes NEVER change recordId;
//   - contentHash（subject.contentHash）is content identity-relevant: two
//     records with the same logicalKey but different contentHash are
//     conflicting versions（surfaced together, never silently merged）;
//   - the record's own digest is never part of its own identity input.

import { recursiveCanonicalJson, canonicalSha256, contentHash } from "./canonical.mjs";
import { MEMORY_RECORD_SCHEMA } from "./contract.mjs";

/** The full identity payload per the contract spec. */
export function identityPayload(record) {
  const sourceIdentity = record?.source?.identity ?? null;
  return {
    schema: record?.schema ?? null,
    recordType: record?.recordType ?? null,
    identity: record?.identity ?? null,
    subject: record?.subject ?? null,
    scope: record?.scope ?? null,
    sourceIdentity,
  };
}

/** Derive the record's canonical recordId（never trust a writer-supplied one）. */
export function deriveMemoryRecordId(record) {
  return canonicalSha256(identityPayload(record));
}

/** The logical conflict/supersession key（scope-isolated）. */
export function deriveLogicalKey(record) {
  return canonicalSha256({
    schema: record?.schema ?? null,
    recordType: record?.recordType ?? null,
    identity: record?.identity ?? null,
    scope: record?.scope ?? null,
  });
}

/** Content identity（CBM-1 §5）: sha256("content:" + canonical(content)). */
export { contentHash as deriveContentHash };

/** The canonical JSON text of the identity payload（for debugging / vectors）. */
export function identityCanonicalJson(record) {
  return recursiveCanonicalJson(identityPayload(record));
}

/** A stable, human-traceable id for lifecycle events / relationships. */
export function deriveEventId(prefix, ...parts) {
  return `${prefix}_${canonicalSha256(parts.map((p) => (p === undefined ? null : p)))}`.slice(0, 24);
}

/** Validate the envelope schema version is exactly the supported one. */
export function isSupportedSchema(record) {
  return record?.schema === MEMORY_RECORD_SCHEMA;
}
