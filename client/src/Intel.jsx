import { useState, useRef, useEffect } from "react";
import "./index.css";

export function Intel({ identity, stealthLock, apiPost }) {
    const [input, setInput] = useState("");
    const [messages, setMessages] = useState([
        { id: "init", from: "ai", text: "CEREBRO ONLINE. Awaiting query..." }
    ]);
    const [busy, setBusy] = useState(false);
    const scrollRef = useRef(null);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    async function send() {
        if (!input.trim() || busy) return;
        const text = input.trim();
        setInput("");
        setMessages((prev) => [...prev, { id: Date.now(), from: "me", text }]);
        setBusy(true);

        try {
            const res = await apiPost("/api/gemini/chat", { message: text });
            if (res && res.text) {
                setMessages((prev) => [...prev, { id: Date.now() + 1, from: "ai", text: res.text }]);
            } else {
                throw new Error("No signal");
            }
        } catch (e) {
            setMessages((prev) => [...prev, { id: Date.now() + 1, from: "ai", text: "SIGNAL LOSS. " + (e.message || "Unknown error") }]);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="panel tabPanel intelPanel">
            <div className="panelHeader">
                <div className="panelTitle">CEREBRO AI</div>
                <div className="panelHint">Advanced intelligence grid. Ask about survival tactics, threats, or lore.</div>
            </div>

            <div className="intelDisplay" ref={scrollRef}>
                {messages.map((m) => (
                    <div key={m.id} className={`intelMsg ${m.from === "ai" ? "intelAi" : "intelMe"}`}>
                        <div className="intelLabel">{m.from === "ai" ? "CEREBRO" : identity.name}</div>
                        <div className="intelText">{m.text}</div>
                    </div>
                ))}
                {busy ? (
                    <div className="intelMsg intelAi">
                        <div className="intelLabel">CEREBRO</div>
                        <div className="intelText">PROCESSING...</div>
                    </div>
                ) : null}
            </div>

            <div className="composer">
                <input
                    className="input"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Query the Upside Down..."
                    onKeyDown={(e) => e.key === "Enter" && send()}
                    disabled={stealthLock || busy}
                    autoFocus
                />
                <button className="button" onClick={send} disabled={stealthLock || busy}>
                    Query
                </button>
            </div>
        </section>
    );
}
