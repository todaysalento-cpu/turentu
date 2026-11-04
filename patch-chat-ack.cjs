
const fs = require("fs");

const file = "feature/chat/hooks/useChatController.ts";
const backup = file + ".bak-socket-ack";

const source = fs.readFileSync(file, "utf8");

const startMarker =
  "  const sendMessage = useCallback(async (threadId: string, text: string) => {";

const endMarker =
  "  /* ================= INVIO AUDIO ================= */";

const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);

if (start < 0 || end < 0 || end <= start) {
  throw new Error("STOP: blocco sendMessage non trovato");
}

if (fs.existsSync(backup)) {
  throw new Error("STOP: backup già esistente");
}

const oldBlock = source.slice(start, end);

if (!oldBlock.includes('socket?.emit("send_message"')) {
  throw new Error("STOP: invio originale inatteso");
}

const replacement = String.raw`  const sendMessage = useCallback(async (threadId: string, text: string) => {
    const thread = useChatThreadsStore.getState().threads[threadId];
    if (!thread || !text.trim()) return;

    if (!socket || !socket.connected) {
      err("INVIO TESTO: socket non connesso");
      return;
    }

    const client_msg_id = \`opt-\${Date.now()}\`;

    const optimisticMsg = normalizeMessage({
      id: client_msg_id,
      client_msg_id,
      text,
      tipo_messaggio: "text",
      sender_id: user?.id,
      corsa_id: thread.corsa_id,
      cliente_id: thread.cliente_id,
      created_at: Date.now()
    });

    log("INVIO TESTO: messaggio ottimistico", optimisticMsg);
    addMessage(threadId, optimisticMsg);

    try {
      socket.timeout(10000).emit(
        "send_message",
        {
          corsa_id: thread.corsa_id,
          cliente_id: thread.cliente_id,
          text,
          client_msg_id
        },
        (timeoutError: Error | null, response: any) => {
          if (timeoutError) {
            err("INVIO TESTO: timeout ACK", { client_msg_id });
            return;
          }

          if (!response?.ok || !response?.message) {
            err("INVIO TESTO: backend ha rifiutato il messaggio", response);
            return;
          }

          const normalized = normalizeMessage(response.message);

          if (!normalized) {
            err("INVIO TESTO: risposta backend non valida");
            return;
          }

          replaceOptimisticMessage(
            threadId,
            client_msg_id,
            normalized
          );

          log("INVIO TESTO: ACK ricevuto", {
            client_msg_id,
            message_id: normalized.id,
            duplicate: response.duplicate === true
          });
        }
      );
    } catch (e) {
      err("INVIO TESTO: errore emissione socket", e);
    }
  }, [socket, user?.id, addMessage, replaceOptimisticMessage]);

`;

fs.copyFileSync(file, backup);

fs.writeFileSync(
  file,
  source.slice(0, start) + replacement + source.slice(end),
  "utf8"
);

console.log("OK: ACK client integrato; backup creato");
