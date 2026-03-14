declare module "bn.js" {
  export default class BN {
    constructor(value?: string | number | bigint | BN, base?: number);
    toNumber(): number;
    toString(base?: number): string;
  }
}

declare module "bs58" {
  const bs58: {
    decode(value: string): Uint8Array;
    encode(value: Uint8Array): string;
  };
  export default bs58;
}
