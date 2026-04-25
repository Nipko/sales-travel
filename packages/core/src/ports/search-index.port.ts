export interface SearchQuery {
  index: string;
  q: string;
  filters?: Record<string, string | number | boolean>;
  sort?: string;
  page?: number;
  perPage?: number;
}

export interface SearchResult<T> {
  hits: T[];
  totalHits: number;
  page: number;
  perPage: number;
}

export interface SearchIndexPort {
  upsert<T>(index: string, document: T & { id: string }): Promise<void>;
  delete(index: string, id: string): Promise<void>;
  search<T>(query: SearchQuery): Promise<SearchResult<T>>;
}
