import { describe, expect, it } from 'vitest';
import { isCancellation, isConfirmation } from '../../src/livekit/resolution-phrases.js';

describe('voice resolution phrases', () => {
  it('accepts an explicit Spanish confirmation when speech recognition uses an Italian accent mark', () => {
    expect(isConfirmation('Sì, confirmo.')).toBe(true);
  });

  it('accepts exact standalone yes in English and Spanish', () => {
    expect(isConfirmation('yes')).toBe(true);
    expect(isConfirmation('sí')).toBe(true);
    expect(isConfirmation('si')).toBe(true);
  });

  it('accepts common spoken confirmation variants without handing transfer authority to the model', () => {
    expect(isConfirmation('Sì, confirma.')).toBe(true);
    expect(isConfirmation('Sí, te lo confirmo.')).toBe(true);
    expect(isConfirmation('Sí, confírmalo.')).toBe(true);
    expect(isConfirmation('Sí, lo confirmo.')).toBe(true);
    expect(isConfirmation('Yo te lo confirmo.')).toBe(true);
  });

  /**
   * A closed list of exact sentences made confirmation a spelling test. Real
   * users answer with the ordinary ways a person agrees — "dale", "listo",
   * "ok", "perfecto" — and every one of them was refused, with no way for the
   * user to know which word the system wanted. The vocabulary now covers how
   * people actually agree, while the structural rule below still keeps the
   * decision out of a longer sentence.
   */
  it('accepts the ordinary ways a Spanish speaker agrees', () => {
    for (const phrase of [
      'dale',
      'sí, dale',
      'sí dale',
      'dale, confirmá',
      'listo',
      'ok',
      'okey',
      'perfecto',
      'joya',
      'de una',
      'confirmá',
      'confirma',
      'sí, mandale',
      'mandale',
      'sí, enviá',
      'sí, hacelo',
      'procedé',
      'adelante',
      'todo bien',
      'está bien',
      'sí, por favor',
      'sí, dale, confirmo',
      'claro que sí',
      'obvio',
    ]) {
      expect(isConfirmation(phrase), phrase).toBe(true);
    }
  });

  it('still accepts plain EN agreement', () => {
    for (const phrase of ['yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'go ahead', 'yes please', 'confirm', 'do it']) {
      expect(isConfirmation(phrase), phrase).toBe(true);
    }
  });

  /**
   * The load-bearing safety property: the gate must not fire on an
   * authorization that is buried inside a larger instruction. "Sí, envíale uno
   * a Lucas, confirmo." carries an amount and a recipient, so it is a NEW
   * instruction, not a decision about the preview the user just heard.
   */
  it('does not treat a longer transfer instruction as confirmation', () => {
    expect(isConfirmation('Sí, envíale uno a Lucas, confirmo.')).toBe(false);
    expect(isConfirmation('dale, mandale 5 a Test1')).toBe(false);
    expect(isConfirmation('sí, pero primero mostrame el saldo')).toBe(false);
    expect(isConfirmation('confirmo y después cancelamos la otra')).toBe(false);
    expect(isConfirmation('sí, cuánto tengo')).toBe(false);
  });

  it('never reads a refusal as a confirmation', () => {
    for (const phrase of ['no', 'no, gracias', 'no dale', 'mejor no', 'dejalo', 'pará', 'olvidalo', 'cancelá', 'cancelar']) {
      expect(isConfirmation(phrase), phrase).toBe(false);
    }
  });

  it('accepts the ordinary ways a Spanish speaker declines', () => {
    for (const phrase of ['no', 'no, gracias', 'no dale', 'mejor no', 'dejalo', 'olvidalo', 'cancelá', 'cancelo', 'pará', 'no, cancelá']) {
      expect(isCancellation(phrase), phrase).toBe(true);
    }
  });

  it('does not read a confirmation as a cancellation, or the reverse', () => {
    for (const phrase of ['dale', 'sí', 'ok', 'listo', 'confirmo']) {
      expect(isCancellation(phrase), phrase).toBe(false);
    }
    for (const phrase of ['no', 'dejalo', 'cancelá']) {
      expect(isConfirmation(phrase), phrase).toBe(false);
    }
  });

  it('ignores an empty or content-free utterance', () => {
    expect(isConfirmation('')).toBe(false);
    expect(isConfirmation('   ')).toBe(false);
    expect(isConfirmation('...')).toBe(false);
    expect(isCancellation('')).toBe(false);
  });
});
