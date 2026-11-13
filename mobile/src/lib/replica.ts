import { Directory, File, Paths } from 'expo-file-system';

import { createReplica, type ReplicaStore } from '../../../shared/sync/replica-core';

export type { ReplicaOp } from '../../../shared/sync/replica-core';

/** The phone's copy of the shared library state (shared/sync/replica-core.ts), kept in Documents. */
const folder = new Directory(Paths.document, '.anime-study');
const file = new File(folder, 'replica.json');
const store: ReplicaStore = {
  read: () => (file.exists ? file.textSync() : null),
  write: text => {
    if (!folder.exists) folder.create({ intermediates: true });
    file.write(text);
  },
};

const replica = createReplica(store, 'ios');

export const replicaNodeId = replica.nodeId;
export const {
  registerSeriesAlias, canonicalEpisodeKey, localEpisodeKeys, getRegister, entries,
  setLocal, onRemoteChange, syncWith, setSyncer, scheduleSync,
} = replica;
