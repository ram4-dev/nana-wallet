/** Typical Nana agent responses used as TTS round-trip inputs. */
export type TtsSample = {
  name: string;
  text: string;
  /** Rough expected duration in seconds at a natural speaking pace, used for the smoke check. */
  expectedMinSeconds: number;
};

export const ttsSamples: TtsSample[] = [
  {
    name: 'saldo simple',
    text: 'Tenés 42,5 USDT disponibles en tu cuenta de Sepolia.',
    expectedMinSeconds: 2,
  },
  {
    name: 'preview de transferencia',
    text:
      'Vas a enviar 50 USDT a mamá en la red Sepolia. La comisión estimada es 0,0003 ETH. ¿Confirmás el envío?',
    expectedMinSeconds: 4,
  },
  {
    name: 'monto con decimales',
    text: 'El saldo actual es 1.234,56 USDT y la dirección termina en 7890.',
    expectedMinSeconds: 4,
  },
  {
    name: 'dirección completa técnica',
    text: 'La dirección del destinatario es 0x1234567890abcdef1234567890abcdef12345678.',
    expectedMinSeconds: 5,
  },
  {
    name: 'aclaración de rechazo',
    text:
      'No pude realizar la transferencia porque el destinatario no está en tu lista de contactos autorizados. Querés que lo agregues primero?',
    expectedMinSeconds: 5,
  },
];
