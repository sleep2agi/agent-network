import { EventEmitter } from "events";

export type RenameCommittedEvent = {
  networkId: string | null;
  old_alias: string;
  new_alias: string;
  node_id?: string | null;
};

export const eventBus = new EventEmitter();
