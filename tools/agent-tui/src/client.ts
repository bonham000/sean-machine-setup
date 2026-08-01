import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readJsonLines, writeMessage } from "./protocol.ts";
import type { ClientRequestInput, ServerMessage, SessionRecord } from "./types.ts";

export async function connectSocket(socketPath: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function request(
  session: SessionRecord,
  value: ClientRequestInput,
  timeoutMs = 5_000,
): Promise<Extract<ServerMessage, { type: "response" }>> {
  const socket = await connectSocket(session.socketPath);
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for session ${session.id}`));
    }, timeoutMs);
    socket.on(
      "data",
      readJsonLines<ServerMessage>((message) => {
        if (message.type !== "response" || message.id !== id) return;
        clearTimeout(timeout);
        socket.end();
        if (!message.ok) reject(new Error(message.error ?? "Session request failed"));
        else resolve(message);
      }),
    );
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    writeMessage(socket, { ...value, id });
  });
}
