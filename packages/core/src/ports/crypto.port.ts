export interface CryptoPort {
  hash(input: string): Promise<string>;
  verify(input: string, hash: string): Promise<boolean>;
  encrypt(plaintext: string, keyId: string): Promise<string>;
  decrypt(ciphertext: string, keyId: string): Promise<string>;
  randomBytes(size: number): Buffer;
}
