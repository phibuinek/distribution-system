export type DocId = string;
export type ClientId = string;

export type OpId = string; // globally unique (clientId + seq)

export type Revision = number; // monotonically increasing server revision

export type TextOp =
  | {
      id: OpId;
      clientId: ClientId;
      seq: number;
      docId: DocId;
      baseRev: Revision;
      kind: "ins";
      pos: number; // 0..len
      text: string;
      ts: number;
    }
  | {
      id: OpId;
      clientId: ClientId;
      seq: number;
      docId: DocId;
      baseRev: Revision;
      kind: "del";
      pos: number; // 0..len-1
      len: number; // >=1
      ts: number;
    };

export type ServerAck = {
  opId: OpId;
  newRev: Revision;
  acceptedOp?: TextOp;
};

export type ServerSnapshot = {
  docId: DocId;
  rev: Revision;
  text: string;
};

export type ServerError = {
  opId?: OpId;
  message: string;
};

