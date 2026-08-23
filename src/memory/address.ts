/**
 * This project supports EVM recipient records only.  A checksum is optional
 * for an EVM address, but its byte shape is not: reject any other payload
 * before it can enter or leave recipient memory.
 */
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}
