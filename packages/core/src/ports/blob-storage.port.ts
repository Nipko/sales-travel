export interface BlobMetadata {
  contentType?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

export interface BlobStoragePort {
  put(key: string, body: Buffer | Uint8Array, metadata?: BlobMetadata): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  presignGetUrl(key: string, expiresInSeconds: number): Promise<string>;
  presignPutUrl(key: string, expiresInSeconds: number, metadata?: BlobMetadata): Promise<string>;
}
