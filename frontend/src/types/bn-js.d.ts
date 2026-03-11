declare module "bn.js" {
  export default class BN {
    constructor(value: number | string | bigint, base?: number, endian?: "le" | "be");
    toNumber(): number;
    toArrayLike<T>(arrayType: { new (...args: unknown[]): T }, endian: "le" | "be", length: number): T;
  }
}
