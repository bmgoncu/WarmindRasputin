import { MessageQueue } from "../src/server/claude/driver.js";

/** Drains up to `n` messages, or fewer if the queue closes first. */
async function take(q: MessageQueue, n: number): Promise<string[]> {
    const out: string[] = [];
    for await (const msg of q) {
        out.push(String((msg.message as { content: unknown }).content));
        if (out.length >= n) break;
    }
    return out;
}

describe("MessageQueue", () => {
    it("delivers messages pushed before iteration starts", async () => {
        const q = new MessageQueue();
        q.push("first");
        q.push("second");
        expect(await take(q, 2)).toEqual(["first", "second"]);
    });

    it("delivers a message pushed while the consumer is waiting", async () => {
        // The normal case: the SDK is blocked on the next turn when the user speaks.
        const q = new MessageQueue();
        const pending = take(q, 1);
        setTimeout(() => q.push("late arrival"), 10);
        expect(await pending).toEqual(["late arrival"]);
    });

    it("preserves order across both paths", async () => {
        const q = new MessageQueue();
        q.push("one");
        const pending = take(q, 3);
        q.push("two");
        setTimeout(() => q.push("three"), 5);
        expect(await pending).toEqual(["one", "two", "three"]);
    });

    it("ends the iterator on close, rather than hanging forever", async () => {
        // If close did not resolve the waiting promise, the SDK's own loop would never terminate
        // and the process would not exit.
        const q = new MessageQueue();
        const collected: string[] = [];
        const done = (async () => {
            for await (const m of q) collected.push(String((m.message as { content: unknown }).content));
        })();
        q.push("only");
        setTimeout(() => q.close(), 10);
        await done;
        expect(collected).toEqual(["only"]);
    });

    it("drops pushes after close instead of throwing", async () => {
        const q = new MessageQueue();
        q.close();
        expect(() => q.push("ignored")).not.toThrow();
    });

    it("shapes messages as SDK user messages", async () => {
        const q = new MessageQueue();
        q.push("hello");
        for await (const m of q) {
            expect(m.type).toBe("user");
            expect(m.message.role).toBe("user");
            expect(m.parent_tool_use_id).toBeNull();
            break;
        }
    });
});
