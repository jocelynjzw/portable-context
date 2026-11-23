import { NotionStore } from './notion.js';
import { Store, StoreError, dataDirectory } from './store.js';

export function openBackend() {
  switch (process.env.PORTABLE_CONTEXT_BACKEND ?? 'sqlite') {
    case 'sqlite': return new Store(dataDirectory());
    case 'notion': return new NotionStore(process.env);
    default: throw new StoreError('STORAGE_CONFIG: Set PORTABLE_CONTEXT_BACKEND to sqlite or notion.');
  }
}
