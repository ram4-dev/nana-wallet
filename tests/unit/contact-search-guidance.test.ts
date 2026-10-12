import { describe, expect, it } from 'vitest';
import { composeRealtimeInstructions } from '../../src/livekit/create-agent-session.js';
import { buildWalletAgentInstructions } from '../../src/agent/instructions.js';
import {
  createWalletAgentDefinition,
  recipientSearchInputSchema,
} from '../../src/agent/definition.js';

/**
 * The guidance half of the `contact-search-returns-evidence` regression.
 *
 * Carrying the rows back is necessary and not sufficient: the surface has to be
 * TOLD what to do with them, or a model that receives candidates can still
 * answer that the contact does not exist. These are prose contracts, so they are
 * asserted by the smallest sentence that would have prevented the incident — not
 * by comparing whole prompts.
 */

/**
 * Built once through the real factory, on the real construction path.
 *
 * The alias wiring work in this repository established the rule this follows: a
 * seam asserted through an injected double can pass while production never
 * supplies it, so the guidance is read from the definition the runtime builds.
 */
const RECIPIENT_SEARCH = createWalletAgentDefinition()
  .tools({ wallet: {} } as never)
  .find((tool) => tool.name === 'search_recipients');

describe('the recipient search tells the model how to use its own result', () => {
  it('documents `query` as the user\'s own words, not a guessed proper name', () => {
    // The live incident: the user said "my nephew", the audio model turned that
    // description into the phonetic name `MinaFi`, and the search was then asked
    // for a stranger. The field has to say that a description is a valid query.
    const described = recipientSearchInputSchema.shape.query.description ?? '';

    expect(described.toLowerCase()).toContain('own words');
    expect(described.toLowerCase()).toContain('name');
    expect(described.toLowerCase()).toContain('description');
  });

  it('requires the name AND the stored description to be read back', () => {
    const description = RECIPIENT_SEARCH?.description ?? '';

    expect(description).toContain('description');
    expect(description.toLowerCase()).toContain('never');
  });

  it('is the tool the voice and text surfaces both expose, so one contract covers both', () => {
    expect(RECIPIENT_SEARCH).toBeDefined();
  });
});

describe('the voice instructions refuse a denial the result does not support', () => {
  const instructions = composeRealtimeInstructions('en');

  it('keeps the rule that a listed candidate is never reported as non-existent', () => {
    expect(instructions).toContain('Never tell the user a contact does not exist');
  });

  it('tells Nani to search with the words the user actually said', () => {
    // A relationship word is a valid query. Inventing a proper name from it is
    // what turned "my nephew" into a search for somebody who does not exist.
    expect(instructions).toContain('described');
    expect(instructions.toLowerCase()).toContain('never invent');
  });

  it('tells Nani to read the stored description back, so the user can recognise the contact', () => {
    expect(instructions).toContain('description');
  });
});

describe('the text instructions refuse a denial the result does not support', () => {
  const instructions = buildWalletAgentInstructions({ wallet: 'privy-user', network: 'solana-devnet', token: 'SOL' }, 'en');

  it('carries the same rule as the voice surface', () => {
    expect(instructions).toContain('never say a contact does not exist');
    // ...and the part the voice surface gained: the stored description is what
    // lets the user recognise the person they described.
    expect(instructions).toContain('stored descriptions back');
    // A description is a valid search term on this surface too.
    expect(instructions).toContain('described\n  the person');
    // Nothing found is not the same fact as nobody exists.
    expect(instructions).toContain('repeat the name');
  });
});
