import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { eq } from "drizzle-orm";
import { WebSocketServer, type WebSocket } from "ws";

import { db } from "../db/client.js";
import { chatParticipants } from "../db/schema.js";
import { authenticateToken, type AuthedUser } from "../middleware/authenticate.js";
import { envelope, type EnvelopeType } from "./envelope.js";

/**
 * Realtime Hub — §6.4.
 *
 * The payoff of chat_participants: resolving which rooms a connection may see
 * is ONE query with no role branch. Revision 1 forked here ("all of a tutor's
 * rooms, or exactly the one tied to a guardian's student_id"); that fork is
 * gone, and adding a guardian to a student later just works because a row
 * exists.
 */

interface Connection {
  id: string;
  socket: WebSocket;
  user: AuthedUser;
  /** chat_group_id -> can_post */
  rooms: Map<string, boolean>;
}

class Hub {
  private readonly connections = new Map<string, Connection>();

  /** §6.4: one query, no role fork. */
  private async resolveRooms(userId: string): Promise<Map<string, boolean>> {
    const rows = await db
      .select({ chatGroupId: chatParticipants.chatGroupId, canPost: chatParticipants.canPost })
      .from(chatParticipants)
      .where(eq(chatParticipants.userId, userId));
    return new Map(rows.map((r) => [r.chatGroupId, r.canPost]));
  }

  async add(socket: WebSocket, user: AuthedUser): Promise<Connection> {
    const conn: Connection = { id: randomUUID(), socket, user, rooms: await this.resolveRooms(user.id) };
    this.connections.set(conn.id, conn);
    socket.on("close", () => this.connections.delete(conn.id));
    return conn;
  }

  /** Deliver a frame to every connection that belongs to this room. */
  broadcast(chatGroupId: string, type: EnvelopeType, data: unknown): void {
    const frame = envelope(type, data);
    for (const conn of this.connections.values()) {
      if (!conn.rooms.has(chatGroupId)) continue;
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(frame);
    }
  }

  /** Deliver a frame to every connection for a specific user (e.g. assignment suggestions). */
  broadcastToUser(userId: string, type: EnvelopeType, data: unknown): void {
    const frame = envelope(type, data);
    for (const conn of this.connections.values()) {
      if (conn.user.id !== userId) continue;
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(frame);
    }
  }

  get size(): number {
    return this.connections.size;
  }
}

export const hub = new Hub();

/**
 * One WS endpoint for the whole app: /ws?token=... — no per-room endpoints
 * (§6.4). The token goes in the query string because a browser cannot set
 * headers on a WS handshake; it is the same JWT as the Bearer header.
 */
export function attachRealtime(server: Server): void {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket, req) => {
    void (async () => {
      const token = new URL(req.url ?? "", "http://localhost").searchParams.get("token");
      const user = token ? await authenticateToken(token) : null;

      if (!user) {
        socket.close(4401, "unauthorized");
        return;
      }

      const conn = await hub.add(socket, user);
      socket.send(
        envelope("message", {
          system: "connected",
          rooms: [...conn.rooms.keys()],
        }),
      );

      socket.on("message", (raw) => {
        try {
          const parsed = JSON.parse(String(raw)) as {
            type?: string;
            data?: { chatGroupId?: string };
          };

          if (parsed.type !== "typing" || !parsed.data?.chatGroupId) return;

          const roomId = parsed.data.chatGroupId;

          // can_post is the room-level half of "parents are read-only" (§15).
          if (conn.rooms.get(roomId) !== true) return;

          // Fan out typing indicator to other connections in this room.
          hub.broadcast(roomId, "typing", {
            userId: conn.user.id,
            displayName: conn.user.displayName,
          });
        } catch {
          // Malformed frame — silently ignore.
        }
      });
    })().catch((err) => {
      console.error("realtime: connection failed", err);
      socket.close(1011, "internal error");
    });
  });

  console.log("realtime: websocket server mounted at /ws");
}
