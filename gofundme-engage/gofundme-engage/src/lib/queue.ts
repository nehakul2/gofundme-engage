export interface Message {
  id: string; // the outbox event id; consumers dedupe on it
  group: string; // ordering lane (the fundraiser id)
  type: string;
  payload: Record<string, any>;
}

export interface Queue {
  publish(m: Message): void;
}

// In-process stand-in for SQS FIFO. Messages in one group stay in order;
// different groups are processed in parallel. Swap for an SQS adapter in production.
export class LocalQueue implements Queue {
  private groups = new Map<string, Message[]>();

  publish(m: Message): void {
    const lane = this.groups.get(m.group) ?? [];
    lane.push(m);
    this.groups.set(m.group, lane);
  }

  // Processes everything queued so far; returns how many messages were handled.
  async drain(handler: (m: Message) => Promise<void>): Promise<number> {
    let count = 0;
    while (this.groups.size) {
      const lanes = [...this.groups.values()];
      this.groups.clear();
      await Promise.all(
        lanes.map(async (lane) => {
          for (const m of lane) {
            await handler(m);
            count++;
          }
        }),
      );
    }
    return count;
  }
}
