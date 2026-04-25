export interface SecretsManagerPort {
  get(name: string): Promise<string>;
  getJson<T>(name: string): Promise<T>;
}
