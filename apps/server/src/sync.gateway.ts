import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server as SocketIOServer, Socket } from "socket.io";
import type { ServerAck, ServerError, ServerSnapshot, TextOp } from "@ds/shared";
import { DocsService } from "./docs.service";

type JoinPayload = {
  docId: string;
  knownRev?: number;
};

@WebSocketGateway({
  cors: { origin: true, credentials: true },
  transports: ["websocket"],
})
export class SyncGateway {
  @WebSocketServer()
  server!: SocketIOServer;

  constructor(private readonly docs: DocsService) {}

  private room(docId: string) {
    return `doc:${docId}`;
  }

  @SubscribeMessage("join")
  async onJoin(@MessageBody() body: JoinPayload, @ConnectedSocket() socket: Socket) {
    const docId = body.docId;
    await socket.join(this.room(docId));

    const snap = this.docs.getSnapshot(docId) satisfies ServerSnapshot;
    socket.emit("snapshot", snap);

    const knownRev = body.knownRev ?? 0;
    if (knownRev < snap.rev) {
      const ops = this.docs.getOpsSince(docId, knownRev);
      socket.emit("ops", { docId, fromRev: knownRev, toRev: snap.rev, ops });
    }
  }

  @SubscribeMessage("op")
  onOp(@MessageBody() op: TextOp, @ConnectedSocket() socket: Socket) {
    try {
      const { newRev, rebasedOp, deduped } = this.docs.applyClientOp(op);
      const ack: ServerAck = { opId: op.id, newRev, acceptedOp: rebasedOp };
      socket.emit("ack", ack);

      if (!deduped && rebasedOp) {
        // broadcast the server-accepted op to other clients in the room
        socket.to(this.room(op.docId)).emit("remoteOp", { op: rebasedOp, newRev });
      }
    } catch (e: any) {
      const err: ServerError = { opId: op?.id, message: e?.message ?? "op failed" };
      socket.emit("err", err);
    }
  }

  @SubscribeMessage("sync")
  onSync(@MessageBody() body: { docId: string; sinceRev: number }, @ConnectedSocket() socket: Socket) {
    const snap = this.docs.getSnapshot(body.docId);
    if (body.sinceRev < snap.rev) {
      const ops = this.docs.getOpsSince(body.docId, body.sinceRev);
      socket.emit("ops", { docId: body.docId, fromRev: body.sinceRev, toRev: snap.rev, ops });
    } else {
      socket.emit("ops", { docId: body.docId, fromRev: snap.rev, toRev: snap.rev, ops: [] });
    }
  }
}

