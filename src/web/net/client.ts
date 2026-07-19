/**
 * WebSocket link to the daemon.
 *
 * Reconnects on its own with backoff, because the daemon gets restarted constantly during
 * development and a renderer that needs a manual refresh to notice is a papercut every time.
 *
 * Unknown or unparseable messages are logged and dropped, never thrown: an exception inside a
 * socket handler kills the render loop's sibling tasks and the orb silently freezes, which is a
 * far worse failure than ignoring one bad frame.
 */

import { isServerMsg, type ClientMsg, type ServerMsg } from "../../shared/protocol.js";

export class DaemonLink {
    private ws: WebSocket | null = null;
    private retry = 0;
    private closed = false;

    onMessage: ((msg: ServerMsg) => void) | null = null;
    onOpen: (() => void) | null = null;
    onClose: (() => void) | null = null;

    constructor(
        private readonly url: string,
        private readonly agent: string,
    ) {}

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    connect(): void {
        this.closed = false;
        const ws = new WebSocket(this.url);
        this.ws = ws;

        ws.onopen = (): void => {
            this.retry = 0;
            this.send({ type: "hello", agent: this.agent });
            this.onOpen?.();
        };
        ws.onclose = (): void => {
            this.onClose?.();
            if (this.closed) return;
            // Capped exponential backoff — a dead daemon should not spin the tab at full rate.
            const delay = Math.min(5000, 250 * 2 ** this.retry++);
            setTimeout(() => this.connect(), delay);
        };
        ws.onerror = (): void => {
            // onclose always follows, and that is where reconnection is handled.
        };
        ws.onmessage = (ev): void => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(String(ev.data));
            } catch {
                console.warn("daemon sent unparseable message");
                return;
            }
            if (!isServerMsg(parsed)) {
                console.warn("daemon sent unknown message:", parsed);
                return;
            }
            this.onMessage?.(parsed);
        };
    }

    close(): void {
        this.closed = true;
        this.ws?.close();
    }

    send(msg: ClientMsg): void {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }
}
