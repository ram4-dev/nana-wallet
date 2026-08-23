const RELATION_TERMS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:grandson|nieto)\b/i, /\b(?:grandson|nieto)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:granddaughter|nieta)\b/i, /\b(?:granddaughter|nieta)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:grandchild)\b/i, /\b(?:grandchild|grandson|granddaughter|nieto|nieta)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:son|hijo)\b/i, /\b(?:son|hijo)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:daughter|hija)\b/i, /\b(?:daughter|hija)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:father|padre)\b/i, /\b(?:father|padre)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:mother|madre)\b/i, /\b(?:mother|madre)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:brother|hermano)\b/i, /\b(?:brother|hermano)\b/i],
  [/\b(?:my|mi|mis|your|tu|tus)\s+(?:sister|hermana)\b/i, /\b(?:sister|hermana)\b/i],
];

export function factSupportsRelationshipReference(fact: string, reference: string): boolean {
  const relationship = RELATION_TERMS.find(([queryPattern]) => queryPattern.test(reference));
  return !!relationship && relationship[1].test(fact);
}

export function isRelationshipReference(reference: string): boolean {
  return RELATION_TERMS.some(([queryPattern]) => queryPattern.test(reference));
}

/** Extracts only the subject of the controlled relationship-fact shape. */
export function relationshipFactIdentity(fact: string): string | undefined {
  const match = fact.trim().match(/^([^,.!;]+?)\s+(?:is|es)\s+(?:my|mi)\s+/i);
  return match?.[1]?.trim() || undefined;
}
