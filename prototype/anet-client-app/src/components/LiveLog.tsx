import { useEffect, useState } from "react";
import { captureTmux } from "../api";
import { useAuth } from "../auth";

const POLL_MS = 3000;

export function LiveLog({ alias }: { alias: string }) {
  const utok = useAuth((s) => s.utok);
  const [output, setOutput] = useState<string>("(loading…)");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!utok) return;
    let cancelled = false;
    let timer: number | undefined;

    async function tick() {
      const resp = await captureTmux(utok!, alias);
      if (cancelled) return;
      if (resp.ok && typeof resp.output === "string") {
        setOutput(resp.output);
        setErr(null);
      } else {
        setErr(
          resp.error
            ? `Live log unavailable: ${resp.error}`
            : "Live log unavailable (admin: enable COMMHUB_ENABLE_TMUX=1 on the hub)."
        );
      }
      if (!cancelled) timer = window.setTimeout(tick, POLL_MS);
    }

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [utok, alias]);

  if (err) return <div className="muted live-log">{err}</div>;
  return <pre className="live-log">{output}</pre>;
}
