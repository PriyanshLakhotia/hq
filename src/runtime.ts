import { Firestore } from '@google-cloud/firestore';
import { Store } from './store.js';
import { FirestoreDriver } from './firestore.js';
import type { Config } from './config.js';
export function createStore(config: Config) {
  return config.storageBackend === 'firestore'
    ? new Store(new FirestoreDriver(new Firestore({ projectId: config.firestoreProject, databaseId: config.firestoreDatabase, preferRest: !process.env.FIRESTORE_EMULATOR_HOST }), config.firestorePrefix))
    : new Store();
}
