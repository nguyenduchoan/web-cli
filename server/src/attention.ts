import crypto from "node:crypto";

export type AttentionEvent = {
  type: "attention";
  eventId: string;
  sessionId: string;
  createdAt: string;
  message?: string;
};

const MAX_OSC_PAYLOAD_LENGTH = 4096;
const DEFAULT_COOLDOWN_MS = 2000;

enum ParserState {
  GROUND = 0,
  ESCAPE = 1,
  OSC_HEADER = 2,
  OSC_PAYLOAD = 3,
  OSC_ESCAPE = 4,
  DISCARD_UNTIL_TERMINATOR = 5,
  DISCARD_ESCAPE = 6
}

export class AttentionDetector {
  private state = ParserState.GROUND;
  private buffer = "";
  private oscType = "";
  private lastEmitTime = 0;
  private readonly cooldownMs: number;
  private readonly sessionId: string;
  private readonly onAttention: (event: AttentionEvent) => void;

  constructor(
    sessionId: string,
    onAttention: (event: AttentionEvent) => void,
    options?: { cooldownMs?: number }
  ) {
    this.sessionId = sessionId;
    this.onAttention = onAttention;
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  feed(chunk: string | Buffer): void {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const char = text[i];
      const code = char.charCodeAt(0);

      switch (this.state) {
        case ParserState.GROUND: {
          if (code === 0x1b) {
            this.state = ParserState.ESCAPE;
          } else if (code === 0x9d) {
            // C1 OSC
            this.state = ParserState.OSC_HEADER;
            this.buffer = "";
            this.oscType = "";
          }
          break;
        }

        case ParserState.ESCAPE: {
          if (char === "]") {
            // OSC start
            this.state = ParserState.OSC_HEADER;
            this.buffer = "";
            this.oscType = "";
          } else {
            // Non-OSC escape
            this.state = ParserState.GROUND;
          }
          break;
        }

        case ParserState.OSC_HEADER: {
          if (char === ";") {
            // Check if OSC 9
            if (this.oscType === "9") {
              this.state = ParserState.OSC_PAYLOAD;
              this.buffer = "";
            } else {
              // Ignore other OSC sequences (OSC 0, 7, etc.)
              this.state = ParserState.DISCARD_UNTIL_TERMINATOR;
            }
          } else if (code === 0x07 || code === 0x9c) {
            // Premature terminator
            this.state = ParserState.GROUND;
          } else if (code === 0x1b) {
            this.state = ParserState.ESCAPE;
          } else if (this.oscType.length < 10 && ((char >= "0" && char <= "9") || char === "?")) {
            this.oscType += char;
          } else {
            // Malformed OSC header
            this.state = ParserState.DISCARD_UNTIL_TERMINATOR;
          }
          break;
        }

        case ParserState.OSC_PAYLOAD: {
          if (code === 0x07 || code === 0x9c) {
            // BEL or C1 ST terminates
            this.emitAttention(this.buffer);
            this.state = ParserState.GROUND;
            this.buffer = "";
          } else if (code === 0x1b) {
            this.state = ParserState.OSC_ESCAPE;
          } else {
            if (this.buffer.length < MAX_OSC_PAYLOAD_LENGTH) {
              this.buffer += char;
            } else {
              // Overflow, discard until terminator
              this.state = ParserState.DISCARD_UNTIL_TERMINATOR;
              this.buffer = "";
            }
          }
          break;
        }

        case ParserState.OSC_ESCAPE: {
          if (char === "\\") {
            // 7-bit ST terminates
            this.emitAttention(this.buffer);
            this.state = ParserState.GROUND;
            this.buffer = "";
          } else {
            // Not a valid ST, malformed escape inside OSC
            this.state = ParserState.GROUND;
            this.buffer = "";
          }
          break;
        }

        case ParserState.DISCARD_UNTIL_TERMINATOR: {
          if (code === 0x07 || code === 0x9c) {
            this.state = ParserState.GROUND;
          } else if (code === 0x1b) {
            this.state = ParserState.DISCARD_ESCAPE;
          }
          break;
        }

        case ParserState.DISCARD_ESCAPE: {
          if (char === "\\") {
            this.state = ParserState.GROUND;
          } else if (char === "]") {
            // A new OSC started
            this.state = ParserState.OSC_HEADER;
            this.buffer = "";
            this.oscType = "";
          } else {
            this.state = ParserState.DISCARD_UNTIL_TERMINATOR;
          }
          break;
        }
      }
    }
  }

  private emitAttention(message: string): void {
    const now = Date.now();
    if (now - this.lastEmitTime < this.cooldownMs) {
      // Cooldown active, drop event
      return;
    }
    this.lastEmitTime = now;

    const event: AttentionEvent = {
      type: "attention",
      eventId: crypto.randomUUID(),
      sessionId: this.sessionId,
      createdAt: new Date(now).toISOString(),
      message: message.trim() || undefined
    };

    try {
      this.onAttention(event);
    } catch {
      // Listener errors must not crash parser or PTY stream
    }
  }

  reset(): void {
    this.state = ParserState.GROUND;
    this.buffer = "";
    this.oscType = "";
  }

  destroy(): void {
    this.reset();
  }
}
